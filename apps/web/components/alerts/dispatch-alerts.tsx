"use client";
// Alertes du rattacheur : toasts riches + sons + notifications du navigateur + cloche avec non-lus.
// Sources temps réel (org:{id}) :
//  - `ride.updated` (nouvelles courses) et `ride.event` (acceptation, aucun chauffeur, bascule GPS, annulation, vols) ;
//  - `ride.alert` (retard, immobile, GPS muet, pas démarrée : la centrale décide — Relancer, Réattribuer, Garder) ;
//  - `chat.message` (message ou signalement d'un chauffeur) ; `driver.document` (document déposé à valider) ;
//  - `chat.moderation` (004100) : message du fil « Chauffeurs » signalé, à supprimer ou à ignorer dans Messages.
// Mode centrale (002600) :
//  - `settlement.updated` : course terminée (commission à encaisser / part à verser), « J'ai payé » à confirmer ;
//  - `driver.application` (candidature par le lien d'inscription) ; `driver.flagged` (appareil d'un compte banni) ;
//  - `platform.updated` (frais plateforme dus à Rydar, owner / admin) : paiement reçu / non reçu, relance, avoir,
//    baisse acceptée / refusée, frais par course changés (règle des taux appliqués selon le modèle), hausse annoncée
//    ou annulée (20260924006600) ; rien pour « fee » (chaque course terminée). Pages des frais Rydar relues
//    (useLiveSync : rien tant que l'onglet est caché).
import {
  DOCUMENT_TYPE_LABELS, FLEET_REPORT_META, PAYMENT_METHOD_LABELS, fleetReportTitle, formatPhone, formatPrice, formatRideDate, formatTime,
  platformFeeScopeText, shortAddress,
  type ChatMessage, type ChatModerationEvent, type DispatchModel, type DriverApplicationEvent, type DriverDocumentEvent, type DriverFlaggedEvent,
  type OrgPlatformAccount, type PaymentMethod, type PlatformAccount, type PlatformEvent,
  type RideAlertBroadcast,
  type RideAlertKind, type RideAlertSeverity, type SettlementDirection, type SettlementEvent,
} from "@rydar/shared";
import {
  AlertTriangle, ArrowUpRight, Bell, BellOff, BellRing, Check, CheckCheck, CheckCircle2, CircleSlash, Clock3, FileText, Flag, Globe, HandCoins, KeyRound, Landmark,
  MessageSquareText, Monitor, Plane, PlaneLanding, Reply, RotateCw, ShieldAlert, UserPlus, Volume2, VolumeX, X, type LucideIcon,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Popover as P } from "radix-ui";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { redispatchRide } from "@/app/dashboard/rides/actions";
