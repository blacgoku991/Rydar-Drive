// Lien d'inscription des chauffeurs (/rejoindre/{code}) : textes selon le modèle de l'organisation.
// Centrale à commission : réseau de chauffeurs indépendants (textes historiques, inchangés). Flotte : aucune mention
// de commission, de part chauffeur ni de « réseau ». Module pur (ni « use client » ni « server-only ») : importable
// par les pages serveur, les composants client et les tests unitaires.
// Le modèle est OBLIGATOIRE : une réponse de svc_join_info sans modèle passe d'abord par joinInfoModel (→ centrale).
import type { DispatchModel } from "@rydar/shared";

const isFleet = (model: DispatchModel) => model === "fleet";
/** Espace insécable (avant « : ; ! ? ») des nouveaux textes ; ceux de la centrale restent tels quels. */
const NB = "\u00a0";

/**
 * Modèle d'une réponse de svc_join_info ou de /api/join/{code} : sans modèle (base d'avant 20260924006300, où seules
 * les centrales avaient un lien) → « centrale ». Seul défaut du lien d'inscription (page, route, application).
 */
export function joinInfoModel(model: string | null | undefined): DispatchModel {
  return model === "fleet" ? "fleet" : "centrale";
}

/** Lien inconnu, coupé ou régénéré (le modèle n'est pas connu : texte valable pour les deux). */
export const JOIN_LINK_INACTIVE = "Ce lien d'inscription n'est plus actif. Demandez le lien à jour à la centrale ou à la flotte qui vous l'a envoyé.";
/** Compte de connexion déjà rattaché à une fiche chauffeur, quelle que soit l'organisation. */
export const JOIN_ALREADY_REGISTERED = "Ce compte est déjà rattaché à une centrale ou à une flotte.";

/** Erreurs de l'inscription une fois l'organisation connue : refus neutre (identité bannie) et doublons. */
export function joinErrorCopy(orgName: string, model: DispatchModel) {
  if (!isFleet(model)) {
    return {
      refusal: "Inscription impossible. Contactez la centrale.",
      phone: "Ce numéro est déjà inscrit dans cette centrale : connectez-vous à l'application avec votre compte.",
      email: "Cette adresse e-mail est déjà inscrite dans cette centrale.",
      plate: "Cette plaque est déjà enregistrée dans cette centrale.",
    };
  }
  return {
    refusal: `Inscription impossible. Contactez ${orgName}.`,
    phone: `Ce numéro est déjà inscrit dans cette flotte${NB}: connectez-vous à l'application avec votre compte.`,
    email: "Cette adresse e-mail est déjà inscrite dans cette flotte.",
    plate: "Cette plaque est déjà enregistrée dans cette flotte.",
  };
}

/**
 * Entrée du menu du tableau de bord et titre de la page : « Réseau » (centrale) ou « Inscriptions » (flotte) ;
 * « Inscriptions » pour les deux quand le réseau partagé est ouvert (pas de confusion avec « Réseau partagé »).
 */
export function joinNavLabel(model: DispatchModel, sharedNetwork = false) {
  return isFleet(model) || sharedNetwork ? "Inscriptions" : "Réseau";
}

/** Message prêt à coller dans un groupe WhatsApp / Telegram. */
export function joinMessage(orgName: string, url: string, model: DispatchModel) {
  return isFleet(model)
    ? `Rejoignez ${orgName} comme chauffeur VTC sur Rydar Drive${NB}: ${url}`
    : `Rejoignez le réseau ${orgName} sur Rydar Drive : ${url}`;
}

/** Texte joint au lien partagé sur Telegram (le lien est ajouté par Telegram). */
export function joinShareText(orgName: string, model: DispatchModel) {
  return isFleet(model) ? `Rejoignez ${orgName} comme chauffeur VTC sur Rydar Drive` : `Rejoignez le réseau ${orgName} sur Rydar Drive`;
}

/** « … a rejoint le réseau » / « … a rejoint la flotte » (validation d'une candidature, notification). */
export function joinedLabel(model: DispatchModel) {
  return isFleet(model) ? "a rejoint la flotte" : "a rejoint le réseau";
}

/** Aide du réglage « Validation automatique des inscrits ». */
export function autoApproveHelp(model: DispatchModel, autoApprove: boolean) {
  if (!autoApprove) return "Chaque inscrit attend votre validation ci-contre.";
  return isFleet(model)
    ? `Actifs dès l'inscription${NB}: ils reçoivent vos courses comme les chauffeurs que vous créez.`
    : "Actifs dès l'inscription, au niveau « Nouveau » (courses plafonnées).";
}

/** Motifs de refus proposés (le dernier dépend du modèle). */
export function rejectReasons(model: DispatchModel) {
  return ["Carte VTC manquante", "Documents incomplets", "Véhicule non conforme", "Zone non couverte", isFleet(model) ? "Flotte complète" : "Réseau complet"];
}

/** Page publique /rejoindre/{code} : titre, accroche, sous-titre du formulaire, description pour les aperçus de lien. */
export function joinPageCopy(orgName: string, model: DispatchModel, autoApprove: boolean) {
  const fleet = isFleet(model);
  return {
    title: fleet ? `Rejoignez ${orgName}` : `Rejoignez le réseau ${orgName}`,
    lead: `Inscription en 2 minutes. ${
      autoApprove ? "Votre compte est actif dès l'inscription" : fleet ? `${orgName} valide votre profil` : "La centrale valide votre profil"
    }, puis vous recevez les courses dans l'application Rydar Drive.`,
    formSubtitle: `${fleet ? "Chauffeur VTC" : "Chauffeur VTC indépendant"} · ${autoApprove ? "activation immédiate" : `réponse de ${orgName}`}`,
    description: fleet
      ? `Inscrivez-vous comme chauffeur VTC chez ${orgName} sur Rydar Drive.`
      : `Inscrivez-vous comme chauffeur VTC indépendant dans le réseau ${orgName} sur Rydar Drive.`,
  };
}

/** Écran de confirmation après l'inscription (page /rejoindre). */
export function joinSuccessCopy(orgName: string, model: DispatchModel, approved: boolean) {
  const fleet = isFleet(model);
  if (approved) {
    return {
      text: fleet ? `Vous êtes maintenant chauffeur chez ${orgName}.` : `Vous faites maintenant partie du réseau ${orgName}.`,
      online: fleet ? "Vous recevez les courses proches de vous dans l'application." : "Vous recevez les courses proches de vous, avec votre part affichée avant d'accepter.",
    };
  }
  return {
    text: fleet
      ? `Merci${NB}! ${orgName} étudie votre candidature. En attendant, préparez votre compte dans l'application.`
      : "Merci ! La centrale étudie votre candidature. En attendant, préparez votre compte dans l'application.",
    online: null,
  };
}
