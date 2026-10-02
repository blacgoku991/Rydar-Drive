"use client";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getBrowserClient } from "@/lib/supabase/client";

type Handler = (payload: any) => void;
export type RealtimeStatus = "connecting" | "live" | "offline";
/**
 * `generation` : nombre d'abonnements réussis du canal (1 au premier « SUBSCRIBED »). Une valeur qui augmente ensuite
 * signale un réabonnement après une coupure : des événements ont pu être perdus, les écrans se resynchronisent.
 */
type Ctx = { on: (event: string, handler: Handler) => () => void; status: RealtimeStatus; generation: number };

const RealtimeContext = createContext<Ctx | null>(null);
const EVENTS = [
  "driver.location", "driver.updated", "ride.updated", "offer.updated", "ride.event",
  // alertes de suivi (002200), messagerie et signalements (002300), documents chauffeur (002400)
  "ride.alert", "chat.message", "chat.report", "chat.read", "driver.document",
  // modération du fil « Chauffeurs » (004100) : message signalé, classé ou retiré (identifiants seulement)
  "chat.moderation",
] as const;

/**
 * Mode centrale (002600) : règlements, candidatures par lien (page Réseau), appareil d'un compte banni ;
 * frais plateforme dus à Rydar (20260924003000) : paiement confirmé / refusé, relance, avoir…
 */
const CENTRALE_EVENTS = ["settlement.updated", "driver.application", "driver.flagged", "platform.updated"] as const;

/** Canal privé org:{id} (Broadcast from database, autorisé par la RLS sur realtime.messages). */
export function RealtimeProvider({ topic, children }: { topic: string; children: React.ReactNode }) {
  const handlers = useRef(new Map<string, Set<Handler>>());
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const supabase = getBrowserClient();
    let channel: RealtimeChannel | null = null;
    let disposed = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) await supabase.realtime.setAuth(data.session.access_token);
      if (disposed) return;
      const ch = supabase.channel(topic, { config: { private: true } });
      channel = ch;
      for (const event of new Set<string>([...EVENTS, ...CENTRALE_EVENTS])) {
        ch.on("broadcast", { event }, (message: { payload: unknown }) => {
          handlers.current.get(event)?.forEach((h) => h(message.payload));
        });
      }
      ch.subscribe((s: string) => {
        if (disposed) return;
        if (s === "SUBSCRIBED") {
          setStatus("live");
          setGeneration((g) => g + 1);
        } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") setStatus("offline");
      });
    })();
    const timeout = setTimeout(() => setStatus((s) => (s === "connecting" ? "offline" : s)), 8000);
    return () => {
      disposed = true;
      clearTimeout(timeout);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [topic]);

  const on = useCallback((event: string, handler: Handler) => {
    const set = handlers.current.get(event) ?? new Set();
    set.add(handler);
    handlers.current.set(event, set);
    return () => {
      set.delete(handler);
    };
  }, []);

  // Valeur stable : un rendu du fournisseur (router.refresh) ne réabonne pas tous les écouteurs
  const value = useMemo(() => ({ on, status, generation }), [on, status, generation]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtimeStatus(): RealtimeStatus {
  return useContext(RealtimeContext)?.status ?? "offline";
}

/** Nombre d'abonnements réussis du canal (0 tant qu'aucun ; augmente à chaque reconnexion). */
export function useRealtimeGeneration(): number {
  return useContext(RealtimeContext)?.generation ?? 0;
}

export function useRealtimeEvent(event: string, handler: Handler) {
  const on = useContext(RealtimeContext)?.on;
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!on) return;
    return on(event, (p) => ref.current(p));
  }, [on, event]);
}
