// Textes publics du réseau partagé (spec §7.1 à §7.3) : convention entre organisations (/reseau-partage/conditions,
// document « network ») et conditions des chauffeurs (/reseau-partage/chauffeur, document « network_driver »).
// Version : NETWORK_TERMS_VERSION ; relecture du juriste : NETWORK_TERMS_REVIEWED (bandeau tant qu'elle vaut false).
// Décisions du propriétaire : le chauffeur partenaire est traité comme les chauffeurs de l'organisation qui confie,
// celle du chauffeur ne prend rien (Q1) ; c'est toujours le chauffeur qui règle ou qui est payé, et chaque chauffeur
// accepte lui-même (Q2) ; l'organisation du chauffeur ne voit pas sa position pendant la course partagée (Q5).
// Rydar est un éditeur de logiciel : mots interdits NETWORK_FORBIDDEN_WORDS (test). Côté chauffeur : un seul montant,
// jamais « commission » ni frais de l'éditeur (test). Variables : {version}, {editor}, {contact}.
import { NETWORK_PARAMS, NETWORK_POSITIONING } from "@rydar/shared";

export type NetworkLegalSection = { title: string; paragraphs?: string[]; items?: string[] };
export type NetworkLegalDoc = { title: string; description: string; intro: string[]; sections: NetworkLegalSection[] };

/** Date de rédaction affichée (« Mise à jour le … ») ; la version fait foi (NETWORK_TERMS_VERSION). */
export const NETWORK_TERMS_UPDATED_AT = "3 octobre 2026";

/** Bandeau tant que NETWORK_TERMS_REVIEWED vaut false. */
export const NETWORK_TERMS_REVIEW_NOTICE =
  "Texte en cours de relecture juridique : il peut encore évoluer avant l'ouverture du réseau partagé. La version relue sera publiée ici et présentée pour acceptation.";

const P = NETWORK_PARAMS;

// ---------------------------------------------------------------------------------------------------------------
// Convention entre organisations (document « network »)
// ---------------------------------------------------------------------------------------------------------------