import { confirmSettlements } from "@/app/dashboard/settlements/actions";
import { ALERT_ICON, AlertActionBar, agoFr, alertLabel, severityColor } from "@/components/alerts/ride-alert-ui";
import { feeTermsText, frSpaces, scheduledFeeChangeText } from "@/components/platform-fees/org-platform-format";
import { isPlatformFeesPath, platformFeesPaths } from "@/components/platform-fees/org-platform-paths";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { useLiveSync } from "@/components/realtime/use-live-sync";
import { useCentrale, type CentraleInfo } from "@/components/settlements/centrale-context";
import { buildSettlementWhatsApp, methodLabel, parseDriverLabel, rideNumberOf, useDriverContact } from "@/components/settlements/settlement-ui";
import { runAction } from "@/lib/run-action";
import { playSound, unlockAudio, type SoundKind } from "@/lib/sounds";
import { getBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { NewTabHint } from "@/components/ui/new-tab";

export type AlertKind =
  | "new" | "accepted" | "no_driver" | "escalated" | "cancelled" | "ride_alert" | "flight" | "message" | "report" | "document" | "moderation"
  // mode centrale
  | "settlement" | "application" | "flagged" | "platform";
type Level = "info" | "success" | "warning" | "critical";
export type AlertItem = {
  id: string;
  kind: AlertKind;
  title: string;
  body: string;
  rideId: string | null;
  at: string;
  read: boolean;
  source?: string;
  /** Lien hors course : messagerie, fiche chauffeur, signalement sur la carte. */
  href?: string;
  /** Libellé du bouton principal quand `href` est présent (« Répondre », « Vérifier »…). */
  cta?: string;
  level?: Level;
  /** Signalement flotte : emoji et couleur du type. */
  emoji?: string;
  color?: string;
  /** Alerte de suivi : de quoi agir depuis le toast. */
  alert?: { id: string; kind: RideAlertKind; severity: RideAlertSeverity; driverId: string | null; driverName?: string; rideNumber?: number };
  /** Alerte traitée ou résolue (historique de la cloche). */
  done?: boolean;
  /** Mode centrale : règlement de fin de course (à encaisser, à verser, « J'ai payé » à confirmer). */
  settlement?: {
    id: string;
    action: "created" | "declared";
    direction: SettlementDirection;
    amountCents: number;
    currency: string;
    reference: string;
    rideNumber: number | null;
    driverId: string | null;
    firstName: string;
  };
};

type RideInfo = { number: number; pickup: string; dropoff: string; price: number | null; type: string; pickupAt: string; source: string };

const BASE: Record<AlertKind, { icon: LucideIcon; color: string }> = {
  new: { icon: BellRing, color: "var(--color-brand)" },
  accepted: { icon: CheckCircle2, color: "var(--color-green)" },
  no_driver: { icon: AlertTriangle, color: "var(--color-red)" },
  escalated: { icon: Clock3, color: "var(--color-amber)" },
  cancelled: { icon: CircleSlash, color: "var(--color-fg-muted)" },
  ride_alert: { icon: AlertTriangle, color: "var(--color-amber)" },
  flight: { icon: Plane, color: "var(--color-cyan)" },
  message: { icon: MessageSquareText, color: "var(--color-blue)" },
  report: { icon: AlertTriangle, color: "var(--color-amber)" },
  document: { icon: FileText, color: "var(--color-violet)" },
  moderation: { icon: Flag, color: "var(--color-amber)" },
  settlement: { icon: HandCoins, color: "var(--color-amber)" },
  application: { icon: UserPlus, color: "var(--color-brand)" },
  flagged: { icon: ShieldAlert, color: "var(--color-red)" },
  platform: { icon: Landmark, color: "var(--color-violet)" },
};

const LEVEL_COLOR: Record<Level, string> = {
  info: "var(--color-cyan)",
  success: "var(--color-green)",
  warning: "var(--color-amber)",
  critical: "var(--color-red)",
};

/** Icône + couleur d'une alerte (selon le type d'alerte de suivi, le niveau d'un vol, le type de signalement). */
function visual(i: AlertItem): { icon: LucideIcon; color: string; emoji?: string } {
  if (i.kind === "ride_alert" && i.alert) return { icon: ALERT_ICON[i.alert.kind] ?? AlertTriangle, color: severityColor(i.alert.severity) };
  if (i.kind === "flight") return { icon: i.level === "success" ? PlaneLanding : Plane, color: LEVEL_COLOR[i.level ?? "info"] };
  if (i.kind === "report") return { icon: AlertTriangle, color: i.color ?? BASE.report.color, emoji: i.emoji };
  if (i.kind === "platform") {
    if (i.level === "success") return { icon: CheckCircle2, color: LEVEL_COLOR.success };
    if (i.level === "critical") return { icon: CircleSlash, color: LEVEL_COLOR.critical };
    if (i.level === "warning") return { icon: BellRing, color: LEVEL_COLOR.warning };
    return BASE.platform;
  }
  if (i.kind === "settlement" && i.settlement) {
    if (i.settlement.action === "declared") return { icon: CheckCheck, color: "var(--color-blue)" };
    if (i.settlement.direction === "centrale_owes") return { icon: ArrowUpRight, color: "var(--color-violet)" };
  }
  return BASE[i.kind];
}

/** Son, notification du navigateur, durée d'affichage. */
function behavior(i: AlertItem): { sound: SoundKind | null; desktop: boolean; duration: number } {
  switch (i.kind) {
    case "new":
      return { sound: "new", desktop: true, duration: 8000 };
    case "accepted":
      return { sound: "accepted", desktop: false, duration: 4500 };
    case "no_driver":
      return { sound: "alert", desktop: true, duration: Infinity };
    case "escalated":
      return { sound: "alert", desktop: true, duration: 8000 };
    case "cancelled":
      return { sound: null, desktop: false, duration: 8000 };
    case "ride_alert":
      return { sound: "alert", desktop: true, duration: i.alert?.severity === "critical" ? Infinity : 15_000 };
    case "flight": {
      const important = i.level === "warning" || i.level === "critical";
      return { sound: important ? "notice" : null, desktop: important, duration: i.level === "critical" ? Infinity : important ? 10_000 : 6000 };
    }
    case "message":
      return { sound: "message", desktop: true, duration: 9000 };
    case "report":
      return { sound: "notice", desktop: true, duration: 10_000 };
    case "document":
      return { sound: "notice", desktop: false, duration: 10_000 };
    case "moderation":
      // Message signalé : la centrale décide (supprimer / ignorer), éventuellement onglet en arrière-plan
      return { sound: "notice", desktop: true, duration: 12_000 };
    case "settlement":
      // « J'ai payé » attend une décision : reste plus longtemps à l'écran
      return i.settlement?.action === "declared"
        ? { sound: "notice", desktop: true, duration: 20_000 }
        : { sound: "notice", desktop: i.settlement?.direction === "driver_owes", duration: 12_000 };
    case "application":
      return { sound: "notice", desktop: true, duration: 12_000 };
    case "flagged":
      return { sound: "alert", desktop: true, duration: Infinity };
    case "platform":
      // Paiement refusé ou relance de Rydar : à traiter ; confirmation, avoir : simple information
      return i.level === "critical" || i.level === "warning"
        ? { sound: "notice", desktop: true, duration: 20_000 }
        : { sound: "notice", desktop: false, duration: 10_000 };
  }
}

/** Course payée à la centrale : la centrale doit la part chauffeur. */
const PAID_TO_CENTRALE: Record<string, string> = {
  online: "payée en ligne à la centrale",
  invoice: "payée sur facture à la centrale",
  account: "réglée sur compte entreprise",
};

/** « maintenant », « avant 14:32 », « avant demain 06:30 » */
function dueWhen(iso: string, timeZone?: string) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= Date.now() + 2 * 60_000) return "maintenant";
  const label = formatRideDate(iso, timeZone);
  return `avant ${label.startsWith("Aujourd'hui ") ? label.slice(12) : label.charAt(0).toLowerCase() + label.slice(1)}`;
}

const SOURCE: Record<string, { label: string; icon: typeof Globe }> = {
  api: { label: "Site web (API)", icon: KeyRound },
  booking_site: { label: "Mini-site", icon: Globe },
  dashboard: { label: "Dashboard", icon: Monitor },
};

/** « sa carte VTC », « son permis de conduire » : pour « Mehdi a envoyé … — à valider ». */
const DOC_PHRASE: Record<string, string> = {
  vtc_card: "sa carte VTC",
  driving_license: "son permis de conduire",
  identity: "sa pièce d'identité",
  insurance: "son attestation d'assurance",
  vehicle_registration: "sa carte grise",
  medical: "sa visite médicale",
};

/** Textes par défaut d'un signalement sans commentaire (send_chat_message) : inutile de les répéter. */
const DEFAULT_REPORT_BODIES = new Set([
  "Contrôle de police signalé", "Contrôle VTC signalé", "Accident signalé", "Bouchon signalé", "Danger sur la route", "Signalement de la flotte",
]);

const firstName = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || "Un chauffeur";

const PLATFORM_METHOD_LABEL: Record<string, string> = { transfer: "virement", link: "lien de paiement", cash: "espèces", card: "carte", other: "autre moyen" };

