# Mise en production — consignes pour Claude sur le VPS

Tu tournes sur le **serveur de production** (Ubuntu, dossier `/opt/rydar`), piloté à distance depuis l'app Claude par le propriétaire du projet. Il n'est pas développeur : parle en français, simplement, une étape à la fois, et dis-lui exactement quoi cliquer ou taper.

**But** : Rydar Drive en ligne sur `https://DOMAINE` (site, dashboard des centrales, super admin, API), mini-sites sur `https://{centrale}.DOMAINE`, worker (dispatch, notifications). Base de données, comptes, temps réel et documents chez **Supabase** (cloud, Europe). Aucune donnée de démonstration.

## Règles

1. **Secrets** (clés Supabase, mot de passe de la base, SMTP, jetons) : jamais dans le chat. Le propriétaire les saisit lui-même dans un terminal SSH (une 2ᵉ connexion `ssh root@IP`) avec `sudo bash /opt/rydar/deploy/configure.sh` : saisie masquée, chaque valeur est vérifiée en direct. S'il en colle un dans le chat quand même : ne le répète pas, et conseille-lui de le régénérer à la fin.
2. **N'affiche jamais** `deploy/.env` ni une valeur secrète : pas de `cat deploy/.env`, pas de `docker compose config` brut, pas d'`env` dans un conteneur. Pour vérifier qu'une variable est remplie : `grep -c '^NOM=.' deploy/.env`.
3. **Jamais `supabase/seed.sql`** en production : ce sont des comptes de démonstration aux mots de passe publics.
4. **Pas de modification du code** sur le serveur, pas de commit : le code vient de GitHub (`git pull`). Si un correctif est nécessaire, rédige pour le propriétaire un résumé précis (fichier, erreur, extrait de journal, sans secret) à transmettre à la session de développement, puis `git pull && sudo bash deploy/install.sh` une fois le correctif publié.
5. **Pare-feu** : ne retire jamais l'accès SSH. Avant toute action risquée (suppression, autre site sur la machine, modification DNS), demande.
6. Explique chaque commande en une phrase avant de la lancer : le propriétaire la valide dans l'app.

## Utilisateur non root (ex. `ubuntu` chez OVH)

Vérifie `id -un` et `sudo -n true && echo sudo-ok`. Si tu n'es pas root :

- préfixe par `sudo` : `install.sh`, `configure.sh`, `create-admin.sh`, `migrate.sh`, `docker compose …`, `apt-get`, `ufw` (`deploy/.env` n'est lisible que par root, et Docker demande root) ;
- `git pull` sans `sudo` : le dépôt appartient à l'utilisateur (sinon `sudo chown -R "$USER": /opt/rydar`) ;
- si `sudo` demande un mot de passe, tu ne peux pas le saisir : donne au propriétaire la commande exacte à taper dans son terminal.

## Étapes

### 0. État des lieux (lecture seule)

`cd /opt/rydar && git pull`, puis `lsb_release -ds`, `free -h`, `df -h /`, `nproc`, l'IP publique (`curl -4 -s https://api.ipify.org`) et les ports web : `ss -ltnp '( sport = :80 or sport = :443 )'`. Si 80 ou 443 sont déjà pris (autre site), arrête-toi et demande. Ne te fie pas au 1er message de connexion SSH : c'est normal qu'un avertissement `xauth` apparaisse.

### 1. Nom de domaine

Demande le domaine et le registraire, puis donne les réglages exacts de la zone DNS :

- **supprimer** les enregistrements existants sur `@` et `www` (A, AAAA, CNAME de parking) ;
- créer `@`, `www` et `*` en type **A** vers l'IP du serveur.

Vérifie avec `getent ahostsv4 DOMAINE`, `dig +short A www.DOMAINE`, `dig +short AAAA DOMAINE` (doit être vide) et `dig +short A test.DOMAINE` (doit donner l'IP : c'est le `*`). Si `dig` manque : `apt-get install -y bind9-dnsutils`. La propagation peut prendre du temps : avance sur les étapes suivantes pendant ce temps.

### 2. Supabase (le propriétaire, dans son navigateur ; guide-le clic par clic)

- **New project** : nom `rydar`, région **Europe (Paris)**, mot de passe de la base généré par Supabase et gardé dans un gestionnaire de mots de passe, plan Pro conseillé en production (sauvegardes). Laisser l'API de données (*Data API*) activée sur le schéma `public`.
- *Authentication → Sign In / Providers* : désactiver **Allow new users to sign up**.
- *Authentication → URL Configuration* : Site URL `https://DOMAINE` ; Redirect URLs `https://DOMAINE/auth/callback` et `https://DOMAINE/auth/set-password`.
- *Authentication → Emails → SMTP Settings* : SMTP personnalisé avec sa boîte mail (hôte, port 465 ou 587, identifiant, mot de passe fournis par son hébergeur mail ; expéditeur `noreply@DOMAINE` ou `contact@DOMAINE`). Demande-lui l'hébergeur de sa boîte pour lui donner les bons réglages. Sans SMTP, les invitations par e-mail et « mot de passe oublié » ne partent pas.
- *Realtime → Settings* : désactiver **Allow public access**. Rydar n'utilise que des canaux privés.
- Il garde sous la main, sans te les envoyer : l'URL du projet, la clé **publishable**, la clé **secret** et la chaîne **Session pooler** (bouton *Connect*).

### 3. Installation

1. Toi : `sudo bash deploy/install.sh`. Le 1er passage installe Docker, le pare-feu et le swap, crée `deploy/.env` puis s'arrête (tu n'as pas de terminal pour les questions).
2. Le propriétaire, dans son terminal SSH : `sudo bash /opt/rydar/deploy/configure.sh` (domaine, e-mail, URL, deux clés, chaîne de connexion et mot de passe de la base).
3. Toi : `sudo bash deploy/install.sh`. Il applique les 27 migrations (chacune dans une transaction : un échec est annulé entièrement), construit les images (5 à 10 minutes la 1ʳᵉ fois), démarre et contrôle la santé du site.

