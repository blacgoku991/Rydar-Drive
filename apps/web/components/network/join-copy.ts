// Lien d'inscription des chauffeurs (/rejoindre/{code}) : textes selon le modèle de l'organisation.
// Centrale à commission : réseau de chauffeurs indépendants (textes historiques, inchangés). Flotte : aucune mention
// de commission, de part chauffeur ni de « réseau ». Module pur (ni « use client » ni « server-only ») : importable
// par les pages serveur, les composants client et les tests unitaires.
import type { DispatchModel } from "@rydar/shared";

const isFleet = (model: DispatchModel | null | undefined) => model !== "centrale";
/** Espace insécable (avant « : ; ! ? ») des nouveaux textes ; ceux de la centrale restent tels quels. */
const NB = "\u00a0";

/** Entrée du menu du tableau de bord et titre de la page : « Réseau » (centrale) ou « Inscriptions » (flotte). */
export function joinNavLabel(model: DispatchModel | null | undefined) {
  return isFleet(model) ? "Inscriptions" : "Réseau";
}

/** Message prêt à coller dans un groupe WhatsApp / Telegram. */
export function joinMessage(orgName: string, url: string, model: DispatchModel | null | undefined) {
  return isFleet(model)
    ? `Rejoignez ${orgName} comme chauffeur VTC sur Rydar Drive${NB}: ${url}`
    : `Rejoignez le réseau ${orgName} sur Rydar Drive : ${url}`;
}

/** Texte joint au lien partagé sur Telegram (le lien est ajouté par Telegram). */
export function joinShareText(orgName: string, model: DispatchModel | null | undefined) {
  return isFleet(model) ? `Rejoignez ${orgName} comme chauffeur VTC sur Rydar Drive` : `Rejoignez le réseau ${orgName} sur Rydar Drive`;
}

/** « … a rejoint le réseau » / « … a rejoint la flotte » (validation d'une candidature, notification). */
export function joinedLabel(model: DispatchModel | null | undefined) {
  return isFleet(model) ? "a rejoint la flotte" : "a rejoint le réseau";
}

/** Aide du réglage « Validation automatique des inscrits ». */
export function autoApproveHelp(model: DispatchModel | null | undefined, autoApprove: boolean) {
  if (!autoApprove) return "Chaque inscrit attend votre validation ci-contre.";
  return isFleet(model)
    ? `Actifs dès l'inscription${NB}: ils reçoivent vos courses comme les chauffeurs que vous créez.`
    : "Actifs dès l'inscription, au niveau « Nouveau » (courses plafonnées).";
}

/** Motifs de refus proposés (le dernier dépend du modèle). */
export function rejectReasons(model: DispatchModel | null | undefined) {
  return ["Carte VTC manquante", "Documents incomplets", "Véhicule non conforme", "Zone non couverte", isFleet(model) ? "Flotte complète" : "Réseau complet"];
}

/** Page publique /rejoindre/{code} : titre, accroche, sous-titre du formulaire, description pour les aperçus de lien. */
export function joinPageCopy(orgName: string, model: DispatchModel | null | undefined, autoApprove: boolean) {
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
export function joinSuccessCopy(orgName: string, model: DispatchModel | null | undefined, approved: boolean) {
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
