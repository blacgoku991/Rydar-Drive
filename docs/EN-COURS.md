# Travail en cours (27/09/2026)

Branche `claude/confident-clarke-rpfwmo`. Le lot « conformité, stores, accueil 3D » est TERMINÉ et vérifié :

| Contrôle | Résultat |
|---|---|
| typecheck | OK |
| Tests unitaires | 144 |
| Tests DB | 308 |
| Build web de production | OK |
| Build worker | OK |
| export Android | OK |
| iOS `UIBackgroundModes` | `['location']` |
| Pages publiques (production, 1440 px et 390 px) | aucune erreur console |

## Fait dans ce lot
- **Légal**
  - Pages `/mentions-legales`, `/cgu`, `/cgv`, `/cookies`, `/dpa` et `/confidentialite` (tous publics).
  - `/admin/legal` : identité de l'éditeur (`platform_legal`).
  - Acceptations enregistrées dans `legal_acceptances` (idempotent) :
    - bandeau owner/admin : CGV, DPA, CGU et politique de confidentialité ;
    - bandeau pour tous les membres : CGU et politique de confidentialité ;
    - écran dans l'app chauffeur (`terms-gate`) ;
    - inscription par lien.
  - Bandeau cookies (information seulement) et champ `organizations.vtc_registration`.
  - Migration 003900, tests `tests/db/legal.test.ts`.
- **Suppression de compte** (migration 004000)
  - Anonymisation vérifiée par un balayage de toute la base.
  - Suppression des fichiers justificatifs.
  - File `private.account_deletions`, reprise par le worker toutes les 5 min.
  - Outil `/admin/suppressions`.
  - Fiche supprimée figée en base (`DRIVER_DELETED`).
  - Suppression possible par e-mail + mot de passe pour un compte bloqué.
- **Messagerie Chauffeurs** (migration 004100)
  - Règles à accepter avant la première publication.
  - Dans l'app : signaler ou masquer un message par appui long.
  - Dans le tableau de bord : suppression et classement des signalements.
- **Registre des frais protégé** (migration 004200)
  - `on delete restrict` : une centrale qui a des frais s'archive, elle ne se supprime pas.
  - Helpers WhatsApp en `security invoker`.
  - `svc_platform_dismiss_report` vérifie l'acteur.
- **App chauffeur**
  - Une seule porte pour l'autorisation de position (`requestLocationPermissions`, précédée de l'information préalable).
  - Bouton « Ouvrir les réglages » si l'autorisation est refusée définitivement.
  - Plugin `plugins/with-background-modes.js`.
- **Accueil** : globe three.js chargé à la demande, avec repli radar. Sections services, avantages, fonctionnement, tarifs et FAQ. Image OG.

## À faire par l'utilisateur
- Mettre à jour le VPS : `cd /opt/rydar && bash deploy/update-production.sh`. Cette mise à jour applique les migrations 003600 à 004200. Le worker a besoin de `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY`, déjà prévus dans `docker-compose`.
- Remplir `/admin/legal`, puis faire relire les textes par un juriste.
- Publier sur les stores : `docs/STORES.md`.

## Pistes plus tard
- Code e-mail à l'inscription par lien (OTP GoTrue).
- Frais plateforme : minimum, relances par e-mail.
- Webhook WhatsApp (statut de remise).
- Empreintes d'identité en HMAC (secret serveur).
- `invoices` encore en cascade à la suppression d'une organisation.
- Vue super admin des signalements de messages.
