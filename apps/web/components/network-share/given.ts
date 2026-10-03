// « Courses confiées » (A) : état d'une ligne et actions permises selon le rôle, le règlement et les délais.
// Toutes les règles sont revérifiées en base (assert_network_creditor, NETWORK_CONTEST_EXPIRED…) : ce module ne fait
// que choisir les boutons à montrer. Module pur (tests : given.test.ts).
import {
  NETWORK_EXECUTION_END_LABELS, NETWORK_PARAMS, NETWORK_SUSPECT_REASON_META, RIDE_STATUS_META,
  type NetworkGivenItem, type Tone,
} from "@rydar/shared";

const DAY = 86_400_000;
const OPEN = new Set(["due", "declared", "disputed"]);

export interface GivenRowActions {
  /** « Reçu » : le chauffeur a reversé la part de l'organisation (payé à bord) */
  confirm: boolean;
  /** « Pas reçu » */
  dispute: boolean;
  /** « Annuler » (payé à bord seulement : un versement au chauffeur ne s'annule que par « Contester la course ») */
  waive: boolean;
  /** « Versé » : feuille latérale avec le RIB du chauffeur */
  payout: boolean;
  /** « Valider » : course « à vérifier » contrôlée, versement libéré */
  validate: boolean;
  /** « Contester la course » (dans les 7 jours qui suivent la fin) */
  contest: boolean;
  /** « Rouvrir » (erreur de saisie) */
  reopen: boolean;
  /** « Relancer » (application, 1 / 30 min) : dispatcher compris */
  remind: boolean;
  excludeDriver: boolean;
  excludePartner: boolean;
}

/** Fin de la course partagée (fin d'exécution, sinon fin de course). */
export function givenEndedAt(item: NetworkGivenItem): string | null {
  return item.execution.ended_at ?? item.ride.completed_at ?? null;
}

/** Course « à vérifier » : contrôles de fin signalés, ni validée ni contestée. */
export function givenToCheck(item: NetworkGivenItem): boolean {
  const e = item.execution;
  if (!e.suspect_reasons.length || e.contested_at) return false;
  return e.validated_at === undefined ? e.on_hold : e.validated_at === null;
}

export function givenRowActions(
  item: NetworkGivenItem,
  opts: { canManage: boolean; now: number; partnerExcluded?: boolean },
): GivenRowActions {
  const s = item.settlement;
  const e = item.execution;
  const owes = s?.direction === "driver_owes";
  const open = !!s && OPEN.has(s.status);
  const end = givenEndedAt(item);
  const completed = item.ride.status === "COMPLETED" && (e.end_reason == null || e.end_reason === "completed");
  const m = opts.canManage;
  return {
    confirm: m && open && owes,
    dispute: m && owes && (s?.status === "due" || s?.status === "declared"),
    waive: m && open && owes,
    payout: m && !!s && !owes && s.status === "due" && !e.on_hold,
    validate: m && !e.contested_at && (e.on_hold || givenToCheck(item)),
    contest: m && completed && !e.contested_at && !!end && opts.now - Date.parse(end) <= NETWORK_PARAMS.contestDays * DAY,
    reopen: m && !!s && (s.status === "paid" || s.status === "waived") && !e.contested_at,
    remind: !!s && owes && (s.status === "due" || s.status === "disputed"),
    excludeDriver: m && e.driver_excluded !== true,
    excludePartner: m && !opts.partnerExcluded,
  };
}

/**
 * État lisible quand il n'y a pas (encore) de règlement : course en cours chez le partenaire, exécution close sans
 * fin de course (retrait, annulation…), ou terminée sans montant. null : le badge du règlement suffit.
 */
export function givenProgress(item: NetworkGivenItem): { label: string; tone: Tone } | null {
  if (item.settlement) return null;
  const e = item.execution;
  if (!e.ended_at && item.ride.status !== "COMPLETED") {
    const meta = RIDE_STATUS_META[item.ride.status];
    return { label: meta?.short ?? item.ride.status, tone: meta?.tone ?? "neutral" };
  }
  if (e.end_reason && e.end_reason !== "completed") return { label: NETWORK_EXECUTION_END_LABELS[e.end_reason], tone: "neutral" };
  return { label: "Terminée", tone: "green" };
}

/** « Position absente pendant la course · Durée très inférieure à l'estimation » */
export function suspectText(item: NetworkGivenItem): string {
  return item.execution.suspect_reasons.map((r) => NETWORK_SUSPECT_REASON_META[r]?.label ?? r).join(" · ");
}
