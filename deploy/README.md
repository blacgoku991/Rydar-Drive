# Installation sur un VPS

Tout Rydar Drive tourne sur **un VPS** (site, worker, HTTPS) + **un projet Supabase** (base de données, comptes, temps réel, documents). Le VPS ne garde aucune donnée métier : il peut être remplacé à tout moment.

Serveur conseillé : Ubuntu **24.04 ou 26.04 LTS**, 2 vCPU ou plus, **4 à 8 Go de RAM**, datacenter en France.

```
Internet ──► Caddy (HTTPS auto) ──► web (Next.js)  ──► Supabase (Postgres, Auth, Realtime, Storage)
                                    worker (dispatch toutes les 2 s, notifications push) ──┘
                                    redis (anti brute force)
```

## 1. Nom de domaine

Chez votre registraire, créez trois enregistrements **A** vers l'adresse IP du VPS :

| Nom | Type | Valeur |
| --- | --- | --- |
| `@` | A | IP du VPS |
| `www` | A | IP du VPS |
| `*` | A | IP du VPS (mini-sites `{centrale}.votre-domaine`) |

## 2. Supabase

1. Sur [supabase.com](https://supabase.com), créez un projet, **région Europe** (Paris ou Francfort), plan Pro conseillé en production (sauvegardes quotidiennes).
2. Notez :
   - *Project Settings → API* : URL du projet, clé `anon`, clé `service_role` ;
   - *Connect → Session pooler* : chaîne de connexion **port 5432**, à terminer par `?sslmode=no-verify`.
3. *Authentication → Sign In / Providers* : désactivez *Allow new users to sign up*. *URL Configuration* : Site URL `https://votre-domaine`, Redirect URLs `https://votre-domaine/auth/callback` et `https://votre-domaine/auth/set-password`. Configurez un SMTP (invitations par e-mail).

Les tables, droits et fonctions sont installés par le script du VPS (étape 3).

## 3. VPS

Connectez-vous en SSH (`ssh root@IP_DU_VPS`), puis :

```bash
# Accès au dépôt GitHub (s'il est privé) : clé de déploiement en lecture seule
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
#   → GitHub : dépôt → Settings → Deploy keys → Add deploy key (lecture seule)

git clone git@github.com:blacgoku991/Rydar-Drive.git /opt/rydar
cd /opt/rydar

sudo bash deploy/install.sh      # 1er passage : Docker, pare-feu, crée deploy/.env
nano deploy/.env                 # domaine, e-mail, clés Supabase, DATABASE_URL…
sudo bash deploy/install.sh      # migrations, construction, démarrage (5 à 10 min la 1re fois)
```

Le site répond sur `https://votre-domaine` (certificat HTTPS automatique) et `https://votre-domaine/api/health` renvoie `{"ok":true}`.

## 4. Premier compte Super Admin

1. Supabase → *Authentication → Users → Add user* : votre e-mail + mot de passe, *Auto confirm*.
2. Supabase → *SQL Editor* :

   ```sql
   update public.users set is_super_admin = true where email = 'vous@exemple.fr';
   ```

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
```

- **Sauvegardes** : la base est chez Supabase (sauvegardes du plan Pro). Sur le VPS, seul `deploy/.env` est à conserver précieusement.
- **Itinéraires** : par défaut, serveur de démo OSRM (limité). Pour votre propre serveur (gratuit, rapide) : `bash deploy/osrm-prepare.sh` puis `OSRM_URL=http://osrm:5000` dans `deploy/.env` et `docker compose --profile osrm up -d`.
- **Plusieurs sites sur le même VPS** : Caddy occupe les ports 80 et 443. Si un autre site (nginx…) les utilise déjà, faites passer Rydar derrière lui (proxy vers le conteneur `web`, port 3000) ou utilisez un VPS dédié.
