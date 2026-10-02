"use server";
import {
  extractErrorCode, type ChatMessage, type ChatModerationQueue, type ChatOverview, type ChatThreadKey,
  type DismissChatReportResult, type RemoveChatMessageResult,
} from "@rydar/shared";
import { CHAT_MAX_LENGTH, chatErrorMessage, isThreadKey, isUuid, threadDriverId, toChatMessage } from "@/components/chat/chat-utils";
import { getOrgContext } from "@/lib/org-context";
import { loadChatCounts, loadChatOverview, loadModerationQueue, loadThreadPage, type ThreadPage } from "./queries";

type Fail = { ok: false; error: string };

/** Vue d'ensemble (liste des fils + non-lus) de l'organisation active. */
export async function fetchChatOverview(): Promise<ChatOverview | null> {
  const ctx = await getOrgContext();
  if (!ctx) return null;
  return loadChatOverview(ctx.supabase, ctx.org.id);
}

/**
 * Compteurs de la barre latérale : messages non lus, et messages du fil flotte signalés par les chauffeurs en
 * attente de décision (public.chat_counts : sans relire toute la liste des fils).
 */
export async function fetchChatUnread(): Promise<{ unread: number; openReports: number } | null> {
  const ctx = await getOrgContext();
  if (!ctx) return null;
  return loadChatCounts(ctx.supabase, ctx.org.id);
}

export async function fetchThreadMessages(thread: string, before?: string | null): Promise<({ ok: true } & ThreadPage) | Fail> {
  if (!isThreadKey(thread)) return { ok: false, error: "Conversation introuvable." };
  if (before != null && Number.isNaN(Date.parse(before))) return { ok: false, error: "Curseur invalide." };
  const ctx = await getOrgContext();
  if (!ctx) return { ok: false, error: "Accès refusé." };
  try {
    return { ok: true, ...(await loadThreadPage(ctx.supabase, ctx.org.id, thread, before)) };
  } catch {
    return { ok: false, error: "Impossible de charger la conversation." };
  }
}

export async function sendChatMessage(thread: string, body: string): Promise<{ ok: true; message: ChatMessage } | Fail> {
  if (!isThreadKey(thread)) return { ok: false, error: "Conversation introuvable." };
  const text = String(body ?? "").trim();
  if (!text) return { ok: false, error: "Le message est vide." };
  if (text.length > CHAT_MAX_LENGTH) return { ok: false, error: `Message trop long (${CHAT_MAX_LENGTH} caractères maximum).` };
  const ctx = await getOrgContext();
  if (!ctx) return { ok: false, error: "Accès refusé." };
  const driverId = threadDriverId(thread);
  const { data, error } = await ctx.supabase.rpc("send_chat_message", {
    p_org: ctx.org.id,
    p_channel: driverId ? "driver" : "fleet",
    p_driver_id: driverId,
    p_body: text,
  });
  if (error || !data) return { ok: false, error: chatErrorMessage(error) };
  return { ok: true, message: toChatMessage(data as ChatMessage) };
}

export async function markChatRead(thread: string): Promise<{ ok: true; thread: ChatThreadKey; last_read_at: string } | Fail> {
  if (!isThreadKey(thread)) return { ok: false, error: "Conversation introuvable." };
  const ctx = await getOrgContext();
  if (!ctx) return { ok: false, error: "Accès refusé." };
  const { data, error } = await ctx.supabase.rpc("mark_chat_read", { p_org: ctx.org.id, p_thread: thread });
  if (error || !data) return { ok: false, error: chatErrorMessage(error, "Impossible de marquer comme lu.") };
  return data as { ok: true; thread: ChatThreadKey; last_read_at: string };
}

// ---------------------------------------------------------------- Modération du fil « Toute la flotte »
// La centrale modère son fil : Rydar Drive fournit l'outil (20260924004100_chat_moderation).

/** Messages signalés en attente de décision. */
export async function fetchModerationQueue(): Promise<ChatModerationQueue | null> {
  const ctx = await getOrgContext();
  if (!ctx) return null;
  return loadModerationQueue(ctx.supabase, ctx.org.id);
}

/**
 * Supprime un message du fil flotte : masqué pour tous, ses signalements sont clos.
 * gone : le message n'existe plus du tout (compte de son auteur supprimé, purge) : à retirer de l'affichage.
 */
export async function removeChatMessage(messageId: string): Promise<RemoveChatMessageResult | (Fail & { gone?: boolean })> {
  if (!isUuid(messageId)) return { ok: false, error: "Message introuvable." };
  const ctx = await getOrgContext();
  if (!ctx) return { ok: false, error: "Accès refusé." };
  const { data, error } = await ctx.supabase.rpc("remove_chat_message", { p_message: messageId });
  if (error || !data) {
    const gone = extractErrorCode(error?.message) === "MESSAGE_NOT_FOUND";
    return { ok: false, error: chatErrorMessage(error, "Suppression impossible. Réessayez."), gone };
  }
  return data as RemoveChatMessageResult;
}

/**
 * « Ignorer » : le message est jugé acceptable, tous ses signalements ouverts sont classés.
 * Échec : code MESSAGE_NOT_FOUND (message supprimé entre-temps avec le compte de son auteur : à retirer de
 * l'affichage) ou REPORT_NOT_FOUND (signalement effacé avec le compte de son auteur : file à relire).
 */
export async function dismissChatReport(reportId: string): Promise<DismissChatReportResult | (Fail & { code: string | null })> {
  if (!isUuid(reportId)) return { ok: false, error: "Signalement introuvable.", code: null };
  const ctx = await getOrgContext();
  if (!ctx) return { ok: false, error: "Accès refusé.", code: null };
  const { data, error } = await ctx.supabase.rpc("dismiss_chat_report", { p_report: reportId });
  if (error || !data) {
    return { ok: false, error: chatErrorMessage(error, "Action impossible. Réessayez."), code: extractErrorCode(error?.message) ?? null };
  }
  return data as DismissChatReportResult;
}
