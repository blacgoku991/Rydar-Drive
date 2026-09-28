# Mise en production — consignes pour Claude sur le VPS

Tu tournes sur le **serveur de production** (Ubuntu, dossier `/opt/rydar`), piloté à distance depuis l'app Claude par le propriétaire du projet. Il n'est pas développeur : parle en français, simplement, une étape à la fois, et dis-lui exactement quoi cliquer ou taper.

**But** : Rydar Drive en ligne sur `https://DOMAINE` (site, dashboard des centrales, super admin, API), mini-sites sur `https://{centrale}.DOMAINE`, worker (dispatch, notifications), expéditeur d'e-mails du formulaire de contact (`mailer`, par le serveur mail du VPS). Base de données, comptes, temps réel et documents chez **Supabase** (cloud, Europe). Aucune donnée de démonstration.

## Règles

1. **Secrets** (clés Supabase, mot de passe de la base, SMTP, jetons) : jamais dans le chat. Le propriétaire les saisit lui-même dans un terminal SSH (une 2ᵉ connexion `ssh root@IP`) avec `sudo bash /opt/rydar/deploy/configure.sh` : saisie masquée, chaque valeur est vérifiée en direct. S'il en colle un dans le chat quand même : ne le répète pas, et conseille-lui de le régénérer à la fin.
2. **N'affiche jamais** `deploy/.env` ni une valeur secrète : pas de `cat deploy/.env`, pas de `docker compose config` brut, pas d'`env` dans un conteneur. Pour vérifier qu'une variable est remplie : `grep -c '^NOM=.' deploy/.env`.
3. **Jamais `supabase/seed.sql`** en production : ce sont des comptes de démonstration aux mots de passe publics.
4. **Pas de modification du code** sur le serveur, pas de commit : le code vient de GitHub (`git pull`). Si un correctif est nécessaire, rédige pour le propriétaire un résumé précis (fichier, erreur, extrait de journal, sans secret) à transmettre à la session de développement, puis `git pull && sudo bash deploy/install.sh` une fois le correctif publié.
5. **Pare-feu** : ne retire jamais l'accès SSH. Avant toute action risquée (suppression, autre site sur la machine, modification DNS), demande.
6. Explique chaque commande en une phrase avant de la lancer : le propriétaire la valide dans l'app.
7. **Demande de suppression de compte reçue par e-mail** (chauffeur sans l'app, compte bloqué) : jamais en SQL ni dans le dashboard Supabase. Elle se traite par le Super Admin, dans `https://DOMAINE/admin/suppressions` : recherche par e-mail ou téléphone, suppression confirmée en tapant SUPPRIMER, suivi des suppressions en cours ou en échec (« Réessayer »). Seul cet outil applique tout le traitement promis par `/suppression-compte` (données effacées ou anonymisées, justificatifs et leurs fichiers, compte de connexion, journal d'audit). Avant d'agir, vérifier que la demande vient de l'adresse du compte (sinon, faire confirmer l'identité, par exemple par la centrale) ; confirmer ensuite au chauffeur par e-mail, sous 30 jours (`docs/STORES.md`, § 11).

## Utilisateur non root (ex. `ubuntu` chez OVH)

Vérifie `id -un` et `sudo -n true && echo sudo-ok`. Si tu n'es pas root :

- préfixe par `sudo` : `install.sh`, `configure.sh`, `create-admin.sh`, `migrate.sh`, `docker compose …`, `apt-get`, `ufw` (`deploy/.env` n'est lisible que par root, et Docker demande root) ;
- `git pull` sans `sudo` : le dépôt appartient à l'utilisateur (sinon `sudo chown -R "$USER": /opt/rydar`) ;
- si `sudo` demande un mot de passe, tu ne peux pas le saisir : donne au propriétaire la commande exacte à taper dans son terminal.

## Étapes

### 0. État des lieux (lecture seule)

`cd /opt/rydar && git pull`, puis `lsb_release -ds`, `free -h`, `df -h /`, `nproc`, l'IP publique (`curl -4 -s https://api.ipify.org`) et les ports web et mail : `sudo ss -ltnp '( sport = :80 or sport = :443 or sport = :25 )'`. Si 80 ou 443 sont déjà pris (autre site), arrête-toi et demande. Un serveur déjà présent sur le port 25 se traite à l'étape 5. Ne te fie pas au 1er message de connexion SSH : c'est normal qu'un avertissement `xauth` apparaisse.

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
- *Authentication → Emails → Templates* : traduire en français « Reset password » (mot de passe oublié des chauffeurs et des centrales) et « Invite user ». Le modèle « Reset password » doit contenir **le code `{{ .Token }}` ET le lien `{{ .ConfirmationURL }}`** : le chauffeur saisit le code dans l'application ; le lien sert aux centrales (web) et de secours au chauffeur. Garder le lien tel quel (ne pas le remplacer par un lien `token_hash`). Exemple, à coller tel quel :
  - sujet : `Rydar Drive : votre code, ou l'activation de votre accès`
  - corps (HTML) :
    ```html
    <p>Bonjour,</p>
    <p>Code à saisir dans l'application Rydar Drive :</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:6px">{{ .Token }}</p>
    <p>Vous pouvez aussi ouvrir ce lien pour choisir un nouveau mot de passe : <a href="{{ .ConfirmationURL }}">changer mon mot de passe</a>.</p>
    <p>Ce message fait suite à l'invitation d'une centrale sur Rydar Drive ? Ouvrez ce même lien et choisissez votre mot de passe : votre accès est activé aussitôt.</p>
    <p>Le code et le lien expirent dans une heure ; le premier utilisé annule l'autre. Vous n'avez rien demandé et n'attendez aucune invitation ? Ignorez ce message.</p>
    ```
  - *Authentication → Sign In / Providers → Email* : régler *Email OTP Length* à **8** chiffres (l'app accepte 6 à 10) et laisser *Email OTP Expiration* à 3600 s.
- *Realtime → Settings* : désactiver **Allow public access**. Rydar n'utilise que des canaux privés.
- Il garde sous la main, sans te les envoyer : l'URL du projet, la clé **publishable**, la clé **secret** et la chaîne **Session pooler** (bouton *Connect*).

### 3. Installation

1. Toi : `sudo bash deploy/install.sh`. Le 1er passage installe Docker, le pare-feu et le swap, crée `deploy/.env` puis s'arrête (tu n'as pas de terminal pour les questions).
2. Le propriétaire, dans son terminal SSH : `sudo bash /opt/rydar/deploy/configure.sh` (domaine, e-mail, URL, deux clés, chaîne de connexion et mot de passe de la base ; en option, l'e-mail qui reçoit les demandes de contact et l'adresse d'expédition).
3. Toi : `sudo bash deploy/install.sh`. Il applique les migrations (chacune dans une transaction : un échec est annulé entièrement), construit les images (5 à 10 minutes la 1ʳᵉ fois), démarre et contrôle la santé du site. Un avertissement « serveur mail injoignable » tant que Postfix n'est pas installé est normal : étape 5.

### 4. Vérifications

- `cd /opt/rydar/deploy && sudo docker compose ps` : web, worker, mailer, redis et caddy en marche.
- `curl -fsS https://DOMAINE/api/health` renvoie `{"ok":true,…}`.
- `curl -sI https://www.DOMAINE | head -3` : redirection 301 vers `https://DOMAINE`.
- `sudo docker compose logs --tail 80 caddy | grep -i -E "certificate obtained|error"` : certificat obtenu.
- `sudo docker compose logs --tail 80 worker` : pas d'erreur en boucle.
- `sudo docker compose logs worker | grep 'rydar worker starting' | tail -1` (dernier démarrage, aucun secret dans cette ligne) : elle contient `"accountDeletions":"on"` (le worker reçoit l'URL Supabase et la clé secret, nécessaires pour terminer les suppressions de compte). Sinon, `docker-compose.yml` n'est pas à jour : `git pull` puis `sudo bash deploy/install.sh`.
- `sudo bash /opt/rydar/deploy/migrate.sh` : « 0 migration(s) appliquée(s) ».

### 5. E-mails du formulaire de contact (serveur mail du VPS)

Les demandes du formulaire de contact (« Demander un tarif ») s'affichent dans `https://DOMAINE/admin/contacts`. Le service `mailer` envoie en plus une notification au propriétaire, un accusé de réception au demandeur et les réponses du Super Admin, par le serveur mail du VPS (`127.0.0.1:25`) : le site n'envoie rien lui-même. Sans serveur mail, rien n'est perdu : les e-mails attendent en file (8 essais sur une vingtaine d'heures) puis passent en échec, visible dans `/admin/contacts`. Les e-mails d'authentification (invitations, mot de passe oublié) ne sont pas concernés : ils partent par Supabase (étape 2, *SMTP Settings*).

1. **Serveur déjà présent ?** `sudo ss -ltnp | grep ':25 '`
   - rien : installer Postfix (point 2) ;
   - `127.0.0.1:25` tenu par `master` (Postfix) : vérifier ses réglages avec `sudo postconf -n` (point 2, sans réinstaller) ;
   - `0.0.0.0:25`, `*:25` ou un autre logiciel (exim, sendmail) : un autre service de la machine s'en sert peut-être ; demande au propriétaire avant de toucher à quoi que ce soit.
2. **Postfix** (explique-le au propriétaire : c'est le « facteur » du serveur, il n'écoute que la machine elle-même) :
   ```bash
   echo "postfix postfix/main_mailer_type select Internet Site" | sudo debconf-set-selections
   echo "postfix postfix/mailname string DOMAINE" | sudo debconf-set-selections
   sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postfix
   sudo postconf -e "myhostname = DOMAINE" "inet_interfaces = loopback-only" "inet_protocols = ipv4" \
     "mydestination = localhost" "mynetworks = 127.0.0.0/8"
   sudo systemctl restart postfix && sudo systemctl enable postfix
   ```
   - `inet_interfaces = loopback-only` : jamais joignable depuis Internet (le pare-feu n'ouvre pas le port 25, et ne doit pas l'ouvrir) ;
   - `mydestination = localhost` : **indispensable** si l'adresse qui reçoit les demandes est sur le même domaine (`contact@DOMAINE`, boîte chez l'hébergeur mail du propriétaire). Avec `DOMAINE` dans `mydestination`, Postfix croirait la boîte locale et refuserait l'e-mail (« User unknown in local recipient table ») au lieu de l'envoyer à la vraie boîte ;
   - `inet_protocols = ipv4` : envoi par l'adresse IPv4 seulement, celle du SPF et du DNS inverse ci-dessous (Gmail refuse un envoi IPv6 sans DNS inverse).
3. **Contrôles** : `sudo ss -ltnp | grep ':25 '` n'affiche que `127.0.0.1:25` ; `sudo postconf -n | grep -E '^(myhostname|inet_|mydestination|mynetworks)'` ; puis `curl -s http://127.0.0.1:8081/` affiche `"smtpReady":true` (après `cd /opt/rydar/deploy && sudo docker compose restart mailer`, ou une minute d'attente).
4. **Port 25 sortant** (certains hébergeurs le bloquent) : `nc -vz -w 5 gmail-smtp-in.l.google.com 25` (« succeeded » = ouvert ; sans `nc` : `timeout 5 bash -c '</dev/tcp/gmail-smtp-in.l.google.com/25' && echo ouvert`). Bloqué : le propriétaire demande le déblocage à son hébergeur, ou les e-mails passent par le SMTP de sa boîte mail (port 587 avec identifiant : `relayhost` de Postfix avec `/etc/postfix/sasl_passwd`, ou variables `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` du mailer, voir `docs/DEPLOYMENT.md`). Le mot de passe est saisi par le propriétaire lui-même (`sudo nano …`), jamais dans le chat.
5. **Délivrabilité** (sinon les e-mails arrivent en indésirables, ou sont refusés). Chez le registraire, en expliquant chaque enregistrement :
   - **SPF** : un seul enregistrement TXT `v=spf1 …` sur `@`. S'il en existe déjà un (boîte mail du domaine), y **ajouter** `ip4:IP_DU_VPS` (ex. `v=spf1 ip4:IP_DU_VPS include:mx.ovh.com ~all`) ; sinon le créer : `v=spf1 ip4:IP_DU_VPS ~all`. Jamais deux enregistrements SPF ;
   - **DNS inverse** (PTR) de l'IP du VPS = `DOMAINE` (même nom que `myhostname`), dans l'espace client de l'hébergeur du VPS (OVH : *IP* → *Modifier le reverse*) ;
   - **DKIM** (recommandé, Gmail et Outlook l'attendent) : OpenDKIM (`sudo apt-get install -y opendkim opendkim-tools`) ; clé de 2048 bits au sélecteur `rydar` : `sudo mkdir -p /etc/opendkim/keys/DOMAINE && sudo opendkim-genkey -b 2048 -d DOMAINE -s rydar -D /etc/opendkim/keys/DOMAINE && sudo chown -R opendkim: /etc/opendkim/keys` ; dans `/etc/opendkim.conf` : `Domain DOMAINE`, `Selector rydar`, `KeyFile /etc/opendkim/keys/DOMAINE/rydar.private`, `Socket inet:8891@localhost` (et `/etc/default/opendkim` s'il impose un autre socket) : il signe ce qui vient de 127.0.0.1 ; côté Postfix : `sudo postconf -e "smtpd_milters = inet:localhost:8891" "non_smtpd_milters = \$smtpd_milters" "milter_default_action = accept"`, puis `sudo systemctl restart opendkim postfix` ; publier le TXT `rydar._domainkey` (contenu de `rydar.txt`, dans le même dossier), puis `sudo opendkim-testkey -d DOMAINE -s rydar -vvv` (« key OK ») ;
   - **DMARC** : s'il n'existe pas, TXT `_dmarc` = `v=DMARC1; p=none; rua=mailto:E-MAIL_DU_PROPRIÉTAIRE` (observation), à passer à `p=quarantine` une fois SPF et DKIM au vert ; s'il existe, le garder.
6. **Essai** avec le propriétaire, une fois connecté en Super Admin (étape 6) : `/admin/contacts` → e-mail de test vers une boîte Gmail. Reçu hors indésirables, et « Afficher l'original » indique SPF, DKIM et DMARC `PASS`. Sinon : `sudo docker compose logs --tail 50 mailer`, `sudo tail -n 50 /var/log/mail.log` (ou `sudo journalctl -u 'postfix*' -n 50 --no-pager`) et `sudo postqueue -p` (e-mails retenus chez Postfix ; `sudo postqueue -f` pour relancer après correction).

### 6. Super Admin

Le propriétaire, dans son terminal : `sudo bash /opt/rydar/deploy/create-admin.sh` (e-mail, nom, mot de passe masqué). Puis connexion sur `https://DOMAINE/login`.

### 7. Premier essai, avec lui

Menu Super Admin → créer une centrale (option 1 *Flotte* ou option 2 *Centrale à commission*) → « Donner un accès ». Dans son dashboard, créer une course de test. Ouvrir le mini-site `https://{slug}.DOMAINE` : le certificat est émis à la première visite, en quelques secondes.

### 8. Ensuite (à proposer, facultatif)

- Notifications push et app chauffeur : compte Expo, jeton `EXPO_ACCESS_TOKEN` via `configure.sh`, builds EAS (voir `docs/DEPLOYMENT.md`, section 5).
- Abonnements Stripe : `docs/DEPLOYMENT.md`, section 4. Les clés vont dans `deploy/.env`, saisies par le propriétaire avec `nano`.
- Itinéraires auto-hébergés : `bash deploy/osrm-prepare.sh` (8 Go de RAM suffisent pour l'Île-de-France), puis `OSRM_URL=http://osrm:5000`.
- Dépôt GitHub en privé (il est public aujourd'hui) : il faudra alors une clé de déploiement pour `git pull` (voir `deploy/README.md`).

### 9. Compte rendu

Termine par un résumé pour le propriétaire : ce qui fonctionne (adresses), ce qui reste à faire, et comment mettre à jour.

## Pièges connus

- Supabase : le rôle `postgres` n'est pas super-utilisateur ; les migrations en tiennent compte. Une erreur « must be owner of … » est à signaler, pas à contourner.
- `DATABASE_URL` : Session pooler, **port 5432** (le worker écoute `LISTEN/NOTIFY`, impossible avec le port 6543 du mode transaction). La connexion directe `db.xxx.supabase.co` est en IPv6, injoignable depuis Docker. `configure.sh` gère tout cela.
- Certificat de la base : le worker et `migrate.sh` le vérifient avec `deploy/supabase-ca.crt` (`DATABASE_SSLMODE=verify-full`, défaut). Si `migrate.sh` affiche « certificat du serveur de la base NON vérifié », rien n'est modifié : suivre le contrôle de `docs/DEPLOYMENT.md` (« Connexion chiffrée à la base ») avec le propriétaire ; le repli `DATABASE_SSLMODE=no-verify` (ancien mode, sans vérification) est sa décision, jamais un réflexe.
- HTTPS en échec : un enregistrement AAAA qui pointe ailleurs, ou un DNS pas encore propagé. Caddy réessaie tout seul (voir ses journaux).
- Les variables `NEXT_PUBLIC_*` sont intégrées à la construction du site : après un changement de domaine, d'URL ou de clé publishable, relancer `sudo bash deploy/install.sh`, qui reconstruit.
- Mini-sites : un certificat n'est délivré que pour une centrale existante (`/api/tls/allowed`). Un sous-domaine inconnu reste sans certificat, c'est voulu.
- Mémoire : la construction du site prend 2 à 3 Go ; `install.sh` crée 2 Go de swap.
- E-mails du formulaire de contact : « Envoyé » dans `/admin/contacts` veut dire accepté par Postfix, pas encore remis. Un e-mail retenu (port 25 sortant bloqué, `connect to …:25: Connection timed out`) ou refusé (SPF, DKIM, DMARC, DNS inverse) se voit dans `/var/log/mail.log` et `sudo postqueue -p` (étape 5). `"smtpReady":false` sur `curl -s http://127.0.0.1:8081/` : rien n'écoute sur `127.0.0.1:25` (Postfix arrêté ou absent). Le mailer tourne sur le réseau de l'hôte (c'est ce qui lui fait joindre le Postfix du VPS) : ne publie aucun port pour lui et n'ouvre jamais le port 25 dans le pare-feu.
- `/admin/suppressions` affiche des suppressions « en retard » et le journal du worker « account deletions cannot be completed » : le worker ne reçoit pas `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`. Vérifier que `deploy/.env` a bien les deux valeurs (`sudo grep -c '^NEXT_PUBLIC_SUPABASE_URL=.' deploy/.env`, idem pour `SUPABASE_SERVICE_ROLE_KEY` : `1` attendu, sans afficher la valeur), puis `sudo bash deploy/install.sh`. En attendant, « Réessayer » sur `/admin/suppressions` termine une suppression depuis le site.

## Au quotidien

- Mise à jour : `cd /opt/rydar && git pull && sudo bash deploy/install.sh`
- Journaux : `cd /opt/rydar/deploy && sudo docker compose logs -f --tail 100 web worker mailer` (e-mails remis ou refusés par les destinataires : `sudo tail -f /var/log/mail.log`)
- Redémarrer : `sudo docker compose restart web worker mailer`
- Changer une clé : `sudo bash deploy/configure.sh`, puis `sudo bash deploy/install.sh`
