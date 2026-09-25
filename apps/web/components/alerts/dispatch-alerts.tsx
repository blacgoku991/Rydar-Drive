"use client";
// Alertes du rattacheur : toasts riches + sons + notifications du navigateur + cloche avec non-lus.
// Sources : diffusions temps réel `ride.updated` (nouvelles courses) et `ride.event` (acceptation,
// aucun chauffeur, bascule GPS d'une planifiée, annulation par l'API).
import { formatPrice, formatRideDate, shortAddress } from "@rydar/shared";
import { AlertTriangle, Bell, BellOff, BellRing, CheckCircle2, CircleSlash, Clock3, Globe, KeyRound, Monitor, RotateCw, Volume2, VolumeX, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Popover as P } from "radix-ui";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { redispatchRide } from "@/app/dashboard/rides/actions";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { playSound, unlockAudio, type SoundKind } from "@/lib/sounds";
import { cn } from "@/lib/utils";

export type AlertKind = "new" | "accepted" | "no_driver" | "escalated" | "cancelled";
export type AlertItem = { id: string; kind: AlertKind; title: string; body: string; rideId: string | null; at: string; read: boolean; source?: string };

type RideInfo = { number: number; pickup: string; dropoff: string; price: number | null; type: string; pickupAt: string; source: string };

const META: Record<AlertKind, { icon: typeof Bell; color: string; sound: SoundKind | null; desktop: boolean; sticky: boolean }> = {
  new: { icon: BellRing, color: "var(--color-brand)", sound: "new", desktop: true, sticky: false },
  accepted: { icon: CheckCircle2, color: "var(--color-green)", sound: "accepted", desktop: false, sticky: false },
  no_driver: { icon: AlertTriangle, color: "var(--color-red)", sound: "alert", desktop: true, sticky: true },
  escalated: { icon: Clock3, color: "var(--color-amber)", sound: "alert", desktop: true, sticky: false },
  cancelled: { icon: CircleSlash, color: "var(--color-fg-muted)", sound: null, desktop: false, sticky: false },
};

const SOURCE: Record<string, { label: string; icon: typeof Globe }> = {
  api: { label: "Site web (API)", icon: KeyRound },
  booking_site: { label: "Mini-site", icon: Globe },
  dashboard: { label: "Dashboard", icon: Monitor },
};

type Ctx = {
  items: AlertItem[];
  unread: number;
  sound: boolean;
  setSound: (on: boolean) => void;
  desktop: NotificationPermission | "unsupported";
  enableDesktop: () => void;
  markAllRead: () => void;
  clear: () => void;
  focusRide: (id: string) => void;
};
const AlertsContext = createContext<Ctx | null>(null);

const STORE_KEY = "rydar.alerts";
const SOUND_KEY = "rydar.sound";