/** Actions de Rydar signalées à la centrale (pas les frais de chaque course, ni ses propres déclarations). */
const PLATFORM_ALERT_ACTIONS = new Set<string>([
  "confirmed", "rejected", "reopened", "reminded", "adjusted", "reduction_approved", "reduction_rejected", "terms", "rates",
  "rates_scheduled", "rates_cancelled",
]);

/**
 * Alerte « frais plateforme » (null : rien à signaler, ex. frais d'une course terminée, action de la centrale elle-même).
 * `ctx` : modèle d'exploitation (règle des taux appliqués) et compte relu (hausse annoncée).
 */
function platformAlert(
  e: PlatformEvent,
  ctx: { model?: DispatchModel | null; account?: PlatformAccount | null; timeZone?: string } = {},
): Pick<AlertItem, "id" | "title" | "body" | "level"> | null {
  const p = e.payment;
  const entry = e.entry;
  const quote = (t: string | null | undefined) => (t ? `« ${t} »` : null);
  switch (e.action) {
    case "confirmed": {
      if (!p) return null;
      const received = p.received_cents ?? p.amount_cents;
      const partial = p.received_cents != null && p.received_cents !== p.amount_cents;
      return {
        id: `pf:${p.id}:confirmed:${p.reviewed_at ?? ""}`,
        level: "success",
        title: p.source === "admin" ? `Rydar a enregistré votre paiement de ${formatPrice(received)}` : `Rydar a bien reçu ${formatPrice(received)}`,
        body: [
          partial ? `sur ${formatPrice(p.amount_cents)} déclarés` : null,
          PLATFORM_METHOD_LABEL[p.method] ? `par ${PLATFORM_METHOD_LABEL[p.method]}` : null,
          p.reference ? `réf. ${p.reference}` : null,
          quote(p.review_note),
        ].filter(Boolean).join(" · ") || "Votre solde de frais plateforme est à jour.",
      };
    }
    case "rejected":
      if (!p) return null;
      return {
        id: `pf:${p.id}:rejected:${p.reviewed_at ?? ""}`,
        level: "critical",
        title: `Rydar n'a pas reçu votre paiement de ${formatPrice(p.amount_cents)}`,
        body: [p.review_note ? `Motif : ${p.review_note}` : null, "Vérifiez le paiement puis déclarez-le à nouveau."].filter(Boolean).join(" · "),
      };
    case "reopened":
      if (!p) return null;
      return {
        id: `pf:${p.id}:reopened:${p.reviewed_at ?? Date.now()}`,
        level: "info",
        title: `Rydar a rouvert votre paiement de ${formatPrice(p.amount_cents)}`,
        body: [p.review_note ? `Motif : ${p.review_note}` : null, "Il attend de nouveau sa confirmation."].filter(Boolean).join(" · "),
      };
    case "reminded":
      return {
        id: `pf:reminded:${new Date().toISOString().slice(0, 16)}`,
        level: "warning",
        title: "Rydar vous relance pour vos frais plateforme",
        body: e.note ? quote(e.note)! : "Merci de régler le solde de vos frais plateforme.",
      };
    case "adjusted":
      if (!entry) return null;
      return {
        id: `pf:${entry.id}:adjusted`,
        level: entry.amount_cents < 0 ? "success" : "warning",
        title: entry.amount_cents < 0 ? `Avoir de ${formatPrice(-entry.amount_cents)} accordé par Rydar` : `Rydar a ajouté ${formatPrice(entry.amount_cents)} de frais plateforme`,
        body: entry.reason ?? entry.label,
      };
    case "reduction_approved":
      if (!entry) return null;
      return {
        id: `pf:${entry.id}:approved`,
        level: "success",
        title: `Baisse de frais acceptée par Rydar : ${formatPrice(Math.abs(entry.amount_cents))}`,
        body: [entry.label, quote(entry.review_note)].filter(Boolean).join(" · "),
      };
    case "reduction_rejected":
      if (!entry) return null;
      return {
        id: `pf:${entry.id}:rejected`,
        level: "warning",
        title: "Baisse de frais refusée par Rydar",
        body: [entry.label, entry.review_note ? `Motif : ${entry.review_note}` : null, "Les frais initiaux restent dus."].filter(Boolean).join(" · "),
      };
    case "terms":
      return {
        id: `pf:terms:${new Date().toISOString().slice(0, 16)}`,
        level: "info",
        title: "Rydar a mis à jour vos conditions de règlement",
        body: "Échéance ou délai des frais plateforme modifiés : consultez votre compte.",
      };
    case "rates":
      // Frais par course changés (super admin, ou hausse annoncée arrivée à sa date d'effet) : règle des taux appliqués
      // selon le modèle — flotte : courses terminées à partir de maintenant ; centrale : répartitions calculées à partir
      // de maintenant, y compris d'une course déjà terminée dont le prix est corrigé
      if (!e.terms) return null;
      return {
        id: `pf:rates:${new Date().toISOString().slice(0, 16)}`,
        level: "info",
        title: "Rydar a mis à jour vos frais par course",
        body: frSpaces(`Désormais : ${feeTermsText(e.terms, "aucuns frais par course")}. ${platformFeeScopeText(ctx.model, "now")}`),
      };
    case "rates_scheduled": {
      // Hausse annoncée (au moins 30 jours à l'avance) : date d'effet et taux relus dans le compte
      const change = ctx.account?.scheduled_change;
      const text = ctx.account ? scheduledFeeChangeText(ctx.account, ctx.model, ctx.timeZone) : null;
      if (!change || !text) return null;
      return {
        id: `pf:rates_scheduled:${change.id}`,
        level: "warning",
        title: "Rydar annonce un changement de vos frais par course",
        body: text.next,
      };
    }
    case "rates_cancelled":
      if (!e.terms) return null;
      return {
        id: `pf:rates_cancelled:${new Date().toISOString().slice(0, 16)}`,
        level: "info",
        title: "Changement de vos frais par course annulé",
        body: frSpaces(`Vos frais par course restent : ${feeTermsText(e.terms, "aucuns frais par course")}.`),
      };
    default:
      // fee (chaque course terminée), declared / cancelled (action de la centrale), reduction_pending (sa propre correction)
      return null;
  }
}

