// Super admin — /admin/reseau (spec §12.4) : interrupteur global, convention, « À valider », tableau des
// organisations (30 jours, seuils signalés), suspensions. Module pur (tests : admin.test.ts) : libellés, seuils, saisie.
// Rydar ne fait qu'une vérification administrative (inscription au registre VTC, documents, convention, frais) ; une
// suspension sanctionne un manquement à la convention ou aux CGV, jamais la qualité d'un partenaire (§7.1).
import {
  NETWORK_ADMIN_THRESHOLDS, formatDate, formatPrice,
  type AdminNetworkOrgRow, type NetworkAdminFlag, type NetworkApprovalStatus, type NetworkMembership, type NetworkTermsState, type Tone,
} from "@rydar/shared";
import { z } from "zod";

export const APPROVAL_META: Record<NetworkApprovalStatus, { label: string; tone: Tone }> = {
  none: { label: "Pas de demande", tone: "neutral" },
  pending: { label: "À valider", tone: "amber" },
  approved: { label: "Validée", tone: "green" },
  refused: { label: "Refusée", tone: "red" },
  lost: { label: "À revalider", tone: "amber" },
};

/**
 * État de validation d'après la ligne network_memberships (fiche organisation du super admin) : validée, refusée,
 * à revalider (validation perdue après un changement de nom ou de n°, G11 : approved_at vidé, approved_by gardé),
 * à valider, ou pas de demande.
 */
export function membershipApproval(m: Pick<NetworkMembership, "approved_at" | "approved_by" | "refused_reason" | "requested_at"> | null): NetworkApprovalStatus {
  if (!m) return "none";
  if (m.approved_at) return "approved";
  if (m.refused_reason) return "refused";
  if (m.approved_by) return "lost";
  return m.requested_at ? "pending" : "none";
}

const T = NETWORK_ADMIN_THRESHOLDS;
const pct = (ratio: number) => `${Math.round(ratio * 100)} %`;

/** Seuils signalés sur 30 jours (mêmes valeurs que le SQL : NETWORK_ADMIN_THRESHOLDS). */
export const FLAG_META: Record<NetworkAdminFlag, { label: string; hint: string }> = {
  low_acceptance: {
    label: "Acceptation faible",
    hint: `moins de ${pct(T.minAcceptanceRatio)} des offres acceptées (au moins ${T.minOffersForRatio} offres reçues en 30 jours)`,
  },
  releases: { label: "Retraits répétés", hint: `au moins ${T.releases} courses retirées après acceptation en 30 jours` },
  contests: { label: "Courses contestées", hint: `au moins ${T.contests} courses contestées en 30 jours` },
  payout_overdue: { label: "Versement en retard", hint: `un versement à un chauffeur partenaire a plus de ${T.payoutOverdueDays} jours de retard` },
};

/** Part des offres acceptées sur 30 jours ; null en dessous de 20 offres (non significatif). */
export function acceptanceRatio(stats: AdminNetworkOrgRow["stats_30d"]): number | null {
  return stats.offers_received >= T.minOffersForRatio ? stats.offers_accepted / stats.offers_received : null;
}

/** Seuils dépassés : ceux renvoyés par la base, complétés par le même calcul (jamais en double). */
export function rowFlags(row: Pick<AdminNetworkOrgRow, "flags" | "stats_30d">): NetworkAdminFlag[] {
  const s = row.stats_30d;
  const ratio = acceptanceRatio(s);
  const computed: NetworkAdminFlag[] = [
    ...(ratio != null && ratio < T.minAcceptanceRatio ? (["low_acceptance"] as const) : []),
    ...(s.releases_after_accept >= T.releases ? (["releases"] as const) : []),
    ...(s.contested_rides >= T.contests ? (["contests"] as const) : []),
    ...(s.overdue_payouts > 0 ? (["payout_overdue"] as const) : []),
  ];
  const all = new Set<NetworkAdminFlag>([...(row.flags ?? []), ...computed]);
  return (Object.keys(FLAG_META) as NetworkAdminFlag[]).filter((f) => all.has(f));
}

