// Écran « Supprimer mon compte » (App Store 5.1.1(v), Google Play) : ce qui est supprimé, ce qui est conservé, la
// confirmation finale. Flotte Privée (docs/FLOTTE-PRIVEE.md § 10.4) : le compte est partagé (adhésion owner et fiche
// chauffeur) — seule la fiche est supprimée (DRIVER_PROFILE_DELETED) ; le compte de connexion, l'espace web et les
// réservations restent. Module pur, sans dépendance native (account-deletion.test.ts).
import { frTypo } from "./settlement-text";

export type DeletionCopy = {
  /** Texte d'introduction (courses attribuées à terminer avant la suppression) */
  lead: string;
  /** Avis propre à la Flotte Privée ; null sinon */
  notice: string | null;
  /** Rubrique « Supprimé » */
  deleted: string[];
  keptTitle: string;
  /** Rubrique « Conservé » : liste (Flotte Privée) ou texte (compte chauffeur) */
  keptItems: string[];
  keptText: string | null;
  /** Bouton principal */
  button: string;
  /** Confirmation finale (sans le rappel d'une somme due, ajouté par l'écran) */
  confirmTitle: string;
  confirm: string;
  /** Refus RIDES_ASSIGNED (course attribuée) : texte de l'app ; null : message du serveur */
  ridesAssigned: string | null;
};

const DRIVER: DeletionCopy = {
  lead: "La suppression est définitive. Si une course vous est attribuée, terminez-la ou demandez à votre centrale de la réattribuer avant de supprimer votre compte.",
  notice: null,
  deleted: [
    "Votre compte de connexion, votre nom, téléphone, e-mail et photo",
    "Vos documents (carte VTC, permis…) et tous leurs fichiers",
    "Vos positions, appareils et notifications",
    "Vos messages avec la centrale, vos signalements et vos votes",
  ],
  keptTitle: "Conservé sans votre nom ni vos coordonnées",
  keptItems: [],
  keptText:
    "Les courses réalisées, gains, commissions et règlements restent enregistrés 10 ans pour les obligations comptables de la centrale, rattachés à une fiche anonyme « Chauffeur supprimé ».",
  button: "Supprimer définitivement",
  confirmTitle: "Supprimer définitivement ?",
  confirm:
    "Votre compte et vos données personnelles seront supprimés. Cette action est irréversible. Seules sont gardées, sans votre nom, les informations que la loi ou la défense des droits de la centrale imposent (courses et règlements, preuve d'acceptation des conditions, empreintes en cas de fraude ou de commissions dues) : détails sur la page « Supprimer son compte » du site.",
  ridesAssigned: null,
};

/**
 * Flotte Privée : un seul chauffeur, le propriétaire — aucune course à faire réattribuer ; ses réservations confirmées
 * se terminent ou s'annulent. Le compte de connexion sert aussi à l'espace web : il reste.
 */
const PRIVATE_FLEET: DeletionCopy = {
  lead: "La suppression est définitive. Terminez ou annulez vos réservations confirmées avant de supprimer votre fiche chauffeur.",
  notice:
    "Votre fiche chauffeur sera supprimée : les réservations de votre site ne vous seront plus proposées tant que l'équipe Rydar ne l'a pas recréée. Votre espace web et vos réservations restent.",
  deleted: [
    "Votre profil chauffeur : nom, téléphone, photo et n° de carte VTC",
    "Vos documents (carte VTC, permis…) et tous leurs fichiers",
    "Vos positions, appareils et notifications",
  ],
  keptTitle: "Conservé",
  keptItems: [
    "Votre compte de connexion (même e-mail, même mot de passe)",
    "Votre espace web et votre entreprise",
    "Vos réservations et courses passées, rattachées à une fiche anonyme « Chauffeur supprimé »",
  ],
  keptText: null,
  button: "Supprimer ma fiche chauffeur",
  confirmTitle: "Supprimer votre fiche chauffeur ?",
  confirm: "Votre fiche chauffeur et ses données seront supprimées ; votre compte et votre espace web restent. Cette action est irréversible.",
  ridesAssigned: "Terminez ou annulez vos réservations confirmées, puis supprimez votre fiche chauffeur.",
};

const typo = (c: DeletionCopy): DeletionCopy => ({
  lead: frTypo(c.lead),
  notice: c.notice && frTypo(c.notice),
  deleted: c.deleted.map(frTypo),
  keptTitle: frTypo(c.keptTitle),
  keptItems: c.keptItems.map(frTypo),
  keptText: c.keptText && frTypo(c.keptText),
  button: frTypo(c.button),
  confirmTitle: frTypo(c.confirmTitle),
  confirm: frTypo(c.confirm),
  ridesAssigned: c.ridesAssigned && frTypo(c.ridesAssigned),
});

const COPIES = { driver: typo(DRIVER), privateFleet: typo(PRIVATE_FLEET) };

/** Textes de l'écran selon le compte : chauffeur (compte supprimé) ou Flotte Privée (fiche seule, compte conservé). */
export function deletionCopy(privateFleet: boolean): DeletionCopy {
  return privateFleet ? COPIES.privateFleet : COPIES.driver;
}
