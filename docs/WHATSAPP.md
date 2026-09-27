# Relances WhatsApp

Rydar Drive envoie automatiquement des relances WhatsApp par l'**API officielle WhatsApp Business Cloud de Meta**.
Aucun outil non officiel (WhatsApp Web automatisé, applications « clones ») : ces outils font bannir le numéro.

| Qui envoie | À qui | Quand | Modèle |
|---|---|---|---|
| La centrale (son numéro WhatsApp Business, par exemple son compte dispatch) | Chauffeurs | Bouton « Relancer » (Encaissements) et relances automatiques des commissions en retard (une par jour, 3 au plus) | `rappel_commission` |
| Rydar (votre numéro WhatsApp Business) | Propriétaire de la centrale (téléphone du profil, sinon celui de la centrale) | /admin/frais, compte d'une centrale, « Relancer », puis cocher « Envoyer aussi par WhatsApp » | `rappel_frais_plateforme` |

## Canaux (centrale)

Le canal se choisit dans **Réglages › Commission & encaissement › Relances des chauffeurs** : *Application*, *WhatsApp* ou *Les deux*.

WhatsApp peut être impossible : numéro non relié, envois désactivés, numéro du chauffeur invalide, ou refus définitif de Meta (par exemple un numéro sans WhatsApp). La relance part alors **par l'application**, et le chauffeur est toujours prévenu. La dernière erreur s'affiche dans les réglages.

## Mise en place chez Meta (à faire une fois par numéro)

1. **Compte** : créez un portefeuille Meta Business sur [business.facebook.com](https://business.facebook.com), puis une application de type « Business » sur [developers.facebook.com](https://developers.facebook.com). Ajoutez-lui le produit **WhatsApp**.
2. **Numéro** : dans WhatsApp › Configuration de l'API, ajoutez le numéro et vérifiez-le par SMS ou par appel. Un numéro déjà utilisé dans l'application WhatsApp doit d'abord y être supprimé. Ajoutez aussi un **moyen de paiement** dans le Gestionnaire WhatsApp : les messages « Utilité » sont facturés par Meta.
3. **Identifiant du numéro** : copiez le *Phone number ID* (une suite de chiffres). Ce n'est pas le numéro de téléphone.
4. **Jeton permanent** : dans Paramètres de l'entreprise › Utilisateurs › Utilisateurs système, créez un utilisateur système (Admin). Donnez-lui accès à l'application et au compte WhatsApp, puis générez un jeton **sans expiration** avec les autorisations `whatsapp_business_messaging` et `whatsapp_business_management`. Le jeton temporaire de la page « Démarrage » expire au bout de 24 h : ne l'utilisez pas.
5. **Modèle** : dans le Gestionnaire WhatsApp › Modèles de message, créez le modèle ci-dessous. Choisissez la catégorie **Utilité**, la langue **Français (fr)**, et copiez le texte à l'identique. Attendez ensuite l'approbation (de quelques minutes à 24 h).
6. **Rydar Drive** : collez l'identifiant du numéro et le jeton dans la carte WhatsApp, puis cliquez sur « Vérifier et relier ». Rydar interroge Meta et affiche le nom vérifié. Envoyez enfin un **message test** à votre propre numéro.

### Modèle centrale : `rappel_commission` (4 variables)

```
Bonjour {{1}}, vous avez {{2}} de commission à régler à {{3}} ({{4}}). Réglez depuis l'application Rydar Drive, onglet Commissions.
```

Exemple de variables demandé par Meta : `Karim`, `19 €`, `NovaLink`, `2 courses`.

### Modèle Rydar : `rappel_frais_plateforme` (3 variables)

```
Bonjour, les frais plateforme Rydar Drive de {{1}} s'élèvent à {{2}} (échéance {{3}}). Détails et paiement : tableau de bord, onglet Encaissements.
```

Exemple de variables : `NovaLink`, `182,40 €`, `05/10/2026`.

Un modèle portant un autre nom peut être utilisé : il faut alors l'indiquer dans la carte WhatsApp. Il doit garder le **même nombre de variables, dans le même ordre**.

## Obligations

- **Consentement** : les destinataires doivent avoir accepté de recevoir des messages WhatsApp de l'expéditeur (règles de Meta). La centrale recueille cet accord auprès de ses chauffeurs, par exemple dans son contrat ou à l'inscription. Rydar le recueille auprès des centrales dans ses conditions.
- **Arrêt des messages** : un destinataire qui bloque le numéro ne reçoit plus rien. Sa relance repasse alors par l'application.
- **Qualité** : si trop de destinataires bloquent ou signalent les messages, Meta suspend le modèle ou limite le numéro. Évitez donc les relances inutiles. Les relances automatiques sont déjà limitées à 3 par commission, une par jour au plus.

## Fonctionnement technique

- **Base de données (migrations 003600 et 003700)**
  - Tables de configuration : `org_whatsapp` et `platform_whatsapp`. Elles sont lisibles par les owner et admin de la centrale et par le super admin.
  - Jetons : `org_whatsapp_secrets` et `platform_whatsapp_secrets`. Seul le **service role** peut les lire.
  - Les messages passent par la file `notifications`, sur le canal `whatsapp`.
- **Worker (`apps/worker/src/whatsapp.ts`)** : il est réveillé par `LISTEN rydar_notifications` et interroge aussi la file toutes les 3 s.
  1. `private.claim_whatsapp(n)` réserve un lot de messages avec les identifiants de l'expéditeur.
  2. L'envoi passe par `POST https://graph.facebook.com/v23.0/{phone_number_id}/messages`, sous forme de modèle.
  3. `private.complete_whatsapp` termine l'envoi :
     - les erreurs temporaires (5xx, 429, limites de débit) sont reprises jusqu'à 5 fois ;
     - un échec définitif déclenche le repli par l'application.
  4. `PUSH_DRY_RUN=true` n'envoie rien.
- **Web (`apps/web/lib/whatsapp.ts`)** : il vérifie le numéro avant l'enregistrement (`GET /{phone_number_id}`) et envoie le message test sur-le-champ. Les deux actions sont limitées : 10 enregistrements et 5 tests par tranche de 10 minutes.
- **Variables d'environnement** : `WHATSAPP_API_VERSION` (facultative) remplace la version par défaut de l'API Graph (`v23.0`). Aucun jeton n'est placé dans `.env` : chaque numéro se configure dans l'interface.
- **Limite actuelle** : Meta accepte le message (réponse 200), puis signale sa remise ou son échec par un webhook, qui n'est pas encore branché. Un numéro sans WhatsApp peut donc être compté comme « envoyé » alors que le message n'est jamais remis.
