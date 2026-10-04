# Analyses d'impact (AIPD) — Rydar Drive

Document interne (RGPD, article 35), rédigé le 4 octobre 2026 lors de la relecture juridique. **À valider et dater par
le propriétaire, puis à faire relire par un avocat.** À revoir à chaque changement (réseau partagé, nouveau
sous-traitant, nouvelle donnée, nouvel automatisme) et au moins une fois par an. Le DPA (`/dpa`, article 10) y renvoie :
la partie B est la description remise aux centrales sur demande.

## A. Lutte contre la fraude entre centrales et interdiction sur toute la plateforme

Rydar est **responsable de traitement** (DPA, article 1). Liste CNIL des traitements soumis à AIPD : « traitements
mutualisés de manquements contractuels pouvant mener à une exclusion », décisions automatisées (article 22).

### 1. Description

- **Finalité** : empêcher qu'une personne qui a commis une fraude constatée chez une centrale (usurpation d'identité,
  document faux ou falsifié, fausse déclaration) se réinscrive chez une autre. Une dette, un comportement ou un
  différend reste propre à la centrale : jamais d'interdiction sur toute la plateforme (code `PLATFORM_BAN_CATEGORY`,
  `PLATFORM_REPORT_CATEGORY`, migration `20260924007400`).
- **Base légale** : intérêt légitime de l'éditeur et des centrales (article 6.1.f) ; information et recours : règlement
  (UE) 2022/2065, article 17.
- **Données** : signalement (nom, catégorie `fraud` ou `documents`, motif de la centrale, 500 caractères au plus) ;
  faits retenus par l'éditeur (10 caractères au moins, envoyés au chauffeur) ; empreintes sha256 du téléphone, de
  l'e-mail, des numéros de carte VTC, de permis et de pièce d'identité, de la plaque et de l'identifiant d'appareil,
  avec un indice partiel ; journal d'audit.
- **Personnes** : chauffeurs et candidats des centrales.
- **Destinataires** : l'éditeur (super admin) ; les administrateurs de la centrale qui a signalé (empreintes,
  signalement) et toute son équipe (motif) ; les autres centrales ne voient que le refus (« Identité bannie ») ou la
  suspension, avec une alerte, sans le motif du signalement.
- **Déroulement** : bannissement par la centrale (`ban_driver`, signalement possible seulement pour une fraude ou un
  document faux) → examen par une personne de l'éditeur (`/admin`, correspondances `admin_fraud_report_matches`) →
  décision `svc_platform_ban` (faits retenus obligatoires) → e-mail motivé à chaque chauffeur touché (`platform_ban`,
  motifs, articles 10 et 11 des CGU, conséquences, recours de 6 mois, juge, CNIL) → comparaison exacte des empreintes
  à l'inscription, à l'enregistrement d'une fiche ou d'un justificatif et à la première connexion d'un appareil.
- **Durées** : empreintes, motif et signalement effacés 3 ans après le bannissement (`private.housekeeping`) ; nom et
  indices partiels effacés dès la suppression du compte.

### 2. Nécessité et proportionnalité

- Seules deux catégories (fraude, document faux) ouvrent l'interdiction plateforme ; décision humaine, motivée, avec
  recours ; extension aux fiches d'autres centrales seulement après confirmation fiche par fiche.
- Comparaison exacte d'empreintes, sans donnée en clair ; aucun score, aucune donnée de santé ni d'infraction
  (le motif décrit un manquement aux règles, jamais une infraction pénale supposée : aide du formulaire).
- Accès limité (administrateurs de la centrale, éditeur) ; journal d'audit de chaque décision.

### 3. Risques et mesures

| Risque | Gravité | Mesures en place | Mesures à prendre |
|---|---|---|---|
| Faux positif (téléphone recyclé, appareil d'occasion ou partagé) : inscription refusée ou compte suspendu à tort | Importante | Comparaison exacte ; réexamen humain sur demande (politique, article 5 ; CGU, article 11) ; alerte à la centrale | Mettre la candidature « à examiner » au lieu de la refuser (décision humaine avant tout refus, article 22) |
| Signalement abusif d'une centrale concurrente | Importante | Catégories limitées, examen par l'éditeur, faits retenus motivés, garantie de la centrale (CGV, article 10 bis) | Revoir chaque année les signalements refusés ou contestés |
| Réidentification des empreintes (hachage sha256 sans secret : un téléphone se retrouve par force brute) | Importante | Lecture réservée (RLS, fonctions `security definer`), indices partiels effacés à la suppression | Passer à un HMAC avec un secret du serveur (nouvelle migration + recalcul) |
| Information insuffisante de la personne | Modérée | E-mail motivé (DSA, article 17), message d'accès refusé distinct (`ban_scope`), pages CGU / confidentialité | Vérifier que l'e-mail est bien parti (`/admin/contacts`) |
| Durée excessive | Modérée | 3 ans puis effacement automatique | — |

Risque résiduel après les mesures à prendre : **modéré**. Sans elles, consulter un avocat sur l'opportunité d'une
consultation préalable de la CNIL (article 36).

## B. Géolocalisation des chauffeurs et dispatch (description remise aux centrales)

Rydar est **sous-traitant** : la centrale est responsable de traitement et réalise sa propre AIPD (géolocalisation
continue de travailleurs). Cette partie lui fournit la description technique (DPA, article 10).

- **Données envoyées par l'application** : position (latitude, longitude), cap, vitesse, précision, niveau de batterie,
  heure du relevé (`update_driver_location`).
- **Quand** : seulement quand le chauffeur est EN LIGNE ou en course (autorisation « Pendant l'utilisation », jamais
  « Toujours ») ; toutes les 5 s environ pendant une offre ou une course, toutes les 15 s environ en ligne ; rien hors
  ligne, sauf la position d'un signalement que le chauffeur publie. Hors ligne impossible pendant une course ;
  application fermée : hors ligne au bout de 3 minutes.
- **Information préalable** : écran avant la fenêtre du système (`confirmLocationDisclosure`), CGU article 6,
  politique de confidentialité, indicateur iOS ou notification Android « EN LIGNE ».
- **Stockage** : dernière position (remplacée à chaque envoi, vitesse comprise pour savoir si le véhicule roule) ;
  historique : un point par minute environ en ligne, chaque point en course, **sans la vitesse** (migration
  `20260924007400`), effacé après 30 jours (ou à la clôture d'une alerte restée ouverte).
- **Destinataires** : équipe de la centrale (propriétaire, administrateurs, dispatchers) ; éditeur pour le support et
  la sécurité, sur une carte de supervision sans nom ni téléphone ni plaque ni adresse ; jamais le client ni les autres
  chauffeurs (sauf la position d'un signalement publié). Réseau partagé (coupé) : voir sa convention avant ouverture.
- **Sécurité** : TLS, base joignable seulement en local, cloisonnement par centrale (RLS), session chiffrée sur le
  téléphone, sauvegardes chiffrées (14 jours).
- **Risques pour les chauffeurs** et réponses : suivi hors du temps de travail (envoi seulement en ligne ou en course,
  hors ligne en un geste) ; contrôle de la vitesse (vitesse non historisée, jamais affichée en km/h) ; détournement par
  un membre de l'équipe (rôles, journal des actions sensibles) ; fuite (mesures ci-dessus).
- **À la charge de la centrale** (CGV, article 10) : information des chauffeurs, consultation du CSE si ses chauffeurs
  sont salariés, pas d'usage hors temps de travail ni pour contrôler la vitesse, sa propre AIPD.
