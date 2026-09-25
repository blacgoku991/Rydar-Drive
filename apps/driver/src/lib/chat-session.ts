/**
 * État partagé hors rendu React entre l'écran Messages et les notifications (cf. offer-session.ts) :
 * pas de bannière en double pour un message qui s'affiche déjà dans le fil ouvert.
 */
export type ChatTab = "dispatch" | "fleet";

export const chatSession = {
  /** Fil affiché à l'écran (écran Messages au premier plan), sinon null. */
  openThread: null as ChatTab | null,
};

/** Notification à taire au premier plan : le fil concerné est déjà affiché. */
export function isChatNotificationMuted(type: unknown) {
  if (type === "chat_message") return chatSession.openThread === "dispatch";
  if (type === "fleet_report") return chatSession.openThread === "fleet";
  return false;
}
