import type { DriverHome, DriverOffer } from "@rydar/shared";
import type { RealtimeChannel, Session } from "@supabase/supabase-js";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Vibration } from "react-native";
import { api } from "@/lib/api";
import { startTracking, stopTracking } from "@/lib/location";
import { registerForPush, setupNotificationChannels, unregisterPush } from "@/lib/notifications";
import { supabase } from "@/lib/supabase";

type Ctx = {
  session: Session | null;
  ready: boolean;
  home: DriverHome | null;
  offers: DriverOffer[];
  refresh: () => Promise<void>;
  setOnline: (online: boolean) => Promise<{ ok: boolean; message?: string }>;
  signOut: () => Promise<void>;
  busy: boolean;
};

const DriverContext = createContext<Ctx | null>(null);

export function DriverProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [home, setHome] = useState<DriverHome | null>(null);
  const [offers, setOffers] = useState<DriverOffer[]>([]);
  const [busy, setBusy] = useState(false);
  const seenOffers = useRef(new Set<string>());
  const channelRef = useRef<RealtimeChannel | null>(null);

  // Session
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const openOffer = useCallback((offer: DriverOffer) => {
    if (seenOffers.current.has(offer.offer_id)) return;
    seenOffers.current.add(offer.offer_id);
    if (offer.mode === "geo") router.push({ pathname: "/offer/[id]", params: { id: offer.offer_id } });
    else Vibration.vibrate([0, 200, 120, 200]);
  }, []);

  const refresh = useCallback(async () => {
    if (!session) return;
    const [h, o] = await Promise.all([api.home().catch(() => null), api.offers().catch(() => null)]);
    if (h) setHome(h);
    if (o) {
      setOffers(o);
      const fresh = o.find((x) => x.mode === "geo" && !seenOffers.current.has(x.offer_id));
      if (fresh) openOffer(fresh);
    }
  }, [session, openOffer]);

  // Initialisation après connexion : canaux, push, données, temps réel
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      await setupNotificationChannels().catch(() => null);
      await registerForPush().catch(() => null);
      await refresh();
      const h = await api.home().catch(() => null);
      if (cancelled || !h) return;
      if (h.driver.presence !== "offline") startTracking().catch(() => null);
      await supabase.realtime.setAuth(session.access_token);
      const ch = supabase.channel(`driver:${h.driver.id}`, { config: { private: true } });
      ch.on("broadcast", { event: "offer.updated" }, () => void refresh())
        .on("broadcast", { event: "ride.updated" }, () => void refresh())
        .on("broadcast", { event: "ride.unassigned" }, () => void refresh())
        .on("broadcast", { event: "driver.updated" }, () => void refresh())
        .subscribe();
      channelRef.current = ch;
    })();
    return () => {
      cancelled = true;
      if (channelRef.current) void supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    };
  }, [session, refresh]);

  // Repli : rafraîchissement périodique quand l'app est active et le chauffeur en ligne
  useEffect(() => {
    if (!session) return;
    const id = setInterval(() => {
      if (AppState.currentState === "active" && home?.driver.presence !== "offline") void refresh();
    }, 8000);
    const sub = AppState.addEventListener("change", (s) => s === "active" && void refresh());
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [session, home?.driver.presence, refresh]);

  // Notifications : réception au premier plan + actions (ACCEPTER / Refuser / ouverture)
  useEffect(() => {
    if (!session) return;
    const received = Notifications.addNotificationReceivedListener((n) => {
      const data = n.request.content.data as Record<string, any>;
      if (data?.type === "ride_offer") void refresh();
      if (data?.type === "ride_cancelled" || data?.type === "ride_assigned" || data?.type === "ride_unassigned") void refresh();
    });
    const response = Notifications.addNotificationResponseReceivedListener(async (r) => {
      const data = r.notification.request.content.data as Record<string, any>;
      if (r.actionIdentifier === "ACCEPT" && data?.offer_id) {
        const res = await api.accept(String(data.offer_id)).catch(() => null);
        await refresh();
        if (res?.ok && res.ride_id) router.push({ pathname: "/ride/[id]", params: { id: String(res.ride_id) } });
        else router.push({ pathname: "/offer/[id]", params: { id: String(data.offer_id) } });
        return;
      }
      if (r.actionIdentifier === "DECLINE" && data?.offer_id) {
        await api.decline(String(data.offer_id)).catch(() => null);
        return;
      }
      if (data?.offer_id) router.push({ pathname: "/offer/[id]", params: { id: String(data.offer_id) } });
      else if (data?.ride_id) router.push({ pathname: "/ride/[id]", params: { id: String(data.ride_id) } });
    });
    return () => {
      received.remove();
      response.remove();
    };
  }, [session, refresh]);

  const setOnline = useCallback(async (online: boolean) => {
    setBusy(true);
    try {
      if (online) {
        const perm = await startTracking();
        const res = await api.setOnline(true);
        await refresh();
        return { ok: res.ok, message: perm === "foreground-only" ? "Autorisez « Toujours » la localisation pour rester en ligne application fermée." : undefined };
      }
      const res = await api.setOnline(false);
      if (res.ok) await stopTracking();
      await refresh();
      return { ok: res.ok, message: res.message };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api.setOnline(false).catch(() => null);
    await stopTracking().catch(() => null);
    await unregisterPush();
    await supabase.auth.signOut();
    setHome(null);
    setOffers([]);
    seenOffers.current.clear();
  }, []);

  const value = useMemo(() => ({ session, ready, home, offers, refresh, setOnline, signOut, busy }), [session, ready, home, offers, refresh, setOnline, signOut, busy]);
  return <DriverContext.Provider value={value}>{children}</DriverContext.Provider>;
}

export function useDriver() {
  const ctx = useContext(DriverContext);
  if (!ctx) throw new Error("useDriver hors DriverProvider");
  return ctx;
}