### 4. Vérifications

- `cd /opt/rydar/deploy && sudo docker compose ps` : web, worker, redis et caddy en marche.
- `curl -fsS https://DOMAINE/api/health` renvoie `{"ok":true,…}`.
- `curl -sI https://www.DOMAINE | head -3` : redirection 301 vers `https://DOMAINE`.
- `sudo docker compose logs --tail 80 caddy | grep -i -E "certificate obtained|error"` : certificat obtenu.
- `sudo docker compose logs --tail 80 worker` : pas d'erreur en boucle.
- `sudo bash /opt/rydar/deploy/migrate.sh` : « 0 migration(s) appliquée(s) ».

### 5. Super Admin

Le propriétaire, dans son terminal : `sudo bash /opt/rydar/deploy/create-admin.sh` (e-mail, nom, mot de passe masqué). Puis connexion sur `https://DOMAINE/login`.

### 6. Premier essai, avec lui

Menu Super Admin → créer une centrale (option 1 *Flotte* ou option 2 *Centrale à commission*) → « Donner un accès ». Dans son dashboard, créer une course de test. Ouvrir le mini-site `https://{slug}.DOMAINE` : le certificat est émis à la première visite, en quelques secondes.

### 7. Ensuite (à proposer, facultatif)

- Notifications push et app chauffeur : compte Expo, jeton `EXPO_ACCESS_TOKEN` via `configure.sh`, builds EAS (voir `docs/DEPLOYMENT.md`, section 5).
- Abonnements Stripe : `docs/DEPLOYMENT.md`, section 4. Les clés vont dans `deploy/.env`, saisies par le propriétaire avec `nano`.
- Itinéraires auto-hébergés : `bash deploy/osrm-prepare.sh` (8 Go de RAM suffisent pour l'Île-de-France), puis `OSRM_URL=http://osrm:5000`.
- Dépôt GitHub en privé (il est public aujourd'hui) : il faudra alors une clé de déploiement pour `git pull` (voir `deploy/README.md`).

### 8. Compte rendu

Termine par un résumé pour le propriétaire : ce qui fonctionne (adresses), ce qui reste à faire, et comment mettre à jour.

## Pièges connus

- Supabase : le rôle `postgres` n'est pas super-utilisateur ; les migrations en tiennent compte. Une erreur « must be owner of … » est à signaler, pas à contourner.
- `DATABASE_URL` : Session pooler, **port 5432** (le worker écoute `LISTEN/NOTIFY`, impossible avec le port 6543 du mode transaction). La connexion directe `db.xxx.supabase.co` est en IPv6, injoignable depuis Docker. `?sslmode=no-verify` est obligatoire. `configure.sh` gère tout cela.
- HTTPS en échec : un enregistrement AAAA qui pointe ailleurs, ou un DNS pas encore propagé. Caddy réessaie tout seul (voir ses journaux).
- Les variables `NEXT_PUBLIC_*` sont intégrées à la construction du site : après un changement de domaine, d'URL ou de clé publishable, relancer `sudo bash deploy/install.sh`, qui reconstruit.
- Mini-sites : un certificat n'est délivré que pour une centrale existante (`/api/tls/allowed`). Un sous-domaine inconnu reste sans certificat, c'est voulu.
- Mémoire : la construction du site prend 2 à 3 Go ; `install.sh` crée 2 Go de swap.

## Au quotidien

- Mise à jour : `cd /opt/rydar && git pull && sudo bash deploy/install.sh`
- Journaux : `cd /opt/rydar/deploy && sudo docker compose logs -f --tail 100 web worker`
- Redémarrer : `sudo docker compose restart web worker`
- Changer une clé : `sudo bash deploy/configure.sh`, puis `sudo bash deploy/install.sh`
