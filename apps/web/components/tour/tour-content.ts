// Visite guidée (docs/TUTORIEL.md § 7) : contenu des 5 parcours — accueil, étapes (titre, texte, écran, libellé du lien,
// ancre avec son type et son côté, condition de réussite). Textes écrits avec des espaces ordinaires et passés par fr()
// (espace insécable avant « : ; ! ? » et dans les guillemets). Lexique de la refonte (docs/REFONTE-PANELS.md § 4) ;
// les clés de parcours ne s'affichent jamais. Ancres posées dans les pages au lot T3 (§ 9.1) : d'ici là, repli centré.
import type { TourKey } from "@rydar/shared";
import { fr } from "../marketing/typo";
import type { StepCheck } from "./tour-checks";

/**
 * Élément désigné par une étape : `[data-tour="<id>"]`. « control » (bouton, lien) : fenêtre ancrée à côté (≥ 640 px) ;
 * « zone » (carte, liste) : repli centré, zone amenée à l'écran.
 */
export type TourAnchorDef = {
  id: string;
  kind: "control" | "zone";
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
};

export type TourStepDef = {
  /** Identifiant stable de l'étape (jamais affiché) */
  id: string;
  title: string;
  text: string;
  /** Écran de l'étape (adresse d'une page existante, paramètres connus) */
  href: string;
  /** Libellé du lien « Ouvrir … » */
  linkLabel: string;
  anchor: TourAnchorDef;
  /** Condition de réussite (§ 8) ; absente : étape de découverte */
  check?: StepCheck;
};

export type TourDef = { key: TourKey; intro: { title: string; text: string }; steps: readonly TourStepDef[] };

const PAUSE = "Vous pouvez arrêter à tout moment : la visite se reprend depuis votre nom, en bas du menu.";

const intro = (title: string, text: string) => ({ title: fr(title), text: fr(`${text} ${PAUSE}`) });
const step = (s: TourStepDef): TourStepDef => ({ ...s, title: fr(s.title), text: fr(s.text), linkLabel: fr(s.linkLabel) });

const IDENTITY_TEXT =
  "Raison sociale, SIRET, adresse et n° d'inscription VTC : ils figurent sur vos factures et dans l'application chauffeur.";

