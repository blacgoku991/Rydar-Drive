"use client";
import type {
  ChatMessage, ChatModerationEvent, ChatModerationItem, ChatModerationQueue, ChatOverview, ChatReadEvent, ChatThreadKey, DriverPresence,
  DriverStatus, FleetReportUpdate,
} from "@rydar/shared";
import { MessagesSquare, RadioTower } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  dismissChatReport, fetchChatOverview, fetchModerationQueue, fetchThreadMessages, markChatRead, removeChatMessage, sendChatMessage,
} from "@/app/dashboard/messages/actions";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FLEET_THREAD, driverThread, isUuid, sortDriverThreads, threadHref, type DriverThreadSummary } from "./chat-utils";
import { RemoveMessageDialog, type ModerationBusy } from "./moderation";
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
  initialModeration,
}: {
  orgId: string;
  timeZone: string;
  meId: string;
  fleet: Fleet;
  drivers: DriverThreadSummary[];
  activeDrivers: number;
  initialThread: ChatThreadKey | null;
  initialPage: Page | null;
  /** Messages signalés en attente (null : modération indisponible sur ce serveur) */
  initialModeration: ChatModerationQueue | null;
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
  // Modération du fil flotte : messages signalés, confirmation de suppression, action en cours
  const [moderation, setModeration] = useState<ChatModerationQueue | null>(initialModeration);
  const [confirming, setConfirming] = useState<ChatMessage | null>(null);
  const [moderationBusy, setModerationBusy] = useState<ModerationBusy>(null);
  const moderationTimer = useRef<number | null>(null);

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

  const refreshModeration = useCallback(() => {
    if (moderationTimer.current) window.clearTimeout(moderationTimer.current);
    moderationTimer.current = window.setTimeout(async () => {
      const q = await fetchModerationQueue().catch(() => null);
      if (q) setModeration(q);
    }, 300);
  }, []);
  useEffect(
    () => () => {
      if (moderationTimer.current) window.clearTimeout(moderationTimer.current);
      if (overviewTimer.current) window.clearTimeout(overviewTimer.current);
    },
    [],
  );

  /** Message retiré (ici ou par un autre membre de la centrale) : hors du fil chargé et de la file, résumés relus. */
  const dropMessage = useCallback(
    (id: string) => {
      setThreads((t) => {
        const cur = t[FLEET_THREAD];
        if (!cur?.items.some((x) => x.id === id)) return t;
        return { ...t, [FLEET_THREAD]: { ...cur, items: cur.items.filter((x) => x.id !== id) } };
      });
      setModeration((q) =>
        q && q.items.some((i) => i.message.id === id)
          ? { ...q, open: Math.max(0, q.open - 1), items: q.items.filter((i) => i.message.id !== id) }
          : q,
      );
      refreshOverview();
    },
    [refreshOverview],
  );

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

  /**
   * Relecture de la dernière page du fil ouvert (repli du temps réel) : messages manqués ajoutés, messages disparus
   * retirés (supprimés par un autre membre de la centrale, ou avec le compte de leur auteur, sans aucun événement).
   * Seule la période couverte par la page relue est comparée ; un message arrivé pendant la lecture est conservé.
   */
  const resync = useCallback(async (thread: ChatThreadKey) => {
    const st = threadsRef.current[thread];
    if (!st?.loaded || st.loading) return;
    const res = await fetchThreadMessages(thread, null).catch(() => null);
    if (!res?.ok || !res.messages.length) return;
    const ids = new Set(res.messages.map((m) => m.id));
    const from = res.messages[0]!.created_at;
    const to = res.messages[res.messages.length - 1]!.created_at;
    setThreads((t) => {
      const cur = t[thread];
      if (!cur?.loaded) return t;
      // Page complète (pas de messages plus anciens) : tout message absent a disparu ; sinon, seulement après le plus ancien relu
      const kept = cur.items.filter((m) => ids.has(m.id) || m.created_at > to || (res.hasMore && m.created_at <= from));
      return { ...t, [thread]: { ...cur, items: merge(kept, res.messages) } };
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

  // Retour sur l'onglet : le fil affiché est relu et marqué lu.
  useEffect(() => {
    const onVis = () => {
      if (visible()) refreshModeration();
      const t = selectedRef.current;
      if (!t || !visible()) return;
      void resync(t);
      const unread = t === FLEET_THREAD ? fleetRef.current.unread : (driversRef.current.find((d) => d.thread === t)?.unread ?? 0);
      if (unread > 0) markRead(t);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [markRead, refreshModeration, resync]);
  // Rafraîchissement lent (signalements expirés, présences, messages signalés, fil ouvert) tant que l'onglet est visible.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!visible()) return;
      refreshOverview();
      refreshModeration();
      if (selectedRef.current) void resync(selectedRef.current);
    }, 60_000);
    return () => window.clearInterval(id);
  }, [refreshOverview, refreshModeration, resync]);

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
  // Modération (identifiants seulement) : message signalé, classé ou retiré par un membre de la centrale — la file
  // est relue, un message retiré disparaît du fil (compteurs de la barre latérale : ChatUnreadProvider)
  useRealtimeEvent("chat.moderation", (e: ChatModerationEvent) => {
    if (e?.organization_id !== orgId) return;
    if (e.action === "removed" && e.message_id) dropMessage(e.message_id);
    refreshModeration();
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

  const confirmRemove = async (m: ChatMessage) => {
    setModerationBusy({ id: m.id, action: "remove" });
    const res = await removeChatMessage(m.id).catch(() => ({ ok: false as const, error: "Connexion perdue. Réessayez.", gone: false }));
    setModerationBusy(null);
    if (!res.ok) {
      refreshModeration();
      // Message qui n'existe plus (compte de son auteur supprimé) : retiré de l'affichage, rien d'autre à faire
      if (res.gone) {
        setConfirming(null);
        dropMessage(m.id);
        refreshUnread();
        toast.info(res.error);
        return;
      }
      // Sinon la file est relue (état peut-être dépassé)
      toast.error(res.error);
      return;
    }
    setConfirming(null);
    dropMessage(m.id);
    refreshModeration();
    refreshUnread();
    toast.success(res.code === "ALREADY_REMOVED" ? "Ce message était déjà supprimé." : "Message supprimé pour toute la flotte.");
  };

  /** Élément retiré de la file (le message reste dans le fil). */
  const dropQueued = useCallback((messageId: string) => {
    setModeration((q) =>
      q && q.items.some((i) => i.message.id === messageId)
        ? { ...q, open: Math.max(0, q.open - 1), items: q.items.filter((i) => i.message.id !== messageId) }
        : q,
    );
  }, []);

  const dismiss = async (item: ChatModerationItem) => {
    const id = item.message.id;
    const reportId = item.reports[0]?.id;
    if (!reportId) return;
    setModerationBusy({ id, action: "dismiss" });
    const res = await dismissChatReport(reportId).catch(() => ({ ok: false as const, error: "Connexion perdue. Réessayez.", code: null }));
    setModerationBusy(null);
    if (!res.ok) {
      if (res.code === "MESSAGE_NOT_FOUND") {
        // Supprimé entre-temps avec le compte de son auteur : hors du fil et de la file
        dropMessage(id);
        refreshUnread();
        toast.info("Ce message a déjà été supprimé.");
        return;
      }
      // Signalement effacé avec le compte de son auteur (les autres restent) ou état dépassé : file relue
      refreshModeration();
      if (res.code === "REPORT_NOT_FOUND") toast.info("Ce signalement n'existe plus : la liste a été mise à jour.");
      else toast.error(res.error);
      return;
    }
    refreshModeration();
    refreshUnread();
    if (res.code === "ALREADY_RESOLVED") {
      // Traité entre-temps par un autre membre de la centrale (écran pas encore à jour)
      if (res.status === "removed") {
        dropMessage(id);
        toast.info("Ce message a déjà été supprimé.");
      } else {
        dropQueued(id);
        toast.info(res.status === "dismissed" ? "Ces signalements ont déjà été traités." : "Ce signalement n'est plus en attente.");
      }
      return;
    }
    dropQueued(id);
    toast.success("Signalement ignoré : le message reste visible.");
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
          openReports={moderation?.open ?? 0}
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
            moderation={moderation?.items}
            moderationTotal={moderation?.open ?? 0}
            moderationBusy={moderationBusy}
            onRemove={moderation ? setConfirming : undefined}
            onDismiss={moderation ? (item) => void dismiss(item) : undefined}
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
                  Écrivez à un chauffeur : il reçoit une notification sur son téléphone. Les annonces à toute la flotte
                  s&apos;affichent dans l&apos;application chauffeur, sans notification.
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

      <RemoveMessageDialog
        message={confirming}
        pending={!!confirming && moderationBusy?.id === confirming.id && moderationBusy.action === "remove"}
        onConfirm={(m) => void confirmRemove(m)}
        onClose={() => setConfirming(null)}
      />
    </div>
  );
}
