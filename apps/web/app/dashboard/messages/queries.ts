import "server-only";
import type { ChatMessage, ChatMessageRow, ChatOverview, ChatThreadKey } from "@rydar/shared";
import { CHAT_PAGE_SIZE, threadDriverId, toChatMessage } from "@/components/chat/chat-utils";

type Supa = { from: (t: string) => any; rpc: (fn: string, args?: Record<string, unknown>) => any };

export type ThreadPage = { messages: ChatMessage[]; hasMore: boolean };

/** Dernière page d'un fil (ordre chronologique), éventuellement avant un horodatage. */
export async function loadThreadPage(supabase: Supa, orgId: string, thread: ChatThreadKey, before?: string | null): Promise<ThreadPage> {
  const driverId = threadDriverId(thread);
  let q = supabase.from("chat_messages").select("*").eq("organization_id", orgId);
  q = driverId ? q.eq("channel", "driver").eq("driver_id", driverId) : q.eq("channel", "fleet");
  if (before) q = q.lt("created_at", before);
  const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(CHAT_PAGE_SIZE + 1);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ChatMessageRow[];
  const now = Date.now();
  return { messages: rows.slice(0, CHAT_PAGE_SIZE).reverse().map((r) => toChatMessage(r, now)), hasMore: rows.length > CHAT_PAGE_SIZE };
}

export async function loadChatOverview(supabase: Supa, orgId: string): Promise<ChatOverview | null> {
  const { data, error } = await supabase.rpc("chat_overview", { p_org: orgId });
  if (error || !data) return null;
  return data as ChatOverview;
}