export const TOURS: Record<TourKey, TourDef> = {
  super_admin: {
    key: "super_admin",
    intro: intro("Bienvenue dans l'espace super admin", "Cinq étapes pour préparer la plateforme avant votre premier client."),
    steps: [
      step({
        id: "sa-legal",
        title: "Vos informations légales",
        text: "Raison sociale, siège et immatriculation de Rydar : sans elles, aucun client ne peut accepter les CGV. Complétez « Éditeur », puis « Enregistrer ».",
        href: "/admin/legal",
        linkLabel: "Ouvrir Informations légales",
        anchor: { id: "sa-legal-editor", kind: "zone" },
        check: { any: ["legal_editor"] },
      }),
      step({
        id: "sa-billing",
        title: "Vos coordonnées de paiement",
        text: "IBAN ou lien de paiement : vos clients les voient quand ils vous doivent des frais Rydar. WhatsApp et mini-sites se règlent sur la même page, si besoin.",
        href: "/admin/reglages",
        linkLabel: "Ouvrir les réglages",
        anchor: { id: "sa-billing", kind: "zone" },
        check: { any: ["platform_billing"] },
      }),
      step({
        id: "sa-plans",
        title: "Vos offres",
        text: "Une offre fixe ce qu'un client peut utiliser : chauffeurs, courses, options. Facultatif : sans offre, un client n'a aucune limite.",
        href: "/admin/plans",
        linkLabel: "Ouvrir Offres & limites",
        anchor: { id: "sa-new-plan", kind: "control", side: "bottom", align: "end" },
        check: { any: ["plans"] },
      }),
      step({
        id: "sa-client",
        title: "Votre premier client",
        text: "« Nouveau client » : flotte, centrale à commission ou Flotte Privée. Le propriétaire reçoit un e-mail pour choisir son mot de passe, puis accepte les CGV.",
        href: "/admin/organizations",
        linkLabel: "Ouvrir Clients",
        anchor: { id: "sa-new-client", kind: "control", side: "bottom", align: "end" },
        check: { any: ["clients"] },
      }),
      step({
        id: "sa-daily",
        title: "Chaque jour",
        text: "« À traiter » liste ce qui attend votre décision : paiements à confirmer, signalements, demandes. Un client signale un problème ? Regardez Supervision.",
        href: "/admin",
        linkLabel: "Ouvrir Vue d'ensemble",
        anchor: { id: "sa-todo", kind: "zone" },
      }),
    ],
  },
  fleet: {
    key: "fleet",
    intro: intro("Bienvenue sur Rydar Drive", "Cinq étapes pour régler votre flotte et créer votre première course."),
    steps: [
      step({
        id: "fl-identity",
        title: "Identité de votre entreprise",
        text: IDENTITY_TEXT,
        href: "/dashboard/settings?tab=org",
        linkLabel: "Ouvrir Organisation",
        anchor: { id: "org-identity", kind: "zone" },
        check: { any: ["org_identity"] },
      }),
      step({
        id: "fl-pricing",
        title: "Vos tarifs",
        text: "Votre grille calcule le prix proposé à chaque nouvelle course ; il reste modifiable. Remplissez au moins la catégorie de vos véhicules.",
        href: "/dashboard/settings?tab=pricing",
        linkLabel: "Ouvrir Tarifs",
        anchor: { id: "pricing-grid", kind: "zone" },
        check: { any: ["pricing"] },
      }),
      step({
        id: "fl-drivers",
        title: "Vos chauffeurs",
        text: "« Ajouter un chauffeur » : il reçoit un e-mail ou les identifiants que vous lui donnez, puis se connecte à l'application Rydar Drive.",
        href: "/dashboard/drivers",
        linkLabel: "Ouvrir Chauffeurs",
        anchor: { id: "drivers-add", kind: "control", side: "bottom", align: "end" },
        check: { any: ["drivers"] },
      }),
      step({
        id: "fl-ride",
        title: "Votre première course",
        text: "« Nouvelle course » : elle est proposée aux chauffeurs proches. Suivez-la ici ; l'onglet « À traiter » signale ce qui demande votre aide.",
        href: "/dashboard",
        linkLabel: "Ouvrir En direct",
        anchor: { id: "live-new-ride", kind: "control", side: "right", align: "start" },
        check: { any: ["first_ride"] },
      }),
      step({
        id: "fl-team",
        title: "Votre équipe",
        text: "Invitez un dispatcher ou un administrateur : il reçoit un e-mail pour choisir son mot de passe. Facultatif.",
        href: "/dashboard/settings?tab=team",
        linkLabel: "Ouvrir Équipe",
        anchor: { id: "team-add-member", kind: "control", side: "bottom", align: "end" },
        check: { any: ["team"] },
      }),
    ],
  },
  centrale: {
    key: "centrale",
    intro: intro("Bienvenue sur Rydar Drive", "Cinq étapes pour régler votre centrale et créer votre première course."),
    steps: [
      step({
        id: "ce-identity",
        title: "Identité de votre entreprise",
        text: IDENTITY_TEXT,
        href: "/dashboard/settings?tab=org",
        linkLabel: "Ouvrir Organisation",
        anchor: { id: "org-identity", kind: "zone" },
        check: { any: ["org_identity"] },
      }),
      step({
        id: "ce-pricing",
        title: "Vos tarifs",
        text: "Votre grille calcule le prix de chaque course. En centrale, le prix est obligatoire : le chauffeur voit sa part avant d'accepter.",
        href: "/dashboard/settings?tab=pricing",
        linkLabel: "Ouvrir Tarifs",
        anchor: { id: "pricing-grid", kind: "zone" },
        check: { any: ["pricing"] },
      }),
      step({
        id: "ce-commission",
        title: "Votre commission",
        text: "Votre part de chaque course, et comment vos chauffeurs vous la règlent : lien de paiement, virement ou espèces.",
        href: "/dashboard/settings?tab=centrale",
        linkLabel: "Ouvrir la commission",
        anchor: { id: "centrale-commission", kind: "zone" },
        check: { any: ["settlement"] },
      }),
      step({
        id: "ce-drivers",
        title: "Vos chauffeurs",
        text: "Créez votre lien d'inscription et partagez-le : les candidatures arrivent ici. Vous pouvez aussi ajouter un chauffeur depuis Chauffeurs.",
        href: "/dashboard/network",
        linkLabel: "Ouvrir le lien d'inscription",
        anchor: { id: "join-link", kind: "zone" },
        check: { any: ["drivers", "join_link"] },
      }),
      step({
        id: "ce-ride",
        title: "Votre première course",
        text: "« Nouvelle course » : elle est proposée aux chauffeurs proches. Après la course, confirmez le paiement reçu dans Encaissements.",
        href: "/dashboard",
        linkLabel: "Ouvrir En direct",
        anchor: { id: "live-new-ride", kind: "control", side: "right", align: "start" },
        check: { any: ["first_ride"] },
      }),
    ],
  },
  dispatcher: {
    key: "dispatcher",
    intro: intro("Bienvenue sur Rydar Drive", "Cinq étapes pour découvrir les écrans du dispatch."),
    steps: [
      step({
        id: "di-live",
        title: "En direct",
        text: "La carte montre vos chauffeurs, le panneau les courses du jour. L'onglet « À traiter » signale les retards et les courses sans chauffeur.",
        href: "/dashboard",
        linkLabel: "Ouvrir En direct",
        anchor: { id: "live-panel", kind: "zone" },
      }),
      step({
        id: "di-new",
        title: "Créer une course",
        text: "« Nouvelle course », ou la touche N : la course est proposée aux chauffeurs proches, de plus en plus loin si personne n'accepte.",
        href: "/dashboard",
        linkLabel: "Ouvrir En direct",
        anchor: { id: "live-new-ride", kind: "control", side: "right", align: "start" },
        check: { any: ["my_ride"] },
      }),
      step({
        id: "di-assign",
        title: "Attribuer une course",
        text: "Le filtre « Sans chauffeur » liste les courses que personne n'a acceptées : ouvrez-en une, puis « Attribuer ». Le chauffeur choisi est prévenu tout de suite.",
        href: "/dashboard/rides?filter=no_driver",
        linkLabel: "Ouvrir Courses",
        anchor: { id: "rides-filters", kind: "zone" },
        check: { any: ["my_ride_assigned"] },
      }),
      step({
        id: "di-messages",
        title: "Messages",
        text: "Écrivez à un chauffeur ou à toute la flotte. Les messages à modérer, dont vos chauffeurs demandent le retrait, se traitent ici.",
        href: "/dashboard/messages",
        linkLabel: "Ouvrir Messages",
        anchor: { id: "messages-threads", kind: "zone" },
      }),
      step({
        id: "di-journal",
        title: "Journal du dispatch",
        text: "Pour chaque course : chauffeurs prévenus, refus, attributions. Les réglages sont en lecture seule pour vous : demandez au propriétaire ou à un administrateur.",
        href: "/dashboard/dispatch",
        linkLabel: "Ouvrir Journal du dispatch",
        anchor: { id: "dispatch-journal", kind: "zone" },
      }),
    ],
  },
  private_fleet: {
    key: "private_fleet",
    intro: intro("Bienvenue dans votre Flotte Privée", "Cinq étapes pour prendre en main votre espace et confirmer vos réservations."),
    steps: [
      step({
        id: "fp-first-steps",
        title: "Vos premiers pas",
        text: "Cette liste montre ce qui reste à faire : entreprise, tarifs, documents, application, site. Chaque ligne dit quoi faire et où ; la liste disparaît quand tout est fait.",
        href: "/dashboard",
        linkLabel: "Ouvrir Accueil",
        anchor: { id: "fp-first-steps", kind: "zone" },
      }),
      step({
        id: "fp-confirm",
        title: "Confirmer une réservation",
        text: "Les réservations de votre site arrivent dans « À traiter ». « Je la prends » la confirme, avant l'heure indiquée. Dans l'application : « Confirmer ».",
        href: "/dashboard",
        linkLabel: "Ouvrir Accueil",
        anchor: { id: "fp-to-treat", kind: "zone" },
        check: { any: ["fp_taken"] },
      }),
      step({
        id: "fp-delays",
        title: "Délais et rappels",
        text: "Le temps que vous avez pour confirmer une réservation, et les rappels avant chaque course. Sans réponse à temps, elle passe « Non confirmée ».",
        href: "/dashboard/settings?tab=bookings",
        linkLabel: "Ouvrir Délais et rappels",
        anchor: { id: "fp-booking-settings", kind: "zone" },
      }),
      step({
        id: "fp-agenda",
        title: "Votre agenda",
        text: "Vos réservations par jour, semaine ou mois. Un client vous appelle ? Ajoutez sa réservation avec « Nouvelle réservation (téléphone) ».",
        href: "/dashboard/agenda",
        linkLabel: "Ouvrir Agenda",
        anchor: { id: "agenda-views", kind: "control", side: "bottom", align: "end" },
      }),
      step({
        id: "fp-site",
        title: "Mon site",
        text: "L'état de votre site de réservation et les réservations reçues. Vos prix se règlent dans Tarifs.",
        href: "/dashboard/site",
        linkLabel: "Ouvrir Mon site",
        anchor: { id: "fp-site-status", kind: "zone" },
      }),
    ],
  },
};

/** Clés de conditions lues pour un parcours (sans doublon), dans l'ordre des étapes. */
export function tourCheckKeys(def: TourDef) {
  return [...new Set(def.steps.flatMap((s) => s.check?.any ?? []))];
}
