// Lisibilité du réseau partagé (« pourquoi rien n'arrive », spec §6.4) : état de l'organisation (org_network_readiness)
// et des chauffeurs (network_driver_readiness), avec UNE action par manque. Libellés : NETWORK_READINESS_META.
// Module pur : en-tête de l'onglet, Réglages, bandeau de la convention, tests.
import {
  DRIVER_NETWORK_READINESS_CODES, DRIVER_NETWORK_READINESS_META, ORG_NETWORK_READINESS_CODES, ORG_NETWORK_READINESS_META,
  formatDate, networkText,
  type DispatchModel, type DriverNetworkReadinessCode, type NetworkDriverReadiness, type NetworkReadinessAction,
  type OrgNetworkReadiness, type OrgNetworkReadinessCode,
} from "@rydar/shared";
import { networkShareHref } from "./paths";

export type ReadinessSide = "out" | "in";
/** active : toutes les conditions remplies ; pending : demandé mais une condition manque ; off : désactivé */
export type SideState = "active" | "pending" | "off";

export const SIDE_TITLES: Record<ReadinessSide, string> = {
  out: "Partage de vos courses",
  in: "Réception des courses du réseau",
};
export const SIDE_STATE_TEXT: Record<SideState, string> = { active: "Actif", pending: "En attente", off: "Désactivé" };

/** Ancres des cartes de Réglages (liens d'action). */
export const SETTINGS_ANCHORS = {
  share: "partager",
  receive: "recevoir",
  payment: "encaissement",
  terms: "convention",
  advanced: "options",
} as const;

export type ReadinessLink = { label: string; href: string; external?: boolean };

/** Page visée par une action de l'organisation (null : action sans lien, ex. attendre Rydar). */
export function orgActionHref(action: NetworkReadinessAction, model: DispatchModel): string | null {
  switch (action) {
    case "enable_sharing":
      return networkShareHref({ tab: "reglages" }, SETTINGS_ANCHORS.share);
    case "enable_receiving":
    case "confirm_insurance":
      return networkShareHref({ tab: "reglages" }, SETTINGS_ANCHORS.receive);
    case "accept_terms":
      return networkShareHref({ tab: "reglages" }, SETTINGS_ANCHORS.terms);
    case "edit_organization":
      return "/dashboard/settings?tab=org";
    case "edit_payment_methods":
      // UNE seule source des moyens de paiement : centrale → « Commission & encaissement » ; flotte → carte de l'onglet
      return model === "centrale" ? "/dashboard/settings?tab=centrale" : networkShareHref({ tab: "reglages" }, SETTINGS_ANCHORS.payment);
    case "view_payouts":
      return networkShareHref({ tab: "confiees", filter: "to_pay" });
    case "contact_rydar":
      return "/contact";
    case "view_settlements":
      return "/dashboard/settlements";
    default:
      // Actions d'un chauffeur (driverActionHref) ou de l'application
      return null;
  }
}

/** Page visée par l'action « organisation » d'un manque de chauffeur (liste « Prêt / Manque » de B). */
export function driverActionHref(action: NetworkReadinessAction, driverId: string): string | null {
  switch (action) {
    case "review_documents":
    case "edit_driver":
      return `/dashboard/drivers/${driverId}`;
    case "view_settlements":
      return `/dashboard/settlements?driver=${driverId}`;
    case "enable_receiving":
      return networkShareHref({ tab: "reglages" }, SETTINGS_ANCHORS.receive);
    default:
      // allow_driver : interrupteur « Autorisé » de la même ligne
      return null;
  }
}

export interface OrgReadinessItem {
  code: OrgNetworkReadinessCode;
  label: string;
  hint: string;
  blocking: boolean;
  action: ReadinessLink | null;
  sides: ReadinessSide[];
}

export interface OrgReadinessView {
  sides: Record<ReadinessSide, { state: SideState; title: string; text: string; action: ReadinessLink | null }>;
  /** Manques et avertissements des sens demandés, chacun une fois, dans l'ordre de ORG_NETWORK_READINESS_CODES */
  items: OrgReadinessItem[];
  /** Rien n'est demandé (deux sens désactivés) */
  idle: boolean;
}

const OFF_CODE: Record<ReadinessSide, OrgNetworkReadinessCode> = { out: "not_sharing", in: "not_receiving" };
const SIDE_ACTIVATE: Record<ReadinessSide, ReadinessLink> = {
  out: { label: "Activer le partage", href: networkShareHref({ tab: "reglages" }, SETTINGS_ANCHORS.share) },
  in: { label: "Activer la réception", href: networkShareHref({ tab: "reglages" }, SETTINGS_ANCHORS.receive) },
};
const HIDDEN: ReadonlySet<OrgNetworkReadinessCode> = new Set(["network_off", "not_sharing", "not_receiving"]);

function sideState(r: OrgNetworkReadiness, side: ReadinessSide): SideState {
  const s = side === "out" ? r.share_out : r.share_in;
  if (s.active) return "active";
  return s.missing.includes(OFF_CODE[side]) ? "off" : "pending";
}

/** Explication d'un manque, date de fin de grâce et motifs de Rydar insérés. */
function itemHint(code: OrgNetworkReadinessCode, r: OrgNetworkReadiness, timeZone: string): string {
  const meta = ORG_NETWORK_READINESS_META[code];
  const hint = networkText(meta.hint, { date: r.terms.grace_until ? formatDate(r.terms.grace_until, timeZone) : "la fin du délai" });
  if (code === "approval_refused" && r.approval.refused_reason) return `${hint} Motif : ${r.approval.refused_reason}`;
  if (code === "suspended" && r.suspended_reason) return `${hint} Motif : ${r.suspended_reason}`;
  return hint;
}