type Api = {
  focusRide: (id: string) => void;
  assignRide: (id: string) => void;
  navigate: (href: string) => void;
  /** Organisation (mode centrale) : lien de paiement, instructions — pour les réclamations WhatsApp */
  centrale: () => CentraleInfo | null;
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
  open: (item: AlertItem) => void;
};
const AlertsContext = createContext<Ctx | null>(null);

const STORE_KEY = "rydar.alerts:";
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

/** `scope` : organisation + utilisateur (l'historique ne suit ni un changement d'organisation ni un autre compte). */
export function AlertsProvider({ scope, children }: { scope: string; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [items, setItems] = useState<AlertItem[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [sound, setSoundState] = useState(true);
  const [desktop, setDesktop] = useState<Ctx["desktop"]>("unsupported");
  const rides = useRef(new Map<string, RideInfo>());
  const seen = useRef(new Set<string>());
  /** Toasts encore affichés (mise à jour en place d'une alerte de suivi). */
  const shown = useRef(new Set<string>());
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // Enregistré à chaque modification (jamais depuis un effet : pas d'écrasement avant la relecture)
  const update = useCallback((fn: (list: AlertItem[]) => AlertItem[]) => {
    setItems((list) => {
      const next = fn(list);
      if (next !== list) write(() => window.sessionStorage, STORE_KEY + scopeRef.current, next.slice(0, 40));
      return next;
    });
  }, []);

  useEffect(() => {
    const stored = read(() => window.sessionStorage, STORE_KEY + scope, [] as AlertItem[]);
    setItems(stored);
    for (const i of stored) seen.current.add(i.id);
    // anciennes clés (autre organisation, autre compte) : effacées
    try {
      for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
        const k = window.sessionStorage.key(i);
        if (k && (k === "rydar.alerts" || (k.startsWith(STORE_KEY) && k !== STORE_KEY + scope))) window.sessionStorage.removeItem(k);
      }
    } catch {
      /* stockage indisponible */
    }
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

  const focusRide = useCallback(
    (id: string) => {
      if (pathname === "/dashboard") window.dispatchEvent(new CustomEvent("rydar:focus-ride", { detail: id }));
      else router.push(`/dashboard?ride=${id}`);
    },
    [pathname, router],
  );
  const assignRide = useCallback(
    (id: string) => {
      if (pathname === "/dashboard") window.dispatchEvent(new CustomEvent("rydar:assign-ride", { detail: id }));
      else router.push(`/dashboard?ride=${id}&assign=1`);
    },
    [pathname, router],
  );
  const navigate = useCallback(
    (href: string) => {
      // Signalement : la carte du command center est peut-être déjà ouverte
      const report = /^\/dashboard\?report=([0-9a-f-]{36})$/i.exec(href)?.[1];
      if (report && pathname === "/dashboard") window.dispatchEvent(new CustomEvent("rydar:focus-report", { detail: report }));
      else router.push(href);
    },
    [pathname, router],
  );
  const centrale = useCentrale();
  const centraleRef = useRef(centrale);
  centraleRef.current = centrale;
  const apiRef = useRef<Api>({ focusRide, assignRide, navigate, centrale: () => centraleRef.current });
  apiRef.current = { focusRide, assignRide, navigate, centrale: () => centraleRef.current };
  const api: Api = useMemo(
    () => ({
      focusRide: (id) => apiRef.current.focusRide(id),
      assignRide: (id) => apiRef.current.assignRide(id),
      navigate: (href) => apiRef.current.navigate(href),
      centrale: () => apiRef.current.centrale(),
    }),
    [],
  );

  const showToast = useCallback(
    (item: AlertItem, duration: number) => {
      shown.current.add(item.id);
      toast.custom((t) => <AlertToast item={item} api={api} onClose={() => toast.dismiss(t)} />, {
        id: item.id,
        position: "top-center",
        duration,
        onDismiss: () => shown.current.delete(item.id),
        onAutoClose: () => shown.current.delete(item.id),
      });
    },
    [api],
  );

  const notifyDesktop = useCallback(
    (item: AlertItem, sticky: boolean) => {
      if (typeof Notification === "undefined" || Notification.permission !== "granted" || document.visibilityState !== "hidden") return;
      try {
        const n = new Notification(item.title, { body: item.body, tag: item.id, icon: "/icon.svg", requireInteraction: sticky });
        n.onclick = () => {
          window.focus();
          if (item.rideId) api.focusRide(item.rideId);
          else if (item.href) api.navigate(item.href);
          n.close();
        };
      } catch {
        /* notifications indisponibles (iframe, politique du navigateur) */
      }
    },
    [api],
  );

  const push = useCallback((item: Omit<AlertItem, "read" | "at">) => {
    if (seen.current.has(item.id)) return;
    seen.current.add(item.id);
    const full: AlertItem = { ...item, at: new Date().toISOString(), read: false };
    update((list) => [full, ...list].slice(0, 40));
    const b = behavior(full);
    if (b.sound && soundRef.current) playSound(b.sound);
    showToast(full, b.duration);
    if (b.desktop) notifyDesktop(full, b.duration === Infinity);
  }, [update, showToast, notifyDesktop]);

  const rideLine = (rideId: string | null) => {
    const r = rideId ? rides.current.get(rideId) : undefined;
    return r ? { label: `#${r.number}`, route: `${shortAddress(r.pickup)} → ${shortAddress(r.dropoff)}`, number: r.number } : { label: "", route: "", number: undefined };
  };

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
          // Fuseau de la centrale (Réglages), comme la liste Courses
          p.type === "scheduled" ? formatRideDate(p.pickup_at, centraleRef.current?.timeZone || undefined) : null,
          p.price_cents != null ? formatPrice(p.price_cents) : null,
          via,
        ].filter(Boolean).join(" · "),
      });
    }
  });

  useRealtimeEvent("ride.event", (e) => {
    if (!e?.type || !e.ride_id) return;
    const { label, route } = rideLine(e.ride_id);
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
    } else if (typeof e.type === "string" && e.type.startsWith("flight.")) {
      // Vol retardé / en avance / atterri / annulé / mis à jour : message du serveur, niveau de l'événement
      const d = e.data ?? {};
      const cancelled = e.type === "flight.cancelled" || d.flight_status === "cancelled" || d.flight_status === "diverted";
      const bigDelay = e.type === "flight.delayed" && Math.abs(Number(d.delay_minutes ?? 0)) >= 15;
      const level: Level = cancelled ? "critical" : e.level === "success" ? "success" : bigDelay || e.level === "warning" || e.level === "error" ? "warning" : "info";
      push({
        id: `fl:${e.id}`,
        kind: "flight",
        rideId: e.ride_id,
        level,
        title: String(e.message ?? `Vol ${d.flight_number ?? ""} mis à jour`),
        body: [label ? `Course ${label}` : "Course suivie", route].filter(Boolean).join(" · "),
      });
    }
  });

  // ---------------------------------------------------------------- alertes de suivi (002200)
  useRealtimeEvent("ride.alert", (a: RideAlertBroadcast) => {
    if (!a?.id || !a.ride_id) return;
    const id = `ra:${a.id}`;
    if (a.status !== "open") {
      // Gardée (sourdine), relancée, réattribuée ou close d'elle-même : plus rien à décider
      toast.dismiss(id);
      shown.current.delete(id);
      update((list) => (list.some((i) => i.id === id && !i.done) ? list.map((i) => (i.id === id ? { ...i, done: true } : i)) : list));
      return;
    }
    const { route, number } = rideLine(a.ride_id);
    const rideNumber = a.data?.ride_number ?? number;
    const item: Omit<AlertItem, "read" | "at"> = {
      id,
      kind: "ride_alert",
      rideId: a.ride_id,
      title: `${alertLabel(a.kind)}${rideNumber ? ` · #${rideNumber}` : ""}`,
      body: [a.message, route].filter(Boolean).join(" · "),
      alert: { id: a.id, kind: a.kind, severity: a.severity, driverId: a.driver_id, driverName: a.data?.driver_name, rideNumber },
    };
    if (!seen.current.has(id)) {
      // Nouvelle alerte (ou alerte déjà ouverte avant le chargement de la page qui devient critique)
      if (a.op === "insert" || a.severity === "critical") push(item);
      return;
    }
    const prev = itemsRef.current.find((i) => i.id === id);
    const escalated = prev?.alert?.severity === "warning" && a.severity === "critical";
    const next: AlertItem = { ...(prev ?? { at: new Date().toISOString(), read: false }), ...item, done: false, ...(escalated ? { read: false, at: new Date().toISOString() } : {}) };
    update((list) => (list.some((i) => i.id === id) ? list.map((i) => (i.id === id ? next : i)) : [next, ...list].slice(0, 40)));
    if (shown.current.has(id) || escalated) {
      if (escalated && soundRef.current) playSound("alert");
      showToast(next, behavior(next).duration);
      if (escalated) notifyDesktop(next, true);
    }
  });

  // ---------------------------------------------------------------- messagerie et signalements (002300)
  useRealtimeEvent("chat.message", (m: ChatMessage) => {
    if (!m?.id || m.author_type !== "driver") return; // messages de la centrale : déjà sous les yeux de leur auteur
    if (window.location.pathname.startsWith("/dashboard/messages")) return; // la messagerie affiche déjà le message
    const who = firstName(m.author_name);
    if (m.report_type) {
      if (m.active === false) return;
      const meta = FLEET_REPORT_META[m.report_type] ?? FLEET_REPORT_META.other;
      const custom = m.body && !DEFAULT_REPORT_BODIES.has(m.body.trim()) ? m.body : null;
      push({
        id: `rep:${m.id}`,
        kind: "report",
        rideId: null,
        emoji: meta.emoji,
        color: meta.color,
        title: `${meta.emoji} ${fleetReportTitle(m.report_type, who)}`,
        body: [custom, m.expires_at ? `Visible par la flotte jusqu'à ${formatTime(m.expires_at, centraleRef.current?.timeZone || undefined)}` : null].filter(Boolean).join(" · "),
        href: `/dashboard?report=${m.id}`,
        cta: "Voir sur la carte",
      });
      return;
    }
    const direct = m.channel === "driver" && m.driver_id;
    push({
      id: `msg:${m.id}`,
      kind: "message",
      rideId: null,
      title: `${m.author_name || who}${direct ? "" : " · flotte"}`,
      body: m.body,
      href: direct ? `/dashboard/messages?driver=${m.driver_id}` : "/dashboard/messages?thread=fleet",
      cta: "Répondre",
    });
  });

  // ---------------------------------------------------------------- modération du fil « Chauffeurs » (004100)
  // Identifiants seulement (jamais le texte). Alerte `mod:<message>:<signalement>` ; message supprimé ou signalement
  // classé (ici ou par un autre membre) : toast fermé, historique « traitée ».
  useRealtimeEvent("chat.moderation", (e: ChatModerationEvent) => {
    if (!e?.message_id) return;
    const prefix = `mod:${e.message_id}:`;
    if (e.action === "removed" || e.action === "dismissed") {
      for (const i of itemsRef.current) {
        if (!i.id.startsWith(prefix)) continue;
        toast.dismiss(i.id);
        shown.current.delete(i.id);
      }
      update((list) =>
        list.some((i) => i.id.startsWith(prefix) && !i.done) ? list.map((i) => (i.id.startsWith(prefix) ? { ...i, done: true } : i)) : list,
      );
      return;
    }
    if (e.action !== "reported" || !e.report_id) return;
    if (window.location.pathname.startsWith("/dashboard/messages")) return; // la file de modération est déjà affichée
    push({
      id: `${prefix}${e.report_id}`,
      kind: "moderation",
      rideId: null,
      title: "Un message du fil Chauffeurs a été signalé",
      body: "À supprimer ou à ignorer dans Messages.",
      href: "/dashboard/messages?thread=fleet",
      cta: "Voir",
    });
  });

  // ---------------------------------------------------------------- documents chauffeur (002400)
  useRealtimeEvent("driver.document", (e: DriverDocumentEvent) => {
    if (e?.action !== "submitted" || !e.document || e.document.status !== "pending") return;
    const doc = e.document;
    const who = e.driver?.first_name || "Un chauffeur";
    const typeLabel = DOCUMENT_TYPE_LABELS[doc.type];
    const what = doc.label && doc.label !== typeLabel ? `« ${doc.label} »` : (DOC_PHRASE[doc.type] ?? "un document");
    push({
      id: `doc:${doc.id}`,
      kind: "document",
      rideId: null,
      title: `${who} a envoyé ${what} — à valider`,
      body: [
        e.driver ? `${e.driver.first_name} ${e.driver.last_name} · #${e.driver.number}` : null,
        doc.expires_at ? `échéance ${new Intl.DateTimeFormat("fr-FR").format(new Date(doc.expires_at))}` : null,
      ].filter(Boolean).join(" · "),
      href: `/dashboard/drivers/${doc.driver_id}`,
      cta: "Vérifier",
    });
  });

  // ---------------------------------------------------------------- mode centrale : encaissements (002600)
  /** Alertes d'un règlement traité (ici ou par un autre membre) : toast fermé, historique « traitée ». */
  const settleDone = (settlementId: string) => {
    for (const i of itemsRef.current) {
      if (i.settlement?.id !== settlementId) continue;
      toast.dismiss(i.id);
      shown.current.delete(i.id);
    }
    update((list) =>
      list.some((i) => i.settlement?.id === settlementId && !i.done) ? list.map((i) => (i.settlement?.id === settlementId ? { ...i, done: true } : i)) : list,
    );
  };

  useRealtimeEvent("settlement.updated", (e: SettlementEvent) => {
    const s = e?.settlement;
    if (!s?.id) return;
    if (e.action === "paid" || e.action === "waived" || e.action === "disputed" || e.action === "reopened") {
      settleDone(s.id);
      return;
    }
    if (e.action !== "created" && e.action !== "declared") return; // « updated » : montant recalculé après correction
    const who = parseDriverLabel(s.driver_label);
    const tag = `${who.firstName}${who.number ? ` #${who.number}` : ""}`;
    const n = rideLine(s.ride_id).number ?? rideNumberOf(s);
    const amount = formatPrice(s.amount_cents, s.currency);
    const tz = centraleRef.current?.timeZone;
    const settlement = {
      id: s.id, action: e.action, direction: s.direction, amountCents: s.amount_cents, currency: s.currency, reference: s.reference,
      rideNumber: n, driverId: s.driver_id, firstName: who.firstName,
    } satisfies AlertItem["settlement"];
    if (e.action === "declared") {
      push({
        id: `set:${s.id}:declared:${s.declared_at ?? ""}`,
        kind: "settlement",
        rideId: null,
        title: `${who.firstName} signale avoir payé ${amount} — à confirmer`,
        body: [n ? `Course #${n}` : null, methodLabel(s.declared_method), s.declared_note ? `« ${s.declared_note} »` : null, `réf. ${s.reference}`]
          .filter(Boolean)
          .join(" · "),
        href: "/dashboard/settlements?filter=declared",
        cta: "Encaissements",
        settlement,
      });
    } else if (s.direction === "driver_owes") {
      push({
        id: `set:${s.id}:created`,
        kind: "settlement",
        rideId: null,
        title: `Course ${n ? `#${n} ` : ""}terminée · ${amount} à encaisser — ${tag}`,
        body: [
          `Encaissée par le chauffeur (${(PAYMENT_METHOD_LABELS[s.payment_method as PaymentMethod] ?? "à bord").toLowerCase()})`,
          `à régler ${dueWhen(s.due_at, tz)}`,
          `réf. ${s.reference}`,
        ].join(" · "),
        href: "/dashboard/settlements",
        cta: "Encaissements",
        settlement,
      });
    } else {
      push({
        id: `set:${s.id}:created`,
        kind: "settlement",
        rideId: null,
        title: `${amount} à verser à ${tag}`,
        body: [`Course ${n ? `#${n} ` : ""}terminée`, PAID_TO_CENTRALE[s.payment_method] ?? "payée à la centrale", `réf. ${s.reference}`].join(" · "),
        href: "/dashboard/settlements?filter=to_pay",
        cta: "Encaissements",
        settlement,
      });
    }
  });

  useRealtimeEvent("driver.application", (e: DriverApplicationEvent) => {
    const d = e?.driver;
    if (!d?.id) return;
    const name = `${d.first_name} ${d.last_name}`.trim();
    if (e.action === "applied" || (e.action === "approved" && d.applied_at)) {
      // approved + applied_at : validation automatique à l'inscription (réglage de la centrale)
      const applied = e.action === "applied";
      const fleet = centraleRef.current?.model !== "centrale";
      push({
        id: `app:${d.id}:${e.action}`,
        kind: "application",
        rideId: null,
        title: applied ? `Nouvelle candidature : ${name}` : `${name} ${fleet ? "a rejoint la flotte" : "a rejoint la centrale"}`,
        body: [`Chauffeur #${d.number}`, d.phone ? formatPhone(d.phone) : null, applied ? "via le lien d'inscription · à valider" : "validation automatique"]
          .filter(Boolean)
          .join(" · "),
        href: "/dashboard/network",
        cta: applied ? "Voir la candidature" : fleet ? "Voir les inscriptions" : "Voir le réseau",
      });
    } else {
      // validée ou refusée depuis le tableau de bord : la candidature est traitée
      const id = `app:${d.id}:applied`;
      toast.dismiss(id);
      shown.current.delete(id);
      update((list) => (list.some((i) => i.id === id && !i.done) ? list.map((i) => (i.id === id ? { ...i, done: true } : i)) : list));
    }
  });

  useRealtimeEvent("driver.flagged", (e: DriverFlaggedEvent) => {
    if (!e?.driver_id) return;
    push({
      id: `flag:${e.driver_id}`,
      kind: "flagged",
      rideId: null,
      level: "critical",
      title: "Compte suspendu : appareil déjà utilisé par un chauffeur banni",
      body: `${e.first_name} ${e.last_name} (#${e.number}) · vérifiez son identité avant de le réactiver`,
      href: `/dashboard/drivers/${e.driver_id}`,
      cta: "Vérifier la fiche",
    });
  });

  // ---------------------------------------------------------------- frais plateforme dus à Rydar (20260924003000)
  // Pages « Frais Rydar » (flotte), relevés et compte : relues après chaque changement (carte, encart de la hausse
  // annoncée), différé tant que l'onglet est caché ; repli sans temps réel : sondage lent. La liste « Encaissements »
  // se relit elle-même (SettlementsView, même événement) : pas de double relecture.
  const { schedule: schedulePlatformSync } = useLiveSync(
    () => {
      const path = window.location.pathname;
      if (isPlatformFeesPath(path) && path !== "/dashboard/settlements") router.refresh();
    },
    { pollMs: 60_000, maxPollMs: 600_000, debounceMs: 700 },
  );
  useRealtimeEvent("platform.updated", (e: PlatformEvent) => {
    const org = centraleRef.current;
    if (!e?.action || !org || (org.role !== "owner" && org.role !== "admin")) return; // les dispatchers ne gèrent pas les frais
    if (e.organization_id && e.organization_id !== org.orgId) return;
    schedulePlatformSync();
    if (!PLATFORM_ALERT_ACTIONS.has(e.action)) return;
    // L'événement ne porte que des identifiants : détail relu par org_platform_account (owner / admin)
    void getBrowserClient()
      .rpc("org_platform_account", { p_org: org.orgId })
      .then(({ data }: { data: unknown }) => {
        const acc = data as OrgPlatformAccount | null;
        if (!acc?.enabled) return;
        const full: PlatformEvent = {
          ...e,
          payment: e.payment_id ? acc.payments.find((x) => x.id === e.payment_id) : undefined,
          entry: e.entry_id ? acc.entries.find((x) => x.id === e.entry_id) : undefined,
          note: e.action === "reminded" ? acc.account.reminder_note : undefined,
          terms: e.action === "rates" || e.action === "rates_cancelled" ? acc.account : undefined,
        };
        const model = acc.organization.dispatch_model ?? acc.account.dispatch_model ?? org.model;
        const alert = platformAlert(full, { model, account: acc.account, timeZone: acc.organization.timezone || org.timeZone });
        // « Frais plateforme » (centrale, Encaissements) ou « Frais Rydar » (flotte, son menu)
        const paths = platformFeesPaths(model);
        if (alert) push({ ...alert, kind: "platform", rideId: null, href: paths.account, cta: paths.label });
      }, () => undefined);
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
    markAllRead: () => update((l) => (l.some((i) => !i.read) ? l.map((i) => ({ ...i, read: true })) : l)),
    clear: () => update(() => []),
    focusRide,
    open: (i) => {
      if (i.rideId) focusRide(i.rideId);
      else if (i.href) navigate(i.href);
    },
  };
  return <AlertsContext.Provider value={ctx}>{children}</AlertsContext.Provider>;
}

export function useAlerts() {
  return useContext(AlertsContext);
}

// Rendu hors du fournisseur (le Toaster est monté dans la mise en page racine) : tout passe par `api`.
function AlertToast({ item, api, onClose }: { item: AlertItem; api: Api; onClose: () => void }) {
  const v = visual(item);
  const Icon = v.icon;
  const [busy, setBusy] = useState(false);
  const critical = item.kind === "ride_alert" ? item.alert?.severity === "critical" : item.level === "critical";
  const btn = "inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium transition-colors";
  return (
    <div
      className="pointer-events-auto relative w-[380px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl border border-white/10 bg-ink-700/95 p-3.5 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.9)] backdrop-blur-xl"
      role={critical ? "alert" : "status"}
    >
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: v.color }} />
      <div className="flex items-start gap-3 pr-6">
        <span className="relative mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl" style={{ background: `color-mix(in oklab, ${v.color} 16%, transparent)`, color: v.color }}>
          {(item.kind === "new" || critical) && <span className="absolute inset-0 animate-ping rounded-xl opacity-30" style={{ background: v.color }} />}
          {v.emoji ? <span className="relative text-[17px] leading-none">{v.emoji}</span> : <Icon className="relative size-[18px]" />}
        </span>
        <button
          type="button"
          tabIndex={-1}
          onClick={() => {
            if (item.rideId) api.focusRide(item.rideId);
            else if (item.href) api.navigate(item.href);
            else return;
            onClose();
          }}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <p className="text-[13.5px] font-semibold leading-5 text-fg">{item.kind === "report" && v.emoji ? item.title.replace(`${v.emoji} `, "") : item.title}</p>
          {item.body && <p className={cn("mt-0.5 text-[12.5px] leading-[18px] text-fg-muted", item.kind === "message" ? "line-clamp-3" : "line-clamp-2")}>{item.body}</p>}
        </button>
      </div>

      {item.kind === "ride_alert" && item.alert && item.rideId ? (
        <AlertActionBar
          className="mt-3"
          alert={{ id: item.alert.id, ride_id: item.rideId, driver_id: item.alert.driverId, driverName: item.alert.driverName, rideNumber: item.alert.rideNumber }}
          onView={() => (api.focusRide(item.rideId!), onClose())}
          onAssign={() => (api.assignRide(item.rideId!), onClose())}
          onDone={onClose}
        />
      ) : item.rideId ? (
        <div className="ml-12 mt-2.5 flex gap-1.5">
          <button type="button" onClick={() => (api.focusRide(item.rideId!), onClose())} className={cn(btn, "bg-white/[0.08] text-fg hover:bg-white/[0.13]")}>
            Voir sur la carte
          </button>
          {item.kind === "no_driver" && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const res = await runAction(() => redispatchRide(item.rideId!)).finally(() => setBusy(false));
                if (!res) return;
                if (res.ok) {
                  toast.success("Recherche relancée");
                  onClose();
                } else toast.error(res.error);
              }}
              className={cn(btn, "bg-brand font-semibold text-brand-fg hover:opacity-90 disabled:opacity-60")}
            >
              <RotateCw className={cn("size-3.5", busy && "animate-spin")} /> Relancer
            </button>
          )}
        </div>
      ) : item.kind === "settlement" && item.settlement ? (
        <SettlementToastActions item={item} api={api} onClose={onClose} btn={btn} />
      ) : item.href ? (
        <div className="ml-12 mt-2.5 flex gap-1.5">
          <button
            type="button"
            onClick={() => (api.navigate(item.href!), onClose())}
            className={cn(
              btn,
              item.kind === "message"
                ? "bg-blue font-semibold text-ink-950 hover:opacity-90"
                : item.kind === "flagged"
                  ? "bg-red font-semibold text-white hover:bg-red/90"
                  : item.kind === "application"
                    ? "bg-brand font-semibold text-brand-fg hover:opacity-90"
                    : item.kind === "platform" && item.level === "critical"
                      ? "bg-red font-semibold text-white hover:bg-red/90"
                      : "bg-white/[0.08] text-fg hover:bg-white/[0.13]",
            )}
          >
            {item.kind === "message" && <Reply className="size-3.5" />}
            {item.kind === "platform" && <Landmark className="size-3.5" />}
            {item.cta ?? "Voir"}
          </button>
        </div>
      ) : null}

      <button type="button" onClick={onClose} className="absolute right-2 top-2 rounded-md p-1 text-fg-subtle hover:bg-white/5 hover:text-fg" aria-label="Fermer">
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Toast de règlement : « Reçu » (paiement signalé), « WhatsApp » (réclamation préremplie), « Encaissements ». */
function SettlementToastActions({ item, api, onClose, btn }: { item: AlertItem; api: Api; onClose: () => void; btn: string }) {
  const s = item.settlement!;
  const claim = s.action === "created" && s.direction === "driver_owes";
  const contact = useDriverContact(claim ? s.driverId : null);
  const org = api.centrale();
  const whatsapp =
    claim && contact && org
      ? buildSettlementWhatsApp(
          {
            phone: contact.phone,
            firstName: contact.first_name,
            amountCents: s.amountCents,
            currency: s.currency,
            rideNumbers: s.rideNumber ? [s.rideNumber] : [s.reference],
            reference: s.reference,
          },
          org,
        )
      : null;
  const [busy, setBusy] = useState(false);
  const received = async () => {
    setBusy(true);
    const res = await runAction(() => confirmSettlements([s.id], null)).finally(() => setBusy(false));
    if (!res) return;
    if (res.ok) {
      toast.success(`${formatPrice(s.amountCents, s.currency)} reçus de ${s.firstName}`, { description: `Règlement ${s.reference} soldé.` });
      onClose();
    } else toast.error(res.error);
  };
  const open = () => (api.navigate(item.href ?? "/dashboard/settlements"), onClose());
  return (
    <div className="ml-12 mt-2.5 flex flex-wrap gap-1.5">
      {s.action === "declared" && (
        <button type="button" disabled={busy} onClick={received} className={cn(btn, "bg-brand font-semibold text-brand-fg hover:opacity-90 disabled:opacity-60")}>
          <Check className="size-3.5" /> Reçu
        </button>
      )}
      <button type="button" onClick={open} className={cn(btn, "bg-white/[0.08] text-fg hover:bg-white/[0.13]")}>
        <HandCoins className="size-3.5" /> Encaissements
      </button>
      {whatsapp && (
        <a href={whatsapp} target="_blank" rel="noopener noreferrer" onClick={onClose} className={cn(btn, "border border-green/30 text-green hover:bg-green/10")}>
          <MessageSquareText className="size-3.5" /> WhatsApp
          <NewTabHint />
        </a>
      )}
    </div>
  );
}

