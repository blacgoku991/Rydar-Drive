# Audit de sécurité et de fonctionnement (septembre 2026)

Audit complet du code (web, API, base de données, app chauffeur, worker, déploiement, textes légaux), puis correction de
tout ce qui a été confirmé. Règle suivie : **aucun constat n'est corrigé sans avoir été reproduit**. Chaque correctif a
un test qui échoue sans lui et passe avec lui.

## Méthode

| Étape | Qui | Résultat |
|---|---|---|
| 1. Audit | 21 auditeurs, un par domaine (auth web, API chauffeur, API publique, actions du tableau de bord et du super admin, webhooks, RLS, fonctions SQL courses et argent, temps réel et stockage, front, app, worker et déploiement, flux course / argent / comptes / annexes, code inutile, robustesse web et app, textes) | 170 constats, chacun avec scénario et preuve |
| 2. Contre-expertise | 16 vérificateurs chargés de RÉFUTER chaque constat (exécution SQL réelle comme l'utilisateur concerné, vrai serveur d'authentification GoTrue, navigateur Chromium, scripts) | 0 réfuté ; doublons fusionnés et gravités corrigées → **129 défauts distincts : 7 hauts, 31 moyens, 91 bas** |
| 3. Correction | 11 correcteurs en copies isolées du dépôt, fonctions SQL et fichiers attribués sans chevauchement, puis deux vagues de finition | Migrations `20260924004300` à `005300`, un test par correctif |
| 4. Contre-audit | 6 relecteurs indépendants sur l'ensemble des corrections | 32 points résiduels (4 moyens, 28 bas) : 3 déjà corrigés par les finitions, 29 corrigés au tour 2 (migrations `005400` à `005600`), chacun reproduit d'abord |
| 5. Bout en bout | Pile complète locale (PostgreSQL, GoTrue, PostgREST, temps réel, web de production, worker) + Chromium | 9 parcours OK, isolation entre centrales vérifiée (354 contrôles) ; 9 défauts d'ergonomie (bandeau cookies, 404, panne de la base, aperçu du mini-site, date lointaine, e-mail d'invitation, repère `<main>` et lien d'évitement, titre de la page En direct) corrigés ; test de fumée final sur le code corrigé : OK |

La base ne laissait lire directement aucune donnée d'une autre centrale (RLS sur toutes les tables, vérifiée table par
table). Les défauts qui touchaient une autre centrale passaient par des actions (rattachement d'un compte existant,
domaine personnalisé, signalement plateforme) : ils sont corrigés ci-dessous.

## Les 7 défauts de gravité haute (tous corrigés)

1. **Compte pré-créé puis promu gérant.** L'inscription par lien créait un compte confirmé pour n'importe quelle adresse ;
   la création de centrale, l'ajout d'un membre et `create-admin.sh` réutilisaient ensuite ce compte, dont un tiers
   connaissait le mot de passe. → Un compte existant n'est plus jamais rattaché directement : adhésion « invitée »,
   activée seulement par le lien reçu par e-mail ; un jeton émis avant l'activation n'ouvre rien (004700, 005300).
2. **Compte chauffeur qui gère aussi une autre centrale.** Sa centrale de chauffeur pouvait changer son mot de passe ou le
   bannir au niveau de la connexion. → Compte partagé intouchable par la centrale du chauffeur (004700).
3. **Domaine personnalisé.** La vérification DNS n'était pas atomique : une centrale pouvait capter le sous-domaine d'une
   autre. → Vérification atomique, sous-domaine Rydar prioritaire, unicité des seuls domaines vérifiés (005000).
4. **« J'ai payé » en boucle.** Un chauffeur contesté (« Pas reçu ») pouvait redéclarer sans fin pour ne jamais être
   bloqué. → Après une contestation, seul « Reçu » ou « Annuler » débloque ; un paiement déclaré compte dans le plafond
   après 72 h (004400).
5. **API v1 refusée aux centrales « sans offre ».** → Même règle que la base : sans offre = tout autorisé.
6. **Heure de réservation lue dans le fuseau du navigateur** (mini-site et « Nouvelle course »). → Heure de la centrale.
7. **Bannissement plateforme détourné.** Une centrale pouvait recopier l'identité du chauffeur d'une autre centrale dans son
   signalement. → Le super admin voit les fiches concernées et coche chacune (non cochées par défaut) (004600).

## Défauts moyens (31, tous corrigés)