/** Frais Rydar actuels : « 5 % + 1,00 € », « 10 % », « Aucun » (+ « dérogation »). */
export function feeLabel(row: Pick<AdminNetworkOrgRow, "platform_fee_percent" | "platform_fee_fixed_cents" | "fee_waiver">, currency = "EUR"): string {
  const p = Number(row.platform_fee_percent) || 0;
  const f = Number(row.platform_fee_fixed_cents) || 0;
  const parts = [p > 0 ? `${String(p).replace(".", ",")} %` : null, f > 0 ? formatPrice(f, currency) : null].filter(Boolean);
  const base = parts.length ? parts.join(" + ") : "Aucun";
  return row.fee_waiver ? `${base} · dérogation` : base;
}

/** Validation : sans frais Rydar, le partage exige la dérogation « frais à 0 » (S12) — case proposée. */
export function needsFeeWaiver(row: Pick<AdminNetworkOrgRow, "platform_fee_percent" | "platform_fee_fixed_cents">): boolean {
  return !(Number(row.platform_fee_percent) > 0) && !(Number(row.platform_fee_fixed_cents) > 0);
}

/**
 * Champs de l'organisation à compléter avant validation (instantané montré aux partenaires) — mêmes contrôles que
 * svc_network_approve : raison sociale 2 à 160 caractères, SIRET 14 chiffres une fois espaces et séparateurs retirés,
 * n° VTC 3 à 120 caractères.
 */
export function missingIdentity(row: Pick<AdminNetworkOrgRow, "legal_name" | "siret" | "vtc_registration">): ("legal_name" | "siret" | "vtc_registration")[] {
  const legal = (row.legal_name ?? "").trim();
  const siret = (row.siret ?? "").replace(/[\s.\-/]/g, "");
  const vtc = (row.vtc_registration ?? "").trim();
  return [
    ...(legal.length < 2 || legal.length > 160 ? (["legal_name"] as const) : []),
    ...(!/^\d{14}$/.test(siret) ? (["siret"] as const) : []),
    ...(vtc.length < 3 || vtc.length > 120 ? (["vtc_registration"] as const) : []),
  ];
}

export const IDENTITY_LABELS: Record<"legal_name" | "siret" | "vtc_registration", string> = {
  legal_name: "raison sociale",
  siret: "SIRET",
  vtc_registration: "n° d'inscription au registre VTC",
};

/** Convention en vigueur : « Version 2026-11-01 » + version précédente acceptée jusqu'au … (délai de grâce). */
export function termsLines(terms: NetworkTermsState, timeZone = "Europe/Paris", now = Date.now()): { current: string; grace: string | null } {
  const grace =
    terms.min_version && terms.grace_until
      ? Date.parse(terms.grace_until) > now
        ? `Version précédente (${terms.min_version}) encore valable jusqu'au ${formatDate(terms.grace_until, timeZone)}`
        : `Délai de grâce de la version ${terms.min_version} terminé le ${formatDate(terms.grace_until, timeZone)}`
      : null;
  return { current: `Version ${terms.version}`, grace };
}

/** Tri du tableau : signalements d'abord, puis suspendues, puis par nom. */
export function sortOrgRows<R extends Pick<AdminNetworkOrgRow, "name" | "flags" | "stats_30d" | "suspended_at">>(rows: readonly R[]): R[] {
  return [...rows].sort(
    (a, b) => rowFlags(b).length - rowFlags(a).length || Number(!!b.suspended_at) - Number(!!a.suspended_at) || a.name.localeCompare(b.name, "fr"),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Saisie des actions (validées aussi en base : REASON_REQUIRED, NOT_FOUND)
// ---------------------------------------------------------------------------------------------------------------

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Organisation introuvable");
const reason = z.string().trim().min(5, "5 caractères au minimum").max(300, "300 caractères au maximum");

/** Valider (avec dérogation éventuelle) ou refuser (motif obligatoire, montré à l'organisation). */
export const networkReviewSchema = z.discriminatedUnion("approved", [
  z.object({ orgId: uuid, approved: z.literal(true), feeWaiver: z.boolean().default(false) }),
  z.object({ orgId: uuid, approved: z.literal(false), reason }),
]);

/** Suspendre (motif obligatoire : manquement à la convention ou aux CGV) ou rétablir (motif facultatif). */
export const networkSuspendSchema = z.discriminatedUnion("suspended", [
  z.object({ orgId: uuid, suspended: z.literal(true), reason }),
  z.object({
    orgId: uuid,
    suspended: z.literal(false),
    reason: z.string().trim().max(300, "300 caractères au maximum").optional().transform((v) => (v ? v : null)),
  }),
]);
