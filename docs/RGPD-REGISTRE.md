# Registre des traitements, violations de données et délégué — Rydar Drive

Document interne (RGPD, articles 30, 33 et 37), tenu par l'éditeur. Rédigé le 4 octobre 2026 (relecture juridique) ;
**à compléter et dater par le propriétaire** (raison sociale, contact, prestataire de la boîte de contact) et à mettre à
jour à chaque nouveau traitement, prestataire ou durée. Les durées reprennent `/confidentialite` § 9 et
`private.housekeeping` ; les mesures de sécurité, `/dpa` article 5. Analyses d'impact : `docs/AIPD.md`.

Responsable / sous-traitant : l'éditeur (identité dans `/admin/legal` et `/mentions-legales`). Délégué à la protection
des données : non désigné (voir § 4).

## 1. Traitements dont l'éditeur est responsable

| Traitement | Finalité | Base légale | Personnes et données | Destinataires | Durée |
|---|---|---|---|---|---|
| Comptes et facturation des centrales | Abonnements, frais plateforme, relevés, paiements, relances (tableau de bord, e-mail, WhatsApp au propriétaire sauf refus noté) | Contrat (6.1.b), obligation comptable (6.1.c) | Propriétaires, administrateurs : nom, e-mail, téléphone ; coordonnées de facturation | Éditeur ; Stripe (paiement des abonnements) ; Meta (relances WhatsApp de l'éditeur) | Registre des frais et paiements : 10 ans ; annonces de frais et de conditions : 10 ans |
| Preuves d'acceptation | Prouver l'acceptation des CGU, de la politique, des CGV et du DPA | Intérêt légitime (6.1.f) | Utilisateurs et chauffeurs : document, version, date ; e-mail du signataire des CGV | Éditeur | Durée du contrat et prescription (preuve gardée après la fin) |
| Sécurité de la plateforme | Journaux, limites anti-abus, journal d'audit, sessions | Intérêt légitime (6.1.f) | Utilisateurs : adresse IP (empreinte pour les limites), navigateur, actions | Éditeur ; hébergeur | IP et navigateur : 1 an ; compteurs : 24 h ; journaux techniques : 1 an au plus ; sessions : 400 jours sans usage |
| Lutte contre la fraude entre centrales | Interdiction sur toute la plateforme après fraude constatée | Intérêt légitime (6.1.f) | Chauffeurs et candidats : signalement, empreintes (AIPD, partie A) | Éditeur ; centrale qui signale | 3 ans après le bannissement |
| Site vitrine et formulaire de contact | Répondre aux demandes | Mesures précontractuelles, intérêt légitime | Visiteurs : nom, e-mail, message, société, téléphone ; empreinte HMAC de l'IP | Éditeur ; prestataire de la boîte de contact (à nommer) | 3 ans (indésirable : 30 jours) ; empreinte IP : 1 an |

## 2. Traitements faits pour le compte des centrales (registre du sous-traitant)

Pour chaque centrale cliente (responsable de traitement, coordonnées dans sa fiche) :

- **Catégories de traitements** : réception des réservations (tableau de bord, API, mini-site), dispatch selon la
  position des chauffeurs, suivi des courses, guidage, messagerie et signalements, documents des chauffeurs,
  candidatures par lien, gains, commissions et règlements, relances (application, WhatsApp de la centrale), accusés de
  réception des réservations du mini-site, webhooks vers ses systèmes, statistiques ; supervision technique du
  service par l'éditeur (carte des chauffeurs en ligne sans nom, journal des alertes et erreurs du dispatch : DPA,
  article 4), faite pour le compte des centrales et non comme responsable.
- **Données** : DPA, article 2.
- **Sous-traitants ultérieurs** : DPA, article 6 (hébergeur du serveur et stockage objet des sauvegardes, Expo, Apple,
  Google, Meta, Mapbox ou Google si choisis, fournisseurs de données de vol si activés). Conditions de traitement des
  données acceptées à archiver ici, avec leur date : Expo, Apple, Google, Meta, hébergeur ; certification Data Privacy
  Framework à vérifier sur dataprivacyframework.gov pour chaque prestataire américain.
- **Transferts** : DPA, article 7 (Data Privacy Framework, clauses contractuelles types).
- **Mesures de sécurité** : DPA, article 5.
- **Durées** : DPA, article 11 ; à la fin du contrat, suppression sous 30 jours (outil à construire avant la première
  fin de contrat : `docs/SECURITY.md`, « Fin du contrat d'une centrale »).

## 3. Violations de données (article 33)

1. **Détection** : alerte (journaux, `/admin`, signalement d'une centrale ou d'un tiers). Noter immédiatement dans le
   registre ci-dessous : date et heure de la découverte, source, premiers faits.
2. **Qualification sous 24 h** : nature (confidentialité, intégrité, disponibilité), catégories et nombre
   approximatif de personnes et d'enregistrements, centrales concernées, conséquences probables, risque (aucun,
   risque, risque élevé). Mesures immédiates : couper l'accès, changer les secrets (`deploy/configure.sh`), restaurer.
3. **Centrales concernées sous 48 h** (DPA, article 9) : e-mail au propriétaire avec les informations de l'article
   33.3 disponibles (nature, catégories et nombre approximatif de personnes et d'enregistrements, contact, conséquences
   probables, mesures prises ou proposées), complété ensuite ; aide à leur notification CNIL et à l'information des
   personnes.
4. **CNIL sous 72 h** pour les traitements dont l'éditeur est responsable (§ 1), sauf absence de risque ; information
   des personnes si le risque est élevé (article 34).
5. **Registre** : toutes les violations, même non notifiées : date, faits, effets, mesures, décision de notifier ou non
   et sa raison.

| Date | Faits | Personnes et données | Risque | Mesures | Notifications (centrales, CNIL, personnes) |
|---|---|---|---|---|---|
| — | Aucune violation enregistrée au 4 octobre 2026 | — | — | — | — |

## 4. Délégué à la protection des données (article 37)

Analyse au 4 octobre 2026 : service en bêta, aucune centrale cliente ni chauffeur réel. Le cœur de l'activité est un
suivi régulier et systématique à grande échelle (géolocalisation continue des chauffeurs pour le dispatch, comme
sous-traitant) : la désignation devient **obligatoire dès que ce suivi atteint une grande échelle** (lignes directrices
du CEPD : nombre de personnes, volume, durée, étendue géographique). À revoir à l'ouverture puis tous les 6 mois (nombre
de centrales et de chauffeurs suivis). Si un délégué est désigné (interne ou externe) : le déclarer à la CNIL et
l'indiquer dans `/confidentialite` § 1 et `/dpa` article 14.