export const NETWORK_CONVENTION: NetworkLegalDoc = {
  title: "Convention du réseau partagé",
  description:
    "Convention entre les organisations qui utilisent Rydar Drive et activent le réseau partagé : rôle de chacun, montants, règlements, données personnelles, exclusions.",
  intro: [
    "La présente convention s'applique entre les organisations (centrales de réservation, exploitants et flottes de VTC) qui utilisent Rydar Drive et activent le réseau partagé. Elle complète les conditions générales de vente (CGV) et d'utilisation (CGU), qui restent applicables. Version {version}.",
    "Dans ce texte, « l'organisation qui confie » est celle qui a reçu la réservation du client ; « l'organisation exécutante » est celle du chauffeur qui fait la course ; « le chauffeur partenaire » est un chauffeur de l'organisation exécutante.",
  ],
  sections: [
    {
      title: "1. Objet",
      paragraphs: [NETWORK_POSITIONING],
      items: [
        "Le réseau partagé est facultatif : chaque organisation choisit de partager ses courses non prises, de recevoir celles des autres, les deux ou aucun, et peut changer d'avis à tout moment.",
        `Ses chauffeurs d'abord : une course n'est proposée au réseau que si aucun chauffeur de l'organisation qui confie ne l'a acceptée (course immédiate : après ses vagues habituelles ; course planifiée : ${P.scheduledLeadMinutes / 60} heures avant la prise en charge), et seulement si un chauffeur partenaire est à proximité.`,
        "L'ordre est fixe et le même pour tous : les chauffeurs de l'organisation qui confie, puis la distance au point de départ. Le premier chauffeur qui accepte obtient la course.",
      ],
    },
    {
      title: "2. Rôle de l'éditeur",
      items: [
        "L'éditeur de Rydar Drive ({editor}) fournit le logiciel. Il n'est partie ni au contrat de transport ni à la sous-traitance entre organisations, n'encaisse aucune somme pour le compte des organisations ou des chauffeurs et ne garantit ni l'exécution des courses ni leur paiement.",
        "Sa validation est une vérification administrative de l'inscription au registre des exploitants VTC (raison sociale, SIRET, numéro d'inscription), pas une sélection. Ces informations validées sont montrées aux organisations partenaires ; un changement de nom, de raison sociale, de SIRET ou de numéro d'inscription fait perdre la validation jusqu'à une nouvelle vérification.",
        "Les seules règles posées par l'éditeur concernent la conformité : validation de l'inscription, documents obligatoires des chauffeurs, acceptation de la présente convention et frais prévus par les CGV. Il ne tient aucune liste commune de mauvais payeurs : chaque organisation applique ses propres règles à ses propres courses.",
        "L'éditeur peut suspendre la participation d'une organisation pour manquement à la présente convention ou aux CGV ; une suspension n'est jamais un jugement sur la qualité d'un service.",
      ],
    },
    {
      title: "3. L'organisation qui confie la course",
      items: [
        "Elle reste seule responsable de la course envers son client (pour une centrale de réservation : responsabilité de plein droit, articles L3142-1 et suivants du Code des transports).",
        "Elle est le vendeur : elle fixe le prix et délivre au client le reçu ou la facture.",
        "Elle informe ses clients que leur course peut être exécutée par un exploitant VTC partenaire.",
        "Elle propose aux chauffeurs partenaires au moins un moyen de paiement en ligne (lien de paiement ou virement), les espèces pouvant s'y ajouter, et ne peut pas le retirer tant que son partage est actif.",
        "Elle doit les frais Rydar de chaque course partagée terminée, à son propre taux, comme pour ses autres courses (CGV) ; l'organisation exécutante ne doit rien à l'éditeur pour ces courses. Pour partager, une organisation doit avoir des frais Rydar, sauf dérogation accordée à la validation.",
      ],
    },
    {
      title: "4. L'organisation exécutante",
      items: [
        "Elle exécute la course en sous-traitance, au prix fixé par l'organisation qui confie, avec ses véhicules et sous son assurance.",
        "Elle garantit son inscription au registre des exploitants VTC (numéro validé), des chauffeurs titulaires d'une carte professionnelle VTC valide, et des véhicules et assurances conformes (responsabilité civile circulation et transport de personnes à titre onéreux) qui couvrent les courses faites pour d'autres organisations.",
        "Elle vérifie les documents de ses chauffeurs. Pour recevoir une course, un chauffeur doit avoir sa carte VTC, son assurance, la carte grise du véhicule et son permis validés et valables à la date de prise en charge, ainsi que son numéro de carte VTC renseigné ; pour un chauffeur indépendant d'une centrale, son numéro d'inscription au registre des exploitants VTC. Ces contrôles (numéros et échéances, sans les pièces) sont figés à l'acceptation et montrés à l'organisation qui confie, qui peut demander les justificatifs.",
        "Elle ne prélève rien sur les courses partagées : le chauffeur partenaire est traité comme les chauffeurs de l'organisation qui confie.",
        "Elle choisit les chauffeurs autorisés à recevoir les courses du réseau et fixe le plafond de ce que chacun d'eux peut devoir au réseau, toutes organisations confondues.",
      ],
    },
    {
      title: "5. Montants et règlements",
      items: [
        "Avant d'accepter, le chauffeur voit le prix et un seul montant : la part de l'organisation qui confie (sa commission éventuelle et ses frais Rydar compris) quand le client paie à bord, ou la part du chauffeur quand le client a déjà payé. Ces montants sont figés à l'acceptation : ce qui a été accepté est ce qui est réglé.",
        "Pour modifier une course confiée (prix, paiement, adresses, heure), l'organisation qui confie la retire d'abord au chauffeur partenaire, qui en est prévenu ; la course repart alors en recherche, ses propres chauffeurs d'abord.",
        `Client payé à bord : le chauffeur encaisse le client et reverse à l'organisation qui confie sa part, pour le compte de l'organisation exécutante, avec les moyens de paiement qu'elle propose, au plus tard à l'échéance qu'elle a fixée et jamais moins de ${P.minDriverGraceHours} heures après la fin de la course.`,
        `Client qui a déjà payé : l'organisation qui confie verse au chauffeur sa part, pour le compte de l'organisation exécutante, sous ${P.payoutDays} jours.`,
        "Dans les deux cas, c'est le chauffeur qui règle ou qui est payé ; l'organisation exécutante est garante envers l'organisation qui confie des sommes encaissées par ses chauffeurs.",
        `Une organisation qui a un versement en retard de plus de ${P.overdueSharingDays} jours ne peut plus partager ses courses jusqu'à régularisation.`,
        "Un impayé envers une organisation ne bloque que les courses de cette organisation ; le plafond fixé par l'organisation exécutante vaut pour toutes les organisations confondues.",
        "Le chauffeur peut répondre « Je conteste » à un paiement marqué « non reçu » ou à un versement contesté ; l'organisation qui confie reste seule juge de ses encaissements. L'éditeur ne tranche pas les sommes dues entre organisations et chauffeurs.",
      ],
    },
    {
      title: "6. Courses à vérifier et contestations",
      items: [
        `Une fin de course inhabituelle (position absente, arrivée loin du départ ou de la destination, durée très courte) n'est jamais refusée au chauffeur : la course est signalée « à vérifier » et le versement d'une course déjà payée est retenu ${P.payoutHoldHours} heures, sauf validation plus tôt par l'organisation qui confie.`,
        `L'organisation qui confie peut contester une course dans les ${P.contestDays} jours qui suivent sa fin : le versement prévu au chauffeur (client qui a déjà payé) est annulé, ce que le chauffeur doit reverser (client payé à bord) reste dû, et une baisse de ses frais Rydar pour cette course est soumise à l'éditeur, qui ne décide que de ses propres frais. Cette baisse n'est jamais acquise faute de réponse : les frais restent dus tant que l'éditeur ne l'a pas acceptée (l'acceptation au bout de 30 jours prévue par les CGV pour une correction du prix ne s'y applique pas).`,
        "Une course que le chauffeur partenaire ne peut plus terminer dans l'application (organisation ou chauffeur inactif, aucune position depuis 30 minutes) peut être clôturée par l'organisation qui confie ; elle est alors signalée « à vérifier ».",
      ],
    },
    {
      title: "7. Facturation et relevés",
      items: [
        "La facturation entre l'organisation qui confie, l'organisation exécutante et le chauffeur se fait en dehors de Rydar Drive, selon les règles qui leur sont applicables.",
        "Rydar Drive fournit un relevé mensuel par partenaire (date, référence, prix, part de chacun, sens et état du règlement), identique des deux côtés et exportable.",
      ],
    },
    {
      title: "8. Non-sollicitation",
      paragraphs: [
        "L'organisation exécutante et ses chauffeurs ne démarchent pas les clients de l'organisation qui confie rencontrés grâce au réseau partagé ; l'organisation qui confie ne démarche pas les chauffeurs de l'organisation exécutante.",
      ],
    },
    {
      title: "9. Données personnelles",
      items: [
        "Client de l'organisation qui confie : elle en reste responsable. L'organisation exécutante agit comme sous-traitant pour la seule exécution de la course (article 28.3 du RGPD) : sur instruction documentée (la course), dans la confidentialité, par ses seuls chauffeurs autorisés, avec des mesures de sécurité adaptées, sans sous-traitance ultérieure, avec effacement à la fin, assistance pour l'exercice des droits et en cas de violation de données, et possibilité d'audit.",
        `Le chauffeur partenaire voit le nom et le téléphone du client à partir d'une heure avant la prise en charge (dès l'acceptation pour une course immédiate) et jusqu'à ${P.clientDataAfterMinutes} minutes après la fin ; chaque consultation est enregistrée pour l'organisation qui confie.`,
        "L'organisation exécutante ne voit jamais le client ni l'adresse exacte de la course, seulement les communes de départ et d'arrivée ; elle ne voit pas la position de son chauffeur pendant la course partagée. Pour un incident (amende, sinistre, objet perdu), elle demande les faits nécessaires à l'organisation qui confie.",
        `Chauffeur partenaire : l'organisation qui confie reçoit son prénom, l'initiale de son nom, son véhicule, sa plaque, son téléphone (jusqu'à ${P.phoneAfterHours} heures après la fin de la course, plus longtemps tant qu'un règlement est ouvert), le numéro et les échéances de sa carte VTC et de ses documents, et ses coordonnées bancaires seulement quand elle doit lui verser une somme (chaque consultation est notifiée au chauffeur). Elle est responsable distincte de ces données pour l'exécution et le paiement de la course et les conserve pendant la durée du règlement augmentée des délais comptables légaux. L'organisation exécutante en informe ses chauffeurs.`,
      ],
    },
    {
      title: "10. Exclusions, arrêt et suspension",
      items: [
        "Chaque organisation peut exclure une organisation déjà rencontrée (plus aucune course échangée, dans les deux sens) ou un chauffeur partenaire précis, même s'il change d'organisation. L'exclusion n'est pas montrée à la personne ou à l'organisation exclue.",
        `Un chauffeur à qui ${P.releasesLimit} courses partagées sont retirées en ${P.releasesWindowDays} jours par son organisation ne reçoit plus les courses du réseau pendant ${P.autoExclusionDays} jours.`,
        "Chaque organisation peut arrêter de partager ou de recevoir à tout moment : l'arrêt vaut pour les nouvelles courses, celles déjà acceptées vont à leur terme.",
        "Une suspension par l'éditeur, ou le retrait d'un chauffeur par son organisation, remet en recherche les courses non commencées : le client de l'organisation qui confie n'est jamais abandonné.",
        "Les litiges entre organisations se règlent entre elles, sans l'éditeur.",
      ],
    },
    {
      title: "11. Acceptation, durée et versions",
      items: [
        "La convention est acceptée par le propriétaire ou un administrateur de l'organisation, dans le tableau de bord ; la version, la date et la personne qui l'a acceptée sont conservées. Elle s'applique tant que l'organisation participe au réseau partagé.",
        "Une nouvelle version est annoncée dans le tableau de bord et par e-mail ; la version précédente reste valable pendant un délai de grâce, puis le partage et la réception s'arrêtent jusqu'à l'acceptation de la nouvelle version.",
        "Contact : {contact}.",
      ],
    },
  ],
};

