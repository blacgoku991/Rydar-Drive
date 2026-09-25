import type { ChatOverview, ChatThreadKey } from "@rydar/shared";
import type { Metadata } from "next";
import { MessagesView } from "@/components/chat/messages-view";
import { FLEET_THREAD, driverThread, isUuid, type DriverThreadSummary } from "@/components/chat/chat-utils";
import { requireOrg } from "@/lib/auth";
import { loadChatOverview, loadThreadPage, type ThreadPage } from "./queries";

export const metadata: Metadata = { title: "Messages" };
export const dynamic = "force-dynamic";

/** Messagerie centrale ⇄ chauffeurs. Contrat d'URL : ?driver=<driver_id> (fil direct) | ?thread=fleet (toute la flotte). */
export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ driver?: string; thread?: string }> }) {
  const ctx = await requireOrg();
  const sp = await searchParams;
  const initialThread: ChatThreadKey | null = sp.thread === FLEET_THREAD ? FLEET_THREAD : isUuid(sp.driver) ? driverThread(sp.driver) : null;

  const [overview, { data: contacts }, initialPage] = await Promise.all([
    loadChatOverview(ctx.supabase, ctx.org.id),
    ctx.supabase
      .from("drivers")
      .select("id, number, first_name, last_name, phone, presence, status, photo_url")
      .eq("organization_id", ctx.org.id),
    initialThread ? loadThreadPage(ctx.supabase, ctx.org.id, initialThread).catch(() => null) : Promise.resolve(null),
  ]);

  const base: ChatOverview = overview ?? {
    organization_id: ctx.org.id,
    fleet: { thread: FLEET_THREAD, last_read_at: null, unread: 0, last_message: null, active_reports: 0 },
    drivers: [],
    unread_total: 0,
  };
  const byId = new Map(((contacts ?? []) as any[]).map((d) => [d.id as string, d]));
  const drivers: DriverThreadSummary[] = base.drivers.map((t) => ({ ...t, phone: byId.get(t.driver.id)?.phone ?? null }));

  // Fil demandé par l'URL pour un chauffeur absent de la liste (inactif sans historique) : on l'ajoute.
  const wanted = sp.driver && initialThread !== FLEET_THREAD ? byId.get(sp.driver) : null;
  if (wanted && !drivers.some((t) => t.driver.id === wanted.id)) {
    drivers.push({
      thread: driverThread(wanted.id),
      driver: {
        id: wanted.id, number: wanted.number, first_name: wanted.first_name, last_name: wanted.last_name,
        presence: wanted.presence, status: wanted.status, photo_url: wanted.photo_url,
      },
      last_message: null,
      last_read_at: null,
      unread: 0,
      driver_last_read_at: null,
      phone: wanted.phone,
    });
  }
  const validThread = initialThread && (initialThread === FLEET_THREAD || drivers.some((t) => t.thread === initialThread)) ? initialThread : null;

  return (
    <MessagesView
      orgId={ctx.org.id}
      timeZone={ctx.org.timezone || "Europe/Paris"}
      meId={ctx.user.id}
      fleet={base.fleet}
      drivers={drivers}
      activeDrivers={((contacts ?? []) as any[]).filter((d) => d.status === "active").length}
      initialThread={validThread}
      initialPage={validThread ? (initialPage as ThreadPage | null) : null}
    />
  );
}
