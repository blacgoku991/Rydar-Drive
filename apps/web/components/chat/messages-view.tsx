"use client";
import type { ChatMessage, ChatOverview, ChatReadEvent, ChatThreadKey, DriverPresence, DriverStatus, FleetReportUpdate } from "@rydar/shared";
import { MessagesSquare, RadioTower } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchChatOverview, fetchThreadMessages, markChatRead, sendChatMessage } from "@/app/dashboard/messages/actions";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FLEET_THREAD, driverThread, isUuid, sortDriverThreads, threadHref, type DriverThreadSummary } from "./chat-utils";
import { ThreadList } from "./thread-list";
import { ThreadPane, type ThreadState } from "./thread-pane";
import { useChatUnread } from "./unread-provider";

type Fleet = ChatOverview["fleet"];
type Page = { messages: ChatMessage[]; hasMore: boolean };

const EMPTY: ThreadState = { items: [], hasMore: false, loading: false, loaded: false };

const isActiveReport = (m: Pick<ChatMessage, "report_type" | "expires_at">) =>
  !!m.report_type && !!m.expires_at && new Date(m.expires_at).getTime() > Date.now();

/** Fusion sans doublon, ordre chronologique. */
function merge(a: ChatMessage[], b: ChatMessage[]) {
  const map = new Map(a.map((m) => [m.id, m]));
  for (const m of b) map.set(m.id, { ...map.get(m.id), ...m });
  return [...map.values()].sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id.localeCompare(y.id));
}

const newer = (a: ChatMessage | null, b: ChatMessage) => (!a || b.created_at >= a.created_at ? b : a);

/** Fil demandé par l'URL : ?driver=<id> | ?thread=fleet */
function threadFromParams(sp: { get(name: string): string | null } | null): ChatThreadKey | null {
  if (!sp) return null;
  if (sp.get("thread") === FLEET_THREAD) return FLEET_THREAD;
  const id = sp.get("driver");
  return isUuid(id) ? driverThread(id) : null;
}