- **Accès et rôles** : dispatcher qui activait ou suspendait un chauffeur par écriture directe ; invitation qui rattachait
  un autre compte (joker `_` dans la recherche d'e-mail) ; modification d'un membre sans validation ; suspension d'une
  centrale qui verrouillait les comptes de membres d'autres centrales ; bannissement plateforme qui verrouillait le compte
  de gestion d'une autre centrale ; redirection externe après connexion (`?next=/\hôte`).
- **Argent** : blocage des frais plateforme suspendu indéfiniment (retrait puis redéclaration) ; frais perdus au passage
  flotte → centrale ; dette effacée par la suppression du compte puis réinscription ; bannissement contourné par un
  téléphone écrit « +33 (0)6… ».
- **Courses** : double course instantanée pour un même chauffeur (acceptations simultanées) ; course attribuée pendant une
  autre invisible dans l'app ; chauffeur suspendu avec des courses orphelines ; vol retardé → « Aucun chauffeur » des heures
  avant la prise en charge ; course démarrée hors ligne sans suivi GPS.
- **Mini-site et API** : fausses réservations anonymes en masse ; prix calculé sur des coordonnées fournies par le client ;
  aucun budget global des fournisseurs géo payants ; clé « navigateur » qui pouvait lire les courses ; journal API
  saturable ; cache des hôtes du proxy sans limite (mémoire du serveur).
- **App chauffeur** : déconnexion hors réseau ratée ; écrans bloqués sur « Chargement… » ; accueil empilé à chaque course.
- **Robustesse web** : aucune page d'erreur, premier clic après un déploiement qui cassait la page.
- **RGPD** : journal de connexions Supabase jamais purgé ; justificatif « Visite médicale » (donnée de santé) proposé alors
  que les textes l'interdisent (retiré des dépôts).

Les 91 défauts bas (libellés, cas limites, code inutile, documentation…) sont corrigés, sauf ceux listés ci-dessous.

## Tour 2 (contre-audit) : ce qui a changé en plus

- **Jetons antérieurs** : un jeton émis avant l'activation d'une invitation (même dans la même seconde) ou avant une
  promotion Super Admin par `create-admin.sh` n'a pas les droits (`private.jwt_issued_after`, `users.super_admin_since`,
  RPC `session_is_super_admin` pour `requireSuperAdmin`).
- **Comptes** : une adhésion seulement « invitée » ne protège plus un compte (suppression, bannissement plateforme) ;
  suspendre une centrale ne ferme que les sessions de ses membres actifs ; « J'ai payé » et le relevé visent la centrale
  affichée ; seul le propriétaire annule l'invitation d'un propriétaire ; outil super admin « Débloquer la connexion ».
- **Limites** : connexion web et chauffeur, code « mot de passe oublié » et suppression de compte comptent par couple
  (adresse, IP /64) avec un plafond global plus haut : un tiers ne bloque plus le titulaire d'une adresse.
- **API et mini-site** : clé d'idempotence rejouée par une autre clé → 409, jamais la course d'une autre intégration ;
  limite par IP réservée aux requêtes non authentifiées ; budget géo payant partagé en sous-plafonds (IP, mini-site,
  centrale, utilisateur) ; domaine personnalisé soumis au droit de l'offre ; un ancien abonnement Stripe ne rétrograde
  plus un abonnement en cours ; un sous-domaine réservé déjà pris n'empêche plus d'enregistrer les autres réglages.
- **Courses** : verrou d'acceptation sans interblocage avec le dispatch ; une course sans prix n'est ni acceptée ni
  annoncée acceptable pour un nouveau chauffeur sous plafond ; le suivi des vols ne relance plus une course d'une
  centrale bloquée (frais en retard, quota).
- **Bannissements** : les empreintes de téléphone calculées avec l'ancienne écriture restent effectives.
- **App chauffeur** : planning d'un gérant qui roule, montant dû affiché avant la suppression même compte suspendu,
  mise hors ligne retentée tant que les CGU ne sont pas acceptées.
- **Web** : page 404 en français, bandeau cookies qui ne masque plus « Se déconnecter ».

## Non corrigés dans le code (décision ou réglage)

- **Existence d'un compte révélée par l'inscription par lien** (« adresse déjà liée à un compte ») : la supprimer demande
  de vérifier l'adresse par un code e-mail avant de créer le compte (changement du parcours d'inscription). Piste notée.
- **Devinage des codes e-mail** : Supabase Auth ne compte pas les essais par code ; la parade est un réglage : **code à
  8 chiffres** (docs/DEPLOYMENT.md § 1).
- **Fichiers de justificatifs remplacés** : la ligne est supprimée mais le fichier reste dans le stockage ; une purge par
  le worker est à ajouter.
- **Carte VTC obligatoire à l'inscription** : décision produit (renforcerait l'anti-fraude).

## À vérifier en production après la mise à jour

1. Supabase › Authentication : *Email OTP Length* = 8 (validité laissée à 3600 s).
2. Connexion à la base en `verify-full` : `migrate.sh` s'arrête avec un message clair si le certificat n'est pas reconnu ;
   repli `DATABASE_SSLMODE=no-verify` proposé par `configure.sh`.
3. Purge du journal Auth : la réponse du ménage contient `auth_audit_purged` (0 en permanence alors que la table a des
   lignes de plus d'un an = droit manquant, voir DEPLOYMENT.md).
4. Données héritées : sous-domaines réservés déjà pris, domaine personnalisé sous le domaine racine, fiches suspendues
   « vérification requise » par le recalcul des empreintes de téléphone (requêtes dans DEPLOYMENT.md, section « Après la
   mise à jour de l'audit »).
5. `EXPO_ACCESS_TOKEN` renseigné (sécurité des notifications push).