/** En-tête de l'onglet : état de chaque sens + liste des manques, chacun avec UNE action (ou aucune). */
export function orgReadinessView(r: OrgNetworkReadiness, model: DispatchModel, timeZone: string): OrgReadinessView {
  const states = { out: sideState(r, "out"), in: sideState(r, "in") };
  const bySide = new Map<OrgNetworkReadinessCode, ReadinessSide[]>();
  for (const side of ["out", "in"] as const) {
    if (states[side] === "off") continue; // sens non demandé : ses conditions ne sont pas encore utiles
    const s = side === "out" ? r.share_out : r.share_in;
    for (const code of [...s.missing, ...s.warnings]) {
      if (HIDDEN.has(code)) continue;
      bySide.set(code, [...(bySide.get(code) ?? []), side].filter((v, i, a) => a.indexOf(v) === i));
    }
  }
  const items: OrgReadinessItem[] = ORG_NETWORK_READINESS_CODES.filter((c) => bySide.has(c)).map((code) => {
    const meta = ORG_NETWORK_READINESS_META[code];
    const href = meta.action ? orgActionHref(meta.action.action, model) : null;
    return {
      code,
      label: meta.label,
      hint: itemHint(code, r, timeZone),
      blocking: meta.blocking,
      action: meta.action && href ? { label: meta.action.label, href } : null,
      sides: bySide.get(code)!,
    };
  });
  const side = (k: ReadinessSide) => ({
    state: states[k],
    title: SIDE_TITLES[k],
    text: SIDE_STATE_TEXT[states[k]],
    action: states[k] === "off" ? SIDE_ACTIVATE[k] : null,
  });
  return { sides: { out: side("out"), in: side("in") }, items, idle: states.out === "off" && states.in === "off" };
}

/** Phrase courte d'un sens demandé : « Actif » ou « En attente : {premier manque} ». */
export function sideSummary(r: OrgNetworkReadiness, side: ReadinessSide): string {
  const state = sideState(r, side);
  if (state !== "pending") return SIDE_STATE_TEXT[state];
  const s = side === "out" ? r.share_out : r.share_in;
  const code = ORG_NETWORK_READINESS_CODES.find((c) => !HIDDEN.has(c) && s.missing.includes(c));
  if (code === "approval_pending") return "En attente de validation par Rydar";
  return code ? `En attente : ${ORG_NETWORK_READINESS_META[code].label.toLowerCase()}` : SIDE_STATE_TEXT.pending;
}

/**
 * Bandeau owner / admin « nouvelle convention à accepter » (onglet et tableau de bord) : convention déjà acceptée
 * une fois, mais pas la version courante (délai de grâce en cours, ou expiré : le réseau est alors arrêté).
 */
export function networkTermsDue(r: OrgNetworkReadiness | null | undefined): { version: string; graceUntil: string | null; expired: boolean } | null {
  if (!r?.enabled) return null;
  const accepted = r.terms.accepted_version;
  if (!accepted || accepted === r.terms.version) return null;
  const inGrace = accepted === r.terms.min_version && !!r.terms.grace_until && Date.parse(r.terms.grace_until) > Date.now();
  return { version: r.terms.version, graceUntil: inGrace ? r.terms.grace_until : null, expired: !inGrace };
}

export interface DriverReadinessView {
  ready: boolean;
  /** « Prêt » ou « Manque : carte VTC à valider » */
  text: string;
  /** Tous les manques (infobulle) */
  missing: { code: DriverNetworkReadinessCode; label: string; hint: string }[];
  /** UNE action pour l'organisation : celle du premier manque qui en propose une */
  action: (ReadinessLink & { kind: NetworkReadinessAction }) | null;
  /** allow_driver : l'interrupteur « Autorisé » de la ligne suffit */
  needsAllow: boolean;
}

const DRIVER_HIDDEN: ReadonlySet<DriverNetworkReadinessCode> = new Set(["network_off"]);

/** Ligne d'un chauffeur de B dans Réglages (« Prêt » / « Manque : … »). */
export function driverReadinessView(r: NetworkDriverReadiness, driverId: string, timeZone: string): DriverReadinessView {
  const date = (iso: string | null) => (iso ? formatDate(iso, timeZone) : "la fin du délai");
  const missing = DRIVER_NETWORK_READINESS_CODES.filter((c) => !DRIVER_HIDDEN.has(c) && r.missing.includes(c)).map((code) => {
    const meta = DRIVER_NETWORK_READINESS_META[code];
    return { code, label: meta.label, hint: networkText(meta.hint, { date: date(code === "excluded_until" ? r.excluded_until : r.terms_grace_until) }) };
  });
  let action: DriverReadinessView["action"] = null;
  for (const m of missing) {
    const step = DRIVER_NETWORK_READINESS_META[m.code].organization;
    const href = step ? driverActionHref(step.action, driverId) : null;
    if (step && href) {
      action = { label: step.label, href, kind: step.action };
      break;
    }
  }
  const ready = r.ready && missing.length === 0;
  return {
    ready,
    text: ready ? "Prêt" : missing.length ? `Manque : ${missing[0]!.label.charAt(0).toLowerCase()}${missing[0]!.label.slice(1)}` : "Non prêt",
    missing,
    action,
    needsAllow: missing.some((m) => m.code === "org_disallowed"),
  };
}