export function MessagesView({
  orgId,
  timeZone,
  meId,
  fleet: fleet0,
  drivers: drivers0,
  activeDrivers,
  initialThread,
  initialPage,
}: {
  orgId: string;
  timeZone: string;
  meId: string;
  fleet: Fleet;
  drivers: DriverThreadSummary[];
  activeDrivers: number;
  initialThread: ChatThreadKey | null;
  initialPage: Page | null;
}) {
  const sp = useSearchParams();
  const selected = threadFromParams(sp);
  const [fleet, setFleet] = useState<Fleet>(fleet0);
  const [drivers, setDrivers] = useState<DriverThreadSummary[]>(drivers0);
  const [threads, setThreads] = useState<Record<string, ThreadState>>(() =>
    initialThread && initialPage ? { [initialThread]: { items: initialPage.messages, hasMore: initialPage.hasMore, loading: false, loaded: true } } : {},
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [sending, setSending] = useState(false);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const { setOpenThread, refresh: refreshUnread } = useChatUnread();

  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const driversRef = useRef(drivers);
  driversRef.current = drivers;
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const fleetRef = useRef(fleet);
  fleetRef.current = fleet;
  const counted = useRef(new Set<string>());
  const readTimers = useRef(new Map<string, number>());
  const overviewTimer = useRef<number | null>(null);
  const fromList = useRef(false);

  // Nouvelles props serveur (navigation vers ?driver=… d'un chauffeur absent) : on complète la liste.
  useEffect(() => {
    setDrivers((list) => {
      const missing = drivers0.filter((t) => !list.some((x) => x.thread === t.thread));
      return missing.length ? [...list, ...missing] : list;
    });
    if (initialThread && initialPage) {
      setThreads((t) => (t[initialThread]?.loaded ? t : { ...t, [initialThread]: { items: initialPage.messages, hasMore: initialPage.hasMore, loading: false, loaded: true } }));
    }
  }, [drivers0, initialThread, initialPage]);

  // Horloge (âges, « expire dans… »)
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

  const patchThread = useCallback((thread: string, fn: (s: Fleet | DriverThreadSummary) => Partial<Fleet & DriverThreadSummary>) => {
    if (thread === FLEET_THREAD) setFleet((f) => ({ ...f, ...(fn(f) as Partial<Fleet>) }));
    else setDrivers((list) => list.map((d) => (d.thread === thread ? { ...d, ...(fn(d) as Partial<DriverThreadSummary>) } : d)));
  }, []);

  const refreshOverview = useCallback(() => {
    if (overviewTimer.current) window.clearTimeout(overviewTimer.current);
    overviewTimer.current = window.setTimeout(async () => {
      const res = await fetchChatOverview().catch(() => null);
      if (!res) return;
      const open = visible() ? selectedRef.current : null;
      setFleet(open === FLEET_THREAD ? { ...res.fleet, unread: 0 } : res.fleet);
      setDrivers((prev) => {
        const phones = new Map(prev.map((d) => [d.driver.id, d.phone ?? null]));
        const next: DriverThreadSummary[] = res.drivers.map((d) => ({ ...d, phone: phones.get(d.driver.id) ?? null, unread: d.thread === open ? 0 : d.unread }));
        for (const p of prev) if (!next.some((n) => n.thread === p.thread)) next.push(p);
        return next;
      });
    }, 400);
  }, []);

  const markRead = useCallback(
    (thread: ChatThreadKey) => {
      patchThread(thread, () => ({ unread: 0 }));
      const timers = readTimers.current;
      window.clearTimeout(timers.get(thread));
      timers.set(
        thread,
        window.setTimeout(async () => {
          const res = await markChatRead(thread).catch(() => null);
          if (res?.ok) {
            patchThread(thread, () => ({ unread: 0, last_read_at: res.last_read_at }));
            refreshUnread();
          }
        }, 250),
      );
    },
    [patchThread, refreshUnread],
  );

  const load = useCallback(async (thread: ChatThreadKey, before?: string) => {
    setThreads((t) => ({ ...t, [thread]: { ...(t[thread] ?? EMPTY), loading: true, error: undefined } }));
    const res = await fetchThreadMessages(thread, before ?? null).catch(() => ({ ok: false as const, error: "Connexion perdue. Réessayez." }));
    setThreads((t) => {
      const cur = t[thread] ?? EMPTY;
      if (!res.ok) return { ...t, [thread]: { ...cur, loading: false, error: res.error } };
      return { ...t, [thread]: { items: merge(cur.items, res.messages), hasMore: res.hasMore, loading: false, loaded: true } };
    });
  }, []);

  // Ouverture d'un fil : chargement, marquage lu, fil « ouvert » pour le compteur global.
  useEffect(() => {
    setOpenThread(selected);
    if (!selected) return;
    const st = threadsRef.current[selected];
    if (!st?.loaded && !st?.loading) void load(selected);
    markRead(selected);
    if (selected !== FLEET_THREAD && !driversRef.current.some((d) => d.thread === selected)) refreshOverview();
  }, [selected, setOpenThread, load, markRead, refreshOverview]);
  useEffect(() => () => setOpenThread(null), [setOpenThread]);

  // Retour sur l'onglet : le fil affiché est lu.
  useEffect(() => {
    const onVis = () => {
      const t = selectedRef.current;
      if (!t || !visible()) return;
      const unread = t === FLEET_THREAD ? fleetRef.current.unread : (driversRef.current.find((d) => d.thread === t)?.unread ?? 0);
      if (unread > 0) markRead(t);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [markRead]);
  // Rafraîchissement lent (signalements expirés, présences) tant que l'onglet est visible.
  useEffect(() => {
    const id = window.setInterval(() => visible() && refreshOverview(), 60_000);
    return () => window.clearInterval(id);
  }, [refreshOverview]);

  /** Nouveau message (envoi ou temps réel) → fil + résumé + non-lus. */
  const ingest = useCallback(
    (raw: ChatMessage) => {
      if (!raw?.id || !raw.thread) return;
      const m: ChatMessage = { ...raw, active: isActiveReport(raw) };
      setThreads((t) => {
        const cur = t[m.thread];
        if (!cur?.loaded) return t;
        return { ...t, [m.thread]: { ...cur, items: merge(cur.items, [m]) } };
      });
      if (m.thread !== FLEET_THREAD && !driversRef.current.some((d) => d.thread === m.thread)) {
        refreshOverview();
        return;
      }
      if (counted.current.has(m.id)) return;
      counted.current.add(m.id);
      const mine = m.author_type === "user" && m.author_user_id === meId;
      const openVisible = selectedRef.current === m.thread && visible();
      patchThread(m.thread, (s) => ({
        last_message: newer(s.last_message, m),
        unread: mine || openVisible ? s.unread : s.unread + 1,
        ...(m.thread === FLEET_THREAD && m.active ? { active_reports: ((s as Fleet).active_reports ?? 0) + 1 } : {}),
      }));
      if (!mine && openVisible) markRead(m.thread);
    },
    [meId, patchThread, markRead, refreshOverview],
  );

  useRealtimeEvent("chat.message", (m: ChatMessage) => {
    if (m?.organization_id === orgId) ingest(m);
  });
  useRealtimeEvent("chat.report", (u: FleetReportUpdate) => {
    if (u?.organization_id !== orgId) return;
    setThreads((t) => {
      const cur = t[FLEET_THREAD];
      if (!cur?.loaded) return t;
      return {
        ...t,
        [FLEET_THREAD]: {
          ...cur,
          items: cur.items.map((x) => (x.id === u.id ? { ...x, expires_at: u.expires_at, confirmations: u.confirmations, dismissals: u.dismissals, active: u.active } : x)),
        },
      };
    });
    refreshOverview();
  });
  useRealtimeEvent("chat.read", (e: ChatReadEvent) => {
    if (e?.organization_id !== orgId) return;
    if (e.reader_type === "driver") {
      setDrivers((list) =>
        list.map((d) =>
          d.thread === e.thread && (!d.driver_last_read_at || e.last_read_at > d.driver_last_read_at) ? { ...d, driver_last_read_at: e.last_read_at } : d,
        ),
      );
    } else if (e.reader_key === `user:${meId}`) {
      patchThread(e.thread, () => ({ unread: 0, last_read_at: e.last_read_at }));
    }
  });
  useRealtimeEvent("driver.updated", (p: { id: string; presence?: DriverPresence; status?: DriverStatus; first_name?: string; last_name?: string }) => {
    if (!p?.id) return;
    setDrivers((list) =>
      list.map((d) =>
        d.driver.id === p.id
          ? {
              ...d,
              driver: {
                ...d.driver,
                presence: p.presence ?? d.driver.presence,
                status: p.status ?? d.driver.status,
                first_name: p.first_name ?? d.driver.first_name,
                last_name: p.last_name ?? d.driver.last_name,
              },
            }
          : d,
      ),
    );
  });

  const select = (thread: ChatThreadKey) => {
    if (thread === selectedRef.current) return;
    const url = threadHref(thread);
    if (selectedRef.current) window.history.replaceState(null, "", url);
    else {
      fromList.current = true;
      window.history.pushState(null, "", url);
    }
  };
  const back = () => {
    if (fromList.current) {
      fromList.current = false;
      window.history.back();
    } else window.history.replaceState(null, "", "/dashboard/messages");
  };

  const send = async (text: string, fromComposer: boolean) => {
    const thread = selectedRef.current;
    if (!thread || sending) return;
    setSending(true);
    setErrors((e) => ({ ...e, [thread]: null }));
    const res = await sendChatMessage(thread, text).catch(() => ({ ok: false as const, error: "Connexion perdue. Réessayez." }));
    setSending(false);
    if (!res.ok) {
      setErrors((e) => ({ ...e, [thread]: res.error }));
      return;
    }
    if (fromComposer) setDrafts((d) => ({ ...d, [thread]: "" }));
    ingest(res.message);
  };

  const sorted = useMemo(() => sortDriverThreads(drivers), [drivers]);
  const unreadTotal = fleet.unread + drivers.reduce((n, d) => n + (d.unread || 0), 0);
  const driverSummary = selected && selected !== FLEET_THREAD ? (drivers.find((d) => d.thread === selected) ?? null) : null;
  const unknownDriver = !!selected && selected !== FLEET_THREAD && !driverSummary;
  const nothingYet = !fleet.last_message && drivers.every((d) => !d.last_message);

  return (
    <div className="flex h-[calc(100dvh-56px)] overflow-hidden lg:h-dvh">
      <aside className={cn("min-w-0 flex-col border-line bg-ink-950/40 lg:flex lg:w-[340px] lg:shrink-0 lg:border-r xl:w-[360px]", selected ? "hidden" : "flex w-full")}>
        <ThreadList
          fleet={fleet}
          drivers={sorted}
          selected={selected}
          onSelect={select}
          query={query}
          onQuery={setQuery}
          meId={meId}
          timeZone={timeZone}
          now={now}
          unreadTotal={unreadTotal}
        />
      </aside>

      <section className={cn("min-w-0 flex-1 flex-col", selected ? "flex" : "hidden lg:flex")}>
        {selected && !unknownDriver ? (
          <ThreadPane
            key={selected}
            thread={selected}
            fleet={fleet}
            driver={driverSummary}
            state={threads[selected]}
            meId={meId}
            timeZone={timeZone}
            now={now}
            activeDrivers={activeDrivers}
            draft={drafts[selected] ?? ""}
            onDraft={(v) => {
              setDrafts((d) => ({ ...d, [selected]: v }));
              if (errors[selected]) setErrors((e) => ({ ...e, [selected]: null }));
            }}
            onSend={send}
            sending={sending}
            error={errors[selected] ?? null}
            onLoadOlder={() => {
              const first = threads[selected]?.items[0];
              if (first) void load(selected, first.created_at);
            }}
            onBack={back}
          />
        ) : (
          <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 text-center">
            <div className="grid-bg pointer-events-none absolute inset-0 opacity-40 [mask-image:radial-gradient(closest-side,black,transparent)]" />
            <div className="relative mb-5 grid size-16 place-items-center rounded-2xl border border-line-strong bg-ink-700 text-fg-muted">
              <div className="absolute inset-0 rounded-2xl bg-brand/10 blur-xl" />
              <MessagesSquare className="relative size-7" />
            </div>
            {unknownDriver ? (
              <>
                <p className="relative text-[15px] font-semibold">Conversation introuvable</p>
                <p className="relative mt-1.5 max-w-sm text-[13px] text-fg-muted">Ce chauffeur ne fait pas (ou plus) partie de votre flotte.</p>
              </>
            ) : nothingYet ? (
              <>
                <p className="relative text-[15px] font-semibold">Aucun message pour l&apos;instant</p>
                <p className="relative mt-1.5 max-w-sm text-[13px] text-fg-muted">
                  Écrivez à un chauffeur ou à toute la flotte : ils reçoivent une notification sur leur téléphone.
                </p>
              </>
            ) : (
              <>
                <p className="relative text-[15px] font-semibold">Choisissez une conversation</p>
                <p className="relative mt-1.5 max-w-sm text-[13px] text-fg-muted">
                  Les messages des chauffeurs et les signalements de la flotte arrivent ici en temps réel.
                </p>
              </>
            )}
            <Button variant="secondary" size="sm" className="relative mt-5" onClick={() => select(FLEET_THREAD)}>
              <RadioTower /> Écrire à toute la flotte
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
