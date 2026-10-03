// Textes des règlements (commissions de la centrale, courses partenaires) : typographie, échéances, statuts, motifs de
// blocage. Module sans dépendance native (testé sous Node) ; src/components/centrale.tsx les réexporte.
import {
  DRIVER_BLOCKER_META, formatRideDate, settlementStatusLabel,
  type DriverBlocker, type SettlementDirection, type SettlementStatus,
} from "@rydar/shared";

export const NBSP = " ";

/** Typographie française des messages serveur : espace insécable avant « : ; ! ? » (pas de « : » seul en début de ligne). */
export const frTypo = (s: string) => s.replace(/ ([:;!?»])/g, `${NBSP}$1`).replace(/« /g, `«${NBSP}`);

/** Ce que le chauffeur reverse à la centrale s'il encaisse le client : commission + frais plateforme. */
export const deductionCents = (r: { commission_cents?: number | null; platform_fee_cents?: number | null }) =>
  (r.commission_cents ?? 0) + (r.platform_fee_cents ?? 0);

/**
 * Statut d'un règlement vu par le chauffeur : settlementStatusLabel (@rydar/shared), sauf deux libellés
 * partagés formulés pour la centrale : commission déclarée (« Payé selon le chauffeur ») et part chauffeur
 * pas encore versée (« À verser »).
 */
export function driverSettlementLabel(status: SettlementStatus, direction: SettlementDirection, overdue = false) {
  if (status === "declared" && direction === "driver_owes") return "Paiement signalé";
  if (status === "due" && direction === "centrale_owes") return "À recevoir";
  return settlementStatusLabel(status, direction, overdue);
}

/** Motif de blocage → libellé, message, et si un règlement le lève (« réservée aux confirmés » : non). */
export function blockerInfo(reason: string | null | undefined, message?: string | null) {
  if (!reason) return null;
  const meta = DRIVER_BLOCKER_META[reason as DriverBlocker] as { label: string; message: string } | undefined;
  return {
    reason,
    label: meta?.label ?? "Courses bloquées",
    message: frTypo(message || meta?.message || "Réglez vos commissions pour recevoir de nouvelles courses."),
    payable: reason !== "new_driver",
  };
}

/** Durée restante / écoulée, insécable : « 18 min », « 5 h 12 », « 24 h », « 3 j ». */
export function formatLeft(ms: number) {
  const m = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (m < 60) return `${m}${NBSP}min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 48) return rest && h < 10 ? `${h}${NBSP}h${NBSP}${String(rest).padStart(2, "0")}` : `${h}${NBSP}h`;
  return `${Math.floor(h / 24)}${NBSP}j`;
}

/** « 20:06 » (aujourd'hui), « demain 06:30 », « le jeu. 25/09 06:30 ». */
export function formatWhen(iso: string, tz?: string, now = new Date()) {
  const s = formatRideDate(iso, tz, now);
  if (s.startsWith("Aujourd'hui ")) return s.slice("Aujourd'hui ".length);
  if (s.startsWith("Demain ")) return `demain ${s.slice("Demain ".length)}`;
  if (s.startsWith("Hier ")) return `hier ${s.slice("Hier ".length)}`;
  return `le ${s}`;
}

/**
 * Échéance d'une commission : « À régler avant 20:06 · dans 6 h 34 » ou « En retard de 2 h 10 »
 * (short : « Avant 20:06 · dans 6 h 34 », pour un titre qui dit déjà « à régler »).
 */
export function dueText(dueAt: string, tz?: string, now = Date.now()) {
  const ms = new Date(dueAt).getTime() - now;
  if (ms <= 0) {
    const text = `En retard de ${formatLeft(ms)}`;
    return { text, short: text, late: true };
  }
  const tail = `${formatWhen(dueAt, tz, new Date(now))} · dans ${formatLeft(ms)}`;
  return { text: `À régler avant ${tail}`, short: `Avant ${tail}`, late: false };
}

/** « aujourd'hui 14:32 », « hier 22:10 », « le jeu. 25/09 06:30 » */
export function pastWhen(iso: string | null | undefined, tz?: string, now = new Date()) {
  if (!iso) return "";
  const s = formatRideDate(iso, tz, now);
  if (/^(Aujourd'hui|Hier|Demain) /.test(s)) return `${s.charAt(0).toLowerCase()}${s.slice(1)}`;
  return `le ${s}`;
}
