# Installation sur un VPS

Tout Rydar Drive tourne sur **un VPS** (site, worker, HTTPS) + **un projet Supabase** (base de données, comptes, temps réel, documents). Le VPS ne garde aucune donnée métier : il peut être remplacé à tout moment.

Serveur conseillé : Ubuntu **24.04 ou 26.04 LTS**, 2 vCPU ou plus, **4 à 8 Go de RAM**, datacenter en France.

```
Internet ──► Caddy (HTTPS auto) ──► web (Next.js)  ──► Supabase (Postgres, Auth, Realtime, Storage)
                                    worker (dispatch toutes les 2 s, notifications push) ──┘
                                    redis (anti brute force)
```

## Le plus simple : installation par Claude Code

Claude Code, lancé sur le VPS, fait l'installation et vous guide pour le reste. Connectez-vous en SSH (`ssh root@IP_DU_VPS`), puis :

```bash
apt-get update && apt-get install -y git tmux curl
git clone https://github.com/blacgoku991/Rydar-Drive.git /opt/rydar
curl -fsSL https://claude.ai/install.sh | bash && export PATH="$HOME/.local/bin:$PATH"
tmux new -s claude                  # session qui reste ouverte après la déconnexion SSH
cd /opt/rydar
claude                              # 1re fois : connexion à votre compte Claude, puis /exit
claude remote-control               # la session apparaît dans l'app Claude (Code)
```

Dans l'app Claude, ouvrez cette session et écrivez : « Suis deploy/CLAUDE-VPS.md pour mettre Rydar Drive en ligne sur mon domaine ». Les clés et mots de passe ne passent jamais par le chat : vous les tapez dans un second terminal SSH, avec `sudo bash /opt/rydar/deploy/configure.sh`.

Pour quitter le terminal sans arrêter Claude : `Ctrl+B` puis `D`. Pour y revenir : `tmux attach -t claude`.

Les étapes ci-dessous détaillent l'installation manuelle ; Claude suit les mêmes.

## 1. Nom de domaine

Chez votre registraire, dans la zone DNS du domaine :

1. **Supprimez** les enregistrements déjà présents sur `@` et `www` (A, **AAAA**, CNAME de la page de parking du registraire) : une ancienne adresse IPv6 suffit à bloquer le certificat HTTPS.
2. Créez trois enregistrements **A** vers l'adresse IP du VPS :

| Nom | Type | Valeur |
| --- | --- | --- |
| `@` | A | IP du VPS |
| `www` | A | IP du VPS |
| `*` | A | IP du VPS (mini-sites `{centrale}.votre-domaine`) |

La propagation prend de quelques minutes à quelques heures. `install.sh` vous prévient tant que le domaine ne pointe pas vers le serveur ; le certificat HTTPS arrive tout seul dès que c'est le cas.

## 2. Supabase

