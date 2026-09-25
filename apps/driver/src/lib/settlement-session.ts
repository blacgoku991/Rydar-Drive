/**
 * État partagé hors rendu React entre l'écran Commissions et les notifications (cf. chat-session.ts) :
 * une notification « commission » touchée alors que l'écran est déjà affiché le rafraîchit
 * au lieu d'en empiler un second.
 */
export const settlementSession = {
  /** Écran Commissions au premier plan. */
  open: false,
};