// ---------------------------------------------------------------------------------------------------------------
// Conditions des chauffeurs (document « network_driver », écran des conditions de l'application)
// ---------------------------------------------------------------------------------------------------------------

export const NETWORK_DRIVER_TERMS: NetworkLegalDoc = {
  title: "Réseau partagé : conditions des chauffeurs",
  description:
    "Ce que change le réseau partagé pour un chauffeur : courses proposées par d'autres organisations, montant unique, règlements, données, arrêt à tout moment.",
  intro: [
    "Ces conditions s'appliquent quand votre organisation reçoit les courses du réseau partagé et que vous activez « Courses du réseau partagé » dans votre profil de l'application Rydar Drive. Elles complètent les CGU. Version {version}.",
  ],
  sections: [
    {
      title: "En bref",
      items: [
        "Vous faites la course pour le compte de votre organisation, avec votre véhicule et sous son assurance.",
        "Si le client paie à bord, vous réglez la part de l'organisation qui vous confie la course, pour le compte de votre organisation, avec les moyens de paiement qu'elle propose.",
        "Si le client a déjà payé, l'organisation qui vous confie la course vous verse votre part.",
        "Elle reçoit votre prénom, l'initiale de votre nom, votre véhicule, votre plaque, votre téléphone et le numéro de votre carte VTC.",
        "Vous pouvez arrêter à tout moment dans votre profil.",
      ],
    },
    {
      title: "Avant d'accepter",
      items: [
        "Une course partagée ne vous est proposée que si aucun chauffeur de l'organisation qui la confie ne l'a acceptée. Votre organisation garde la priorité sur ses propres courses.",
        "L'offre indique l'organisation qui confie la course, le quartier ou la commune de départ, la commune d'arrivée, l'heure, le prix et un seul montant : ce que vous reverserez à cette organisation (client payé à bord) ou ce qu'elle vous versera (client déjà payé).",
        "L'adresse exacte, le trajet et les indications de la course apparaissent après votre acceptation. Le nom et le téléphone du client sont visibles à partir d'une heure avant la prise en charge (dès l'acceptation pour une course immédiate) et jusqu'à une heure après la fin.",
        "Le montant accepté ne change plus. Si l'organisation doit modifier la course, elle vous la retire d'abord et vous en êtes prévenu.",
      ],
    },
    {
      title: "Régler et être payé",
      items: [
        `Vous réglez chaque organisation avec ses propres moyens de paiement, depuis « Courses partenaires » dans l'application, avant l'échéance indiquée (jamais moins de ${P.minDriverGraceHours} heures après la fin de la course). C'est vous qui réglez, quelle que soit votre organisation.`,
        `Pour une course déjà payée, l'organisation vous verse votre part sous ${P.payoutDays} jours, sur les coordonnées bancaires que vous avez enregistrées dans l'application. Elles sont facultatives, ne servent qu'à ces versements, et vous êtes prévenu à chaque consultation.`,
        "Si une organisation indique ne pas avoir reçu votre paiement, vous pouvez répondre « Je conteste ». Un impayé envers une organisation ne vous bloque que pour les courses de cette organisation.",
        "Votre organisation peut fixer un plafond de ce que vous pouvez devoir au réseau : au-delà, réglez d'abord vos courses partenaires pour en recevoir d'autres.",
        "Reçu ou facture du client : délivré par l'organisation qui vous confie la course.",
      ],
    },
    {
      title: "Pendant la course",
      items: [
        "Gardez à portée de main le bon de réservation affiché dans l'application : il indique l'organisation qui a pris la réservation, l'exploitant qui exécute la course, le client et l'heure de prise en charge.",
        "Votre organisation ne voit pas votre position pendant une course partagée : elle voit seulement « En course partenaire ».",
        "Une fin de course inhabituelle (position absente, durée très courte) n'est jamais refusée : la course peut être signalée « à vérifier » à l'organisation qui la confie.",
        `Si vous ne pouvez plus faire la course, ou si votre organisation vous retire du réseau, la course est remise en recherche. ${P.releasesLimit} courses partagées retirées en ${P.releasesWindowDays} jours suspendent le réseau pour vous pendant ${P.autoExclusionDays} jours.`,
      ],
    },
    {
      title: "Pour recevoir les courses du réseau",
      items: [
        "Votre organisation reçoit les courses du réseau et vous y autorise.",
        "Votre carte VTC, votre assurance, la carte grise de votre véhicule et votre permis sont validés et valables à la date de la course ; le numéro de votre carte VTC est renseigné, ainsi que, si vous êtes chauffeur indépendant d'une centrale, votre numéro d'inscription au registre des exploitants VTC.",
        "Votre application est à jour.",
        "Une organisation peut ne plus vous confier de courses, même si vous changez d'organisation.",
      ],
    },
    {
      title: "Vos données",
      items: [
        `L'organisation qui vous confie la course reçoit les informations indiquées plus haut pour l'exécution et le paiement de la course, et les conserve pendant la durée du règlement augmentée des délais comptables légaux. Votre téléphone lui reste visible jusqu'à ${P.phoneAfterHours} heures après la fin de la course, plus longtemps tant qu'un règlement est ouvert.`,
        "Vos positions pendant une course partagée ne sont montrées ni à votre organisation ni à l'organisation qui confie la course ; elles sont effacées une heure après la fin de la course.",
        "Ne démarchez pas les clients rencontrés grâce au réseau partagé.",
        "Pour exercer vos droits : votre organisation ou l'éditeur ({contact}). Voir aussi la politique de confidentialité.",
      ],
    },
    {
      title: "Rôle de Rydar",
      paragraphs: [NETWORK_POSITIONING],
    },
    {
      title: "Accepter, arrêter",
      items: [
        "Chaque chauffeur accepte ces conditions lui-même, dans l'application, et règle lui-même ses courses partenaires.",
        "Vous pouvez arrêter à tout moment dans votre profil : les courses déjà acceptées vont à leur terme.",
        "Une nouvelle version vous est présentée dans l'application ; l'ancienne reste valable pendant un délai de grâce.",
      ],
    },
  ],
};

/** Tous les textes d'un document (tests : mots interdits, vocabulaire du chauffeur). */
export function documentTexts(doc: NetworkLegalDoc): string[] {
  return [doc.title, doc.description, ...doc.intro, ...doc.sections.flatMap((s) => [s.title, ...(s.paragraphs ?? []), ...(s.items ?? [])])];
}