1. Sur [supabase.com](https://supabase.com), créez un projet :
   - **région Europe** (Paris de préférence), plan Pro conseillé en production (sauvegardes quotidiennes) ;
   - mot de passe de la base : généré par Supabase, à conserver dans un gestionnaire de mots de passe ;
   - gardez l'API de données (*Data API*) activée, sur le schéma `public`.
2. Notez :
   - l'URL du projet (`https://xxxx.supabase.co`) et les deux clés d'API, dans *Project Settings → API Keys* : la clé **publishable** (`sb_publishable_…`, ou `anon` dans l'onglet *Legacy*) et la clé **secret** (`sb_secret_…`, ou `service_role`) ;
   - *Connect → Session pooler* : chaîne de connexion **port 5432** (l'assistant `configure.sh` y insère le mot de passe et ajoute `?sslmode=no-verify`).
3. *Authentication → Sign In / Providers* : désactivez *Allow new users to sign up*. *URL Configuration* : Site URL `https://votre-domaine`, Redirect URLs `https://votre-domaine/auth/callback` et `https://votre-domaine/auth/set-password`. Configurez un SMTP (invitations par e-mail).
4. *Realtime → Settings* : désactivez *Allow public access*. Rydar n'utilise que des canaux privés, réservés par des règles d'accès à la bonne centrale ou au bon chauffeur.

Les tables, droits et fonctions sont installés par le script du VPS (étape 3).

## 3. VPS

Connectez-vous en SSH (`ssh root@IP_DU_VPS`), puis :

```bash
apt-get update -qq && apt-get install -y -qq git
git clone https://github.com/blacgoku991/Rydar-Drive.git /opt/rydar
cd /opt/rydar
sudo bash deploy/install.sh      # Docker, pare-feu, questions de configuration, migrations, construction, démarrage
```

Au premier passage, `install.sh` pose les questions de configuration : domaine, e-mail, URL et clés Supabase, chaîne de connexion et mot de passe de la base. Les clés se collent sans s'afficher, et chaque valeur est vérifiée auprès de Supabase. Pour les modifier plus tard : `sudo bash deploy/configure.sh`. La construction prend 5 à 10 minutes la première fois.

Dépôt GitHub privé : ajoutez d'abord une clé de déploiement en lecture seule, puis clonez en SSH.

```bash
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub      # → GitHub : dépôt → Settings → Deploy keys → Add deploy key
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null
git clone git@github.com:blacgoku991/Rydar-Drive.git /opt/rydar
```

Le site répond sur `https://votre-domaine` (certificat HTTPS automatique) et `https://votre-domaine/api/health` renvoie `{"ok":true}`.

Le pare-feu n'ouvre que SSH (y compris un port SSH personnalisé), HTTP et HTTPS. Chaque migration de la base est appliquée en une seule transaction : si l'une échoue, elle est annulée entièrement et il suffit de relancer `install.sh` après correction.

## 4. Premier compte Super Admin

1. Dans le terminal du VPS : `sudo bash /opt/rydar/deploy/create-admin.sh` (e-mail, nom, mot de passe saisi sans affichage).
2. Ou, à la main : Supabase → *Authentication → Users → Add user* (*Auto confirm*), puis dans le *SQL Editor* : `update public.users set is_super_admin = true where email = 'vous@exemple.fr';`
3. Connectez-vous sur `https://votre-domaine/login` : menu Super Admin → créez vos centrales (option 1 Flotte ou option 2 Centrale à commission) et donnez les accès.

Ne chargez **jamais** `supabase/seed.sql` en production : ce sont les comptes de démonstration.

## 5. Paiements et notifications

- **Stripe** (abonnements) : clés dans `deploy/.env` ; webhook `https://votre-domaine/api/stripe/webhook`.
- **Notifications push** : `EXPO_ACCESS_TOKEN` (expo.dev → Access tokens), ou FCM / APNs en direct.
- **App chauffeur** : builds EAS avec `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` et `EXPO_PUBLIC_API_URL=https://votre-domaine` (voir `docs/DEPLOYMENT.md`, section 5).

## 6. Au quotidien

```bash
cd /opt/rydar
git pull && sudo bash deploy/install.sh                 # mise à jour (migrations comprises)
cd deploy && docker compose ps                          # état des services
docker compose logs -f --tail 100 web worker            # journaux
docker compose restart worker                           # redémarrer un service
sudo bash /opt/rydar/deploy/configure.sh                # changer une clé, puis relancer install.sh
```

- **Sauvegardes** : la base est chez Supabase (sauvegardes du plan Pro). Sur le VPS, seul `deploy/.env` est à conserver précieusement.
- **Itinéraires** : par défaut, serveur de démo OSRM (limité). Pour votre propre serveur (gratuit, rapide) : `bash deploy/osrm-prepare.sh` puis `OSRM_URL=http://osrm:5000` dans `deploy/.env` et `docker compose --profile osrm up -d`.
- **Plusieurs sites sur le même VPS** : Caddy occupe les ports 80 et 443. Si un autre site (nginx…) les utilise déjà, faites passer Rydar derrière lui (proxy vers le conteneur `web`, port 3000) ou utilisez un VPS dédié.
