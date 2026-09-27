# Connexion de psql (client PostgreSQL lancé dans un conteneur) à la base Supabase, partagée par migrate.sh et
# configure.sh. Fichier chargé par « . deploy/pg-url.sh » (ROOT défini avant), pas un script à lancer.
#
# Chiffrement : DATABASE_SSLMODE (deploy/.env), comme le worker (deploy/docker-compose.yml) :
#   verify-full (défaut) : certificat du serveur vérifié avec la racine publique Supabase deploy/supabase-ca.crt ;
#   no-verify : ancien mode, chiffré SANS vérification (repli seulement, docs/DEPLOYMENT.md).
# Secret : le mot de passe ne passe jamais dans une ligne de commande (visible par « ps ») : PGPASSWORD, lu par
# psql dans son environnement, et PGURL sans mot de passe, transmis à docker par « -e PGURL -e PGPASSWORD »
# (valeurs reprises de l'environnement) ou par un fichier --env-file.

PG_CA_HOST="$ROOT/deploy/supabase-ca.crt"
PG_CA_CONTAINER=/etc/rydar/supabase-ca.crt

# pg_prepare URL [MODE] → exporte PGURL et PGPASSWORD (décodé ; absent si la chaîne n'en a pas) ; PG_MOUNT = montage
# de la racine dans le conteneur (tableau, vide en no-verify)
pg_prepare() {
  local url="$1" mode="${2:-verify-full}" ssl base query="" scheme rest userinfo pass="" params="" p
  local -a parts=()
  case "$mode" in
    verify-full)
      [ -f "$PG_CA_HOST" ] || { echo "✗ $PG_CA_HOST introuvable (racine Supabase, voir docs/DEPLOYMENT.md)" >&2; return 1; }
      ssl="sslmode=verify-full&sslrootcert=$PG_CA_CONTAINER"
      PG_MOUNT=(-v "$PG_CA_HOST:$PG_CA_CONTAINER:ro")
      ;;
    # libpq ne connaît pas « no-verify » (option du pilote Node) : chiffrement sans vérification = require
    no-verify)
      ssl="sslmode=require"
      PG_MOUNT=()
      ;;
    *) echo "✗ DATABASE_SSLMODE invalide : « $mode » (verify-full ou no-verify)" >&2; return 1 ;;
  esac
  base="${url%%\?*}"
  [[ "$url" != *\?* ]] || query="${url#*\?}"
  IFS='&' read -r -a parts <<<"$query"
  for p in "${parts[@]}"; do
    case "$p" in "" | sslmode=* | sslrootcert=*) ;; *) params+="${params:+&}$p" ;; esac
  done
  params+="${params:+&}$ssl"
  scheme="${base%%://*}"
  rest="${base#*://}"
  if [[ "$rest" == *@* ]]; then
    userinfo="${rest%@*}"
    [[ "$userinfo" != *:* ]] || pass="${userinfo#*:}"
    base="$scheme://${userinfo%%:*}@${rest##*@}"
  fi
  PGURL="$base?$params"
  export PGURL
  if [ -n "$pass" ]; then
    # Décodage %XX (la chaîne porte le mot de passe encodé) ; une barre oblique inverse reste littérale
    pass="${pass//\\/\\\\}"
    printf -v PGPASSWORD '%b' "${pass//%/\\x}"
    export PGPASSWORD
  else
    unset PGPASSWORD
  fi
}

# pg_tls_error FICHIER : vrai si l'erreur vient de la vérification du certificat (ou de la racine absente)
pg_tls_error() {
  grep -qiE 'certificate|SSL error|root cert|supabase-ca' "$1" 2>/dev/null
}