function read<T>(storage: () => Storage, key: string, fallback: T): T {
  try {
    const v = storage().getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function write(storage: () => Storage, key: string, value: unknown) {
  try {
    storage().setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible */
  }
}

export function AlertsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState<AlertItem[]>([]);
  const [sound, setSoundState] = useState(true);
  const [desktop, setDesktop] = useState<Ctx["desktop"]>("unsupported");
  const rides = useRef(new Map<string, RideInfo>());
  const seen = useRef(new Set<string>());
  const soundRef = useRef(sound);
  soundRef.current = sound;

  useEffect(() => {
    setItems(read(() => window.sessionStorage, STORE_KEY, [] as AlertItem[]));
    setSoundState(read(() => window.localStorage, SOUND_KEY, true));
    setDesktop(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
  useEffect(() => write(() => window.sessionStorage, STORE_KEY, items.slice(0, 40)), [items]);

  const focusRide = useCallback(
    (id: string) => {
      if (pathname === "/dashboard") window.dispatchEvent(new CustomEvent("rydar:focus-ride", { detail: id }));
      else router.push(`/dashboard?ride=${id}`);
    },
    [pathname, router],
  );
  const focusRef = useRef(focusRide);
  focusRef.current = focusRide;

  const push = useCallback((item: Omit<AlertItem, "read" | "at">) => {
    if (seen.current.has(item.id)) return;
    seen.current.add(item.id);
    const full: AlertItem = { ...item, at: new Date().toISOString(), read: false };
    setItems((list) => [full, ...list].slice(0, 40));
    const meta = META[item.kind];
    if (meta.sound && soundRef.current) playSound(meta.sound);
    toast.custom((t) => <AlertToast item={full} onClose={() => toast.dismiss(t)} onOpen={(id) => (focusRef.current(id), toast.dismiss(t))} />, {
      id: item.id,
      position: "top-center",
      duration: meta.sticky ? Infinity : item.kind === "accepted" ? 4500 : 8000,
    });
    if (meta.desktop && typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState === "hidden") {
      try {
        const n = new Notification(item.title, { body: item.body, tag: item.id, icon: "/icon.svg", requireInteraction: meta.sticky });
        n.onclick = () => {
          window.focus();
          if (item.rideId) focusRef.current(item.rideId);
          n.close();
        };
      } catch {
        /* notifications indisponibles (iframe, politique du navigateur) */
      }
    }
  }, []);

  useRealtimeEvent("ride.updated", (p) => {
    if (!p?.id || p.number == null) return;
    rides.current.set(p.id, {
      number: p.number, pickup: p.pickup_address, dropoff: p.dropoff_address, price: p.price_cents,
      type: p.type, pickupAt: p.pickup_at, source: p.source,
    });
    // Les courses saisies au dashboard sont déjà sous les yeux de leur auteur : pas d'alerte sonore
    if (p.op === "insert" && p.source !== "dashboard") {
      const via = SOURCE[p.source]?.label ?? "API";
      push({
        id: `new:${p.id}`,
        kind: "new",
        rideId: p.id,
        source: p.source,
        title: `Nouvelle course #${p.number}${p.type === "scheduled" ? " · planifiée" : ""}`,
        body: [
          `${shortAddress(p.pickup_address)} → ${shortAddress(p.dropoff_address)}`,
          p.type === "scheduled" ? formatRideDate(p.pickup_at) : null,
          p.price_cents != null ? formatPrice(p.price_cents) : null,
          via,
        ].filter(Boolean).join(" · "),
      });
    }
  });

  useRealtimeEvent("ride.event", (e) => {
    if (!e?.type || !e.ride_id) return;
    const r = rides.current.get(e.ride_id);
    const label = r ? `#${r.number}` : "";
    const route = r ? `${shortAddress(r.pickup)} → ${shortAddress(r.dropoff)}` : "";
    if (e.type === "offer.accepted") {
      const secs = e.data?.response_ms != null ? Math.max(1, Math.round(e.data.response_ms / 1000)) : null;
      const who = String(e.message ?? "").replace(/ accepte$/, "");
      push({
        id: `acc:${e.id}`,
        kind: "accepted",
        rideId: e.ride_id,
        title: `Course ${label} attribuée`.replace("  ", " "),
        body: [`${who} a accepté${secs ? ` en ${secs} s` : ""}`, route].filter(Boolean).join(" · "),
      });
    } else if (e.type === "dispatch.no_driver") {
      push({ id: `nd:${e.id}`, kind: "no_driver", rideId: e.ride_id, title: `Aucun chauffeur pour ${label || "une course"}`.trim(), body: [route, "Relancez ou attribuez manuellement."].filter(Boolean).join(" · ") });
    } else if (e.type === "dispatch.escalated") {
      push({ id: `esc:${e.id}`, kind: "escalated", rideId: e.ride_id, title: `Planifiée ${label} toujours sans chauffeur`.trim(), body: [route, "Recherche GPS lancée autour du départ."].filter(Boolean).join(" · ") });
    } else if (e.type === "ride.cancelled" && (e.actor_type === "api" || e.actor_type === "booking_site")) {
      push({ id: `can:${e.id}`, kind: "cancelled", rideId: e.ride_id, title: `Course ${label} annulée par le site`.replace("  ", " "), body: route });
    }
  });

  const unread = useMemo(() => items.filter((i) => !i.read).length, [items]);

  // Compteur dans l'onglet du navigateur
  useEffect(() => {
    const strip = (t: string) => t.replace(/^\(\d+\)\s/, "");
    const apply = () => {
      const base = strip(document.title);
      const next = unread > 0 ? `(${unread}) ${base}` : base;
      if (document.title !== next) document.title = next;
    };
    apply();
    const id = window.setInterval(apply, 1500);
    return () => {
      window.clearInterval(id);
      document.title = strip(document.title);
    };
  }, [unread, pathname]);

  const ctx: Ctx = {
    items,
    unread,
    sound,
    setSound: (on) => {
      setSoundState(on);
      write(() => window.localStorage, SOUND_KEY, on);
      if (on) {
        unlockAudio();
        window.setTimeout(() => playSound("accepted", 0.7), 60);
      }
    },
    desktop,
    enableDesktop: () => {
      if (typeof Notification === "undefined") return;
      void Notification.requestPermission().then(setDesktop);
    },
    markAllRead: () => setItems((l) => (l.some((i) => !i.read) ? l.map((i) => ({ ...i, read: true })) : l)),
    clear: () => setItems([]),
    focusRide,
  };
  return <AlertsContext.Provider value={ctx}>{children}</AlertsContext.Provider>;
}

export function useAlerts() {
  return useContext(AlertsContext);
}

function ago(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  return `il y a ${Math.floor(s / 3600)} h`;
}

function AlertToast({ item, onClose, onOpen }: { item: AlertItem; onClose: () => void; onOpen: (rideId: string) => void }) {
  const meta = META[item.kind];
  const Icon = meta.icon;
  const [busy, setBusy] = useState(false);
  return (
    <div
      className="pointer-events-auto relative flex w-[356px] max-w-[calc(100vw-32px)] items-start gap-3 overflow-hidden rounded-2xl border border-white/10 bg-ink-700/95 p-3.5 pr-9 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.9)] backdrop-blur-xl"
      role="status"
    >
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: meta.color }} />
      <span className="relative mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl" style={{ background: `color-mix(in oklab, ${meta.color} 16%, transparent)`, color: meta.color }}>
        {item.kind === "new" && <span className="absolute inset-0 animate-ping rounded-xl opacity-30" style={{ background: meta.color }} />}
        <Icon className="relative size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-semibold leading-5 text-fg">{item.title}</p>
        {item.body && <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[18px] text-fg-muted">{item.body}</p>}
        {item.rideId && (
          <div className="mt-2.5 flex gap-1.5">
            <button
              type="button"
              onClick={() => onOpen(item.rideId!)}
              className="h-7 rounded-lg bg-white/[0.08] px-2.5 text-[12px] font-medium text-fg transition-colors hover:bg-white/[0.13]"
            >
              Voir sur la carte
            </button>
            {item.kind === "no_driver" && (
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const res = await redispatchRide(item.rideId!);
                  setBusy(false);
                  if (res.ok) {
                    toast.success("Recherche relancée");
                    onClose();
                  } else toast.error(res.error);
                }}
                className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-brand px-2.5 text-[12px] font-semibold text-brand-fg transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                <RotateCw className={cn("size-3.5", busy && "animate-spin")} /> Relancer
              </button>
            )}
          </div>
        )}
      </div>
      <button type="button" onClick={onClose} className="absolute right-2 top-2 rounded-md p-1 text-fg-subtle hover:bg-white/5 hover:text-fg" aria-label="Fermer">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Cloche : historique des alertes, son, notifications du navigateur. */
export function AlertsBell({ className }: { className?: string }) {
  const a = useAlerts();
  const [open, setOpen] = useState(false);
  if (!a) return null;
  return (
    <P.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) a.markAllRead();
      }}
    >
      <P.Trigger
        className={cn("relative grid size-8 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-white/[0.06] hover:text-fg", className)}
        aria-label={`Notifications${a.unread ? ` (${a.unread} non lues)` : ""}`}
      >
        {a.sound ? <Bell className="size-4" /> : <BellOff className="size-4" />}
        {a.unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red px-1 text-[10px] font-bold tabular-nums text-white ring-2 ring-ink-950">
            {a.unread > 9 ? "9+" : a.unread}
          </span>
        )}
      </P.Trigger>
      <P.Portal>
        <P.Content
          align="start"
          side="bottom"
          sideOffset={8}
          collisionPadding={12}
          className="z-[60] w-[360px] overflow-hidden rounded-2xl border border-line-strong bg-ink-700 shadow-float data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <p className="flex-1 text-[13.5px] font-semibold">Notifications</p>
            <button
              type="button"
              onClick={() => a.setSound(!a.sound)}
              className={cn("inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium", a.sound ? "bg-brand/12 text-brand" : "bg-white/[0.05] text-fg-muted")}
            >
              {a.sound ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />} {a.sound ? "Son activé" : "Son coupé"}
            </button>
          </div>
          {a.desktop === "default" && (
            <button type="button" onClick={a.enableDesktop} className="flex w-full items-center gap-2.5 border-b border-line bg-brand/[0.06] px-4 py-2.5 text-left text-[12.5px] hover:bg-brand/[0.1]">
              <Monitor className="size-4 text-brand" />
              <span className="flex-1">
                <span className="block font-medium text-fg">Alertes même onglet fermé</span>
                <span className="block text-fg-muted">Activer les notifications du navigateur</span>
              </span>
            </button>
          )}
          <div className="max-h-[420px] overflow-y-auto p-1.5">
            {a.items.length === 0 ? (
              <div className="px-6 py-10 text-center">
                <Bell className="mx-auto mb-2 size-5 text-fg-subtle" />
                <p className="text-[13px] font-medium">Rien de neuf</p>
                <p className="mt-1 text-[12px] text-fg-subtle">Nouvelles courses, attributions et alertes apparaîtront ici, avec un son.</p>
              </div>
            ) : (
              a.items.map((i) => {
                const m = META[i.kind];
                const Icon = m.icon;
                return (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => {
                      if (i.rideId) a.focusRide(i.rideId);
                      setOpen(false);
                      a.markAllRead();
                    }}
                    className="flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-white/[0.05]"
                  >
                    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg" style={{ background: `color-mix(in oklab, ${m.color} 14%, transparent)`, color: m.color }}>
                      <Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className={cn("flex-1 truncate text-[12.5px]", i.read ? "text-fg-muted" : "font-semibold text-fg")}>{i.title}</span>
                        <span className="shrink-0 text-[11px] text-fg-subtle">{ago(i.at)}</span>
                      </span>
                      <span className="line-clamp-2 text-[12px] text-fg-subtle">{i.body}</span>
                    </span>
                    {!i.read && <span className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />}
                  </button>
                );
              })
            )}
          </div>
          {a.items.length > 0 && (
            <div className="flex justify-end border-t border-line px-3 py-2">
              <button type="button" onClick={a.clear} className="rounded-md px-2 py-1 text-[12px] text-fg-subtle hover:bg-white/5 hover:text-fg">
                Tout effacer
              </button>
            </div>
          )}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
