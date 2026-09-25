"use server";
import type { ChatMessage, ChatOverview, ChatThreadKey } from "@rydar/shared";
import { CHAT_MAX_LENGTH, chatErrorMessage, isThreadKey, threadDriverId, toChatMessage } from "@/components/chat/chat-utils";
import { getOrgContext } from "@/lib/org-context";
import { loadChatOverview, loadThreadPage, type ThreadPage } from "./queries";

type Fail = { ok: false; error: string };

/** Vue d'ensemble (liste des fils + non-lus) de l'organisation active. */
export async function fetchChatOverview(): Promise<ChatOverview | null> {
  const ctx = await getOrgContext();
  if (!ctx) return null;
  return loadChatOverview(ctx.supabase, ctx.org.id);
}

/** Compteur de non-lus de la barre latérale. */
export async function fetchChatUnread(): Promise<number | null> {
  const overview = await fetchChatOverview();
  return overview ? overview.unread_total : null;
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