/** Cloche : historique des alertes, son, notifications du navigateur. */
export function AlertsBell({ className }: { className?: string }) {
  const a = useAlerts();
  const centrale = useCentrale();
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
          className="z-[60] w-[360px] max-w-[calc(100vw-24px)] overflow-hidden rounded-2xl border border-line-strong bg-ink-700 shadow-float data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
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
                <p className="mt-1 text-[12px] text-fg-subtle">
                  Courses, retards, vols, messages
                  {centrale?.model === "centrale" ? `, paiements, candidatures${centrale.role === "owner" || centrale.role === "admin" ? ", frais Rydar" : ""}` : ""} et
                  signalements apparaîtront ici, avec un son.
                </p>
              </div>
            ) : (
              a.items.map((i) => {
                const m = visual(i);
                const Icon = m.icon;
                return (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => {
                      a.open(i);
                      setOpen(false);
                      a.markAllRead();
                    }}
                    className={cn("flex w-full items-start gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-white/[0.05]", i.done && "opacity-60")}
                  >
                    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg" style={{ background: `color-mix(in oklab, ${m.color} 14%, transparent)`, color: m.color }}>
                      {m.emoji ? <span className="text-[13px] leading-none">{m.emoji}</span> : <Icon className="size-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className={cn("flex-1 truncate text-[12.5px]", i.read ? "text-fg-muted" : "font-semibold text-fg")}>
                          {i.kind === "report" && m.emoji ? i.title.replace(`${m.emoji} `, "") : i.title}
                        </span>
                        <span className="shrink-0 text-[11px] text-fg-subtle">{agoFr(i.at)}</span>
                      </span>
                      <span className="line-clamp-2 text-[12px] text-fg-subtle">
                        {i.done && <span className="mr-1 font-medium text-green">Traitée ·</span>}
                        {i.body}
                      </span>
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
