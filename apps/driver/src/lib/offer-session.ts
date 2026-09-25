/**
 * État partagé entre les notifications (contexte chauffeur) et l'écran d'offre, hors rendu React.
 */
export const offerSession = {
  /** Offre affichée à l'écran : une seule à la fois (pas de second écran ni de double sonnerie). */
  openId: null as string | null,
  /** Offres acceptées depuis le bouton ACCEPTER de la notification (l'écran affiche « Course attribuée »). */
  accepted: new Set<string>(),
};
