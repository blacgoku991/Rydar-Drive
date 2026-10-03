// Réseau partagé, côté app chauffeur : vues pures (offre partenaire, course, bon de réservation, lisibilité du profil,
// conditions, règlements partenaires, coordonnées bancaires, bandeau d'accueil). Module sans dépendance native
// (network.test.ts) ; les écrans ne font que présenter ce qu'il calcule.
//
// Décisions du propriétaire appliquées ici :
//   • le chauffeur partenaire est traité comme les chauffeurs de l'organisation qui confie la course (A) ; il voit UN
//     seul montant de part de A (« vous reverserez X € à {A} » ou « {A} vous versera X € »), jamais « frais Rydar » ni
//     « commission » ;
//   • il accepte et règle toujours lui-même (contrepartie chauffeur, aucun « J'ai compris ») ;
//   • interrupteur plateforme coupé (par défaut) : rien de nouveau n'apparaît, ni écran, ni réglage, ni bandeau, ni bon de
//     réservation (les sommes déjà dues restent affichées dans « Courses partenaires ») ;
//   • réseau ouvert par Rydar mais organisation qui ne le reçoit pas : ni réglage, ni conditions, ni bandeau ; seul le bon
//     de réservation apparaît sur ses courses (§7.5 et critère 28 : toutes les courses une fois le réseau ouvert).
import {
  DRIVER_NETWORK_READINESS_META, NETWORK_FORBIDDEN_WORDS, NETWORK_PARAMS, NETWORK_PICKUP_HIDDEN_LABEL, NETWORK_TERMS_REVIEWED,
  NETWORK_TERMS_VERSION, PAYMENT_METHOD_LABELS,
  driverCollects, formatDate, formatPhone, formatPrice, formatRideDate, formatTime, isNetworkBlocker, isValidIban, networkBlockerMessage,
  networkMoneyLine, networkText,
  type BookingVoucher, type DispatchModel, type DriverHomeNetwork, type DriverNetworkCreditor, type DriverNetworkReadinessCode,
  type DriverNetworkSettlementItem, type DriverNetworkSettlements, type DriverNetworkState, type DriverOffer, type DriverOfferV2,
  type DriverPayoutInfo, type DriverRide, type DriverRideMoney, type EarningsRide, type NetworkGiverInfo, type NetworkReadinessAction,
  type PaymentMethod, type Ride, type SettlementMethod,
} from "@rydar/shared";
import { blockerInfo, deductionCents, driverSettlementLabel, dueText, formatWhen, frTypo, NBSP, pastWhen } from "./settlement-text";

// =============================================================================
// Courses et offres vues par l'app
// =============================================================================

/**
 * Course vue par l'app : driver_ride / driver_rides_upcoming (liste blanche, propres et partenaires) ; serveur antérieur
 * (fonctions absentes) : ligne rides convertie par legacyRide, sans bon de réservation.
 */
export type AppRide = Omit<DriverRide, "voucher"> & {
  /** null : serveur antérieur, bon non fourni */
  voucher: BookingVoucher | null;
  /** Ligne rides d'un serveur antérieur (gérant qui roule : filtre de « Mes courses ») ; absent avec driver_rides_upcoming */
  driver_id?: string | null;
};

/** Contexte d'une ligne rides d'un serveur antérieur : modèle et nom de l'organisation du chauffeur (accueil). */
export type LegacyRideContext = { model?: DispatchModel | null; organization?: string | null };

/**
 * Ligne rides (select *, serveur antérieur à driver_ride) → AppRide. Argent comme avant : répartition de la course en
 * centrale ; flotte : ni part ni sens (jamais les frais Rydar d'une flotte, S20).
 */
export function legacyRide(row: Ride, ctx: LegacyRideContext = {}): AppRide {
  const collects = driverCollects(row.payment_method);
  const centrale = ctx.model === "centrale" && row.driver_payout_cents != null;
  const giverPart = centrale ? deductionCents(row) : null;
  const money: DriverRideMoney = {
    price_cents: row.price_cents,
    currency: row.currency || "EUR",
    payment_method: row.payment_method,
    collects,
    driver_part_cents: centrale ? row.driver_payout_cents ?? null : null,
    giver_part_cents: giverPart,
    direction: centrale ? (collects ? "driver_owes" : "centrale_owes") : null,
    amount_cents: centrale ? (collects ? giverPart : row.driver_payout_cents ?? null) : null,
    counterparty: null,
    creditor_name: centrale ? ctx.organization ?? null : null,
  };
  return {
    id: row.id,
    number: row.number,
    type: row.type,
    status: row.status,
    pickup_address: row.pickup_address,
    pickup_lat: row.pickup_lat,
    pickup_lng: row.pickup_lng,
    dropoff_address: row.dropoff_address,
    dropoff_lat: row.dropoff_lat,
    dropoff_lng: row.dropoff_lng,
    pickup_at: row.pickup_at,
    created_at: row.created_at,
    accepted_at: row.accepted_at,
    completed_at: row.completed_at,
    cancelled_at: row.cancelled_at,
    cancel_reason: row.cancel_reason,
    passengers: row.passengers,
    luggage: row.luggage,
    vehicle_category: row.vehicle_category,
    estimated_distance_m: row.estimated_distance_m,
    estimated_duration_s: row.estimated_duration_s,
    route_polyline: row.route_polyline ?? null,
    flight_number: row.flight_number,
    comment: row.comment,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    customer_visible_from: null,
    customer_visible_until: null,
    price_cents: row.price_cents,
    currency: row.currency || "EUR",
    payment_method: row.payment_method,
    flight_mode: row.flight_mode,
    flight_status: row.flight_status,
    flight_scheduled_arrival: row.flight_scheduled_arrival,
    flight_estimated_arrival: row.flight_estimated_arrival,
    flight_actual_arrival: row.flight_actual_arrival,
    flight_terminal: row.flight_terminal,
    flight_origin: row.flight_origin,
    flight_delay_minutes: row.flight_delay_minutes,
    pickup_at_original: row.pickup_at_original,
    money,
    network: null,
    voucher: null,
    driver_id: row.driver_id,
  };
}

/** Offre de driver_offers (serveur antérieur à driver_offers_v2) : jamais une offre partenaire. */
export const legacyOffer = (o: DriverOffer): DriverOfferV2 => ({ ...o, network: null });

/** Nom de l'organisation qui confie la course (instantané validé). */
export const giverName = (g: Pick<NetworkGiverInfo, "name"> | null | undefined) => g?.name?.trim() || "l'organisation partenaire";

/** Paiement à bord par carte d'une course partenaire : le terminal du chauffeur (C20). */
export const PARTNER_CARD_LABEL = "Carte à bord (votre terminal)";
export const partnerPaymentLabel = (pm: PaymentMethod) => (pm === "card" ? PARTNER_CARD_LABEL : PAYMENT_METHOD_LABELS[pm] ?? "");

/** Badge des courses partenaires (planning, gains, accueil). */
export const PARTNER_BADGE = "Partenaire";
/** Entrée des règlements partenaires d'un chauffeur de flotte (profil, gains, accueil), titre de l'écran. */
export const PARTNER_SETTLEMENTS_TITLE = "Courses partenaires";
/**
 * Onglet des règlements partenaires dans l'écran « Commissions » d'un chauffeur de centrale : court, pour tenir sur une
 * ligne à côté de sa pastille (« Courses partenaires » serait tronqué en « Courses partenair… » sur 360 à 390 pt).
 */
export const PARTNER_TAB_LABEL = "Partenaires";

/**
 * « Course partenaire · {A} » : le mot clé d'abord (un nom d'organisation long ne coupe jamais « partenaire » ; le nom
 * complet figure aussi dans la ligne d'argent).
 */
export const partnerRideTitle = (giver: string) => `Course partenaire · ${giver}`;

export type PartnerOfferView = {
  giver: string;
  /** « Course partenaire · {A} » */
  title: string;
  /** Lecteur d'écran : « Course partenaire de {A} » */
  label: string;
  /** « Vous gagnez » : part du chauffeur */
  gainCents: number;
  currency: string;
  /** Une seule ligne d'argent (networkMoneyLine) */
  line: string;
  paymentLabel: string;
  /** Commune / quartier (adresse exacte après acceptation) */
  pickup: string;
  dropoff: string;
  addressNote: string;
};

/** Offre partenaire (driver_offers_v2, bloc network) ; null : offre de sa propre organisation. */
export function partnerOfferView(o: Pick<DriverOfferV2, "network" | "currency">): PartnerOfferView | null {
  const n = o.network;
  if (!n) return null;
  const giver = giverName(n.giver);
  const currency = n.money.currency || o.currency || "EUR";
  return {
    giver,
    title: partnerRideTitle(giver),
    label: `Course partenaire de ${giver}`,
    gainCents: n.money.driver_part_cents,
    currency,
    line: frTypo(networkMoneyLine({ ...n.money, currency }, giver)),
    paymentLabel: partnerPaymentLabel(n.money.payment_method),
    pickup: n.pickup_area?.trim() || NETWORK_PICKUP_HIDDEN_LABEL,
    dropoff: n.dropoff_area?.trim() || "Arrivée communiquée après acceptation",
    addressNote: "Adresse exacte communiquée après acceptation",
  };
}

// =============================================================================
// Blocages d'une offre (propres : centrale ; réseau : règles locales de A et de B)
// =============================================================================

/** Où régler : commissions de sa propre organisation, ou courses partenaires. */
export type SettleTarget = "own" | "network";

export type OfferBlockView = {
  reason: string;
  label: string;
  message: string;
  /** Un règlement lève le blocage (« réservée aux confirmés » : non) */
  payable: boolean;
  target: SettleTarget;
  actionLabel: string;
};

/**
 * Motif de blocage d'une offre → libellé, message (celui du serveur d'abord, noms insérés), écran où régler. Réseau :
 * own_unpaid = commissions de sa propre organisation ; impayé ou plafond envers A, plafond de B = courses partenaires.
 */
export function offerBlockView(
  reason: string | null | undefined, serverMessage: string | null | undefined, names: { giver?: string | null; executor?: string | null } = {},
): OfferBlockView | null {
  if (!reason) return null;
  if (isNetworkBlocker(reason)) {
    const m = networkBlockerMessage(reason, names);
    const target: SettleTarget = reason === "own_unpaid" ? "own" : "network";
    return {
      reason, label: m.label, message: frTypo(serverMessage || m.message), payable: m.payable, target,
      actionLabel: target === "own" ? "Régler mes commissions" : "Régler",
    };
  }
  const info = blockerInfo(reason, serverMessage);
  return info && { ...info, target: "own", actionLabel: "Régler mes commissions" };
}

/**
 * Libellé et message d'un blocage réseau (noms insérés). Code inconnu de CETTE version de l'app (ajouté côté serveur
 * après une app livrée) : repli neutre, jamais lu dans NETWORK_BLOCKER_META (l'app n'a pas d'ErrorBoundary).
 */
export function blockerText(reason: string, names: { giver?: string | null; executor?: string | null } = {}) {
  if (isNetworkBlocker(reason)) return networkBlockerMessage(reason, names);
  const giver = names.giver?.trim();
  return {
    label: "Courses partenaires bloquées",
    message: giver ? `Les courses de ${giver} vous sont bloquées pour le moment.` : "Les courses partenaires vous sont bloquées pour le moment.",
    payable: true,
  };
}

/** Écran où régler : commissions de sa propre organisation, ou onglet des courses partenaires. */
export const settleHref = (target: SettleTarget) =>
  target === "network" ? ({ pathname: "/commissions", params: { tab: "network" } } as const) : ("/commissions" as const);

// =============================================================================
// Argent d'une course (driver_ride.money : l'affichage ne dépend plus du modèle de l'organisation)
// =============================================================================

export type RideMoneyView =
  | {
    kind: "partner"; giver: string; gainCents: number; collects: boolean; currency: string;
    /** Part de A (à bord) ou part du chauffeur (déjà payée) : le seul montant échangé avec A */
    amountCents: number;
    /** Ligne unique (networkMoneyLine) */
    line: string;
  }
  | { kind: "centrale"; gainCents: number; deductionCents: number; collects: boolean; currency: string }
  | { kind: "plain"; currency: string };

/** Affichage de l'argent d'une course, décidé par driver_ride.money (et le bloc network). */
export function rideMoneyView(r: Pick<AppRide, "money" | "network" | "currency">): RideMoneyView {
  const m = r.money;
  const currency = m?.currency || r.currency || "EUR";
  if (r.network && m && m.driver_part_cents != null) {
    const giver = giverName(r.network.giver);
    const giverPart = m.giver_part_cents ?? Math.max(0, (m.price_cents ?? 0) - m.driver_part_cents);
    const amount = m.amount_cents ?? (m.collects ? giverPart : m.driver_part_cents);
    return {
      kind: "partner", giver, gainCents: m.driver_part_cents, collects: m.collects, currency, amountCents: amount,
      line: frTypo(networkMoneyLine({
        price_cents: m.price_cents ?? 0, currency, collects: m.collects, driver_part_cents: m.driver_part_cents, giver_part_cents: giverPart,
      }, giver)),
    };
  }
  if (m && m.driver_part_cents != null) {
    return { kind: "centrale", gainCents: m.driver_part_cents, deductionCents: m.giver_part_cents ?? 0, collects: m.collects, currency };
  }
  return { kind: "plain", currency };
}

export type PartnerDoneView = {
  owes: boolean;
  title: string;
  sub: string;
  /** Échéance dépassée (sous-titre en couleur d'alerte) */
  late: boolean;
  /** Course déjà payée, coordonnées bancaires non renseignées : « Renseigner mon RIB » en bouton principal */
  payoutMissing: boolean;
};

/**
 * Récapitulatif de fin d'une course partenaire : « 12,50 € à régler à {A} » ou « {A} vous versera 37,50 € » ; course déjà
 * payée : où arrivera le versement (« Versement sur votre compte •••• 0189 sous 7 jours »), ou coordonnées bancaires à
 * renseigner (sans elles, {A} ne peut pas le verser). `payout` null : inconnu (jamais pris pour « non renseignées »).
 */
export function partnerDoneView(
  v: Extract<RideMoneyView, { kind: "partner" }>, item: DriverNetworkSettlementItem | null | undefined, tz?: string, now = Date.now(),
  payout?: DriverPayoutInfo | null,
): PartnerDoneView {
  const amount = formatPrice(item?.amount_cents ?? v.amountCents, v.currency);
  if (v.collects) {
    const due = item && item.status === "due" ? dueText(item.due_at, tz, now) : null;
    return {
      owes: true,
      title: frTypo(`${amount} à régler à ${v.giver}`),
      sub: due?.text ?? frTypo(`À régler avec les moyens de paiement de ${v.giver}`),
      late: due?.late ?? false,
      payoutMissing: false,
    };
  }
  const note = payoutNoteView(payout);
  const held = item?.on_hold && item.hold_until ? `Course à vérifier : versement retenu ${untilText(item.hold_until, tz, new Date(now))}` : null;
  const sub = held
    ? note?.missing ? `${held}. Renseignez vos coordonnées bancaires pour le recevoir.` : held
    : note
      ? note.missing ? note.text : `${note.text} sous ${NETWORK_PARAMS.payoutDays}${NBSP}jours`
      : `Versement par virement sous ${NETWORK_PARAMS.payoutDays}${NBSP}jours`;
  return { owes: false, title: frTypo(`${v.giver} vous versera ${amount}`), sub: frTypo(sub), late: false, payoutMissing: !!note?.missing };
}

/**
 * Versement d'une course déjà payée (fin de course, fiche course) : compte où il arrivera (IBAN masqué), ou coordonnées
 * bancaires à renseigner. null : coordonnées inconnues (état réseau pas encore lu, réseau coupé) — rien n'est affirmé.
 */
export function payoutNoteView(payout: DriverPayoutInfo | null | undefined): { missing: boolean; text: string } | null {
  if (!payout) return null;
  return payout.configured
    ? { missing: false, text: `Versement sur votre compte ${maskIban(payout.iban_last4)}` }
    : { missing: true, text: "Renseignez vos coordonnées bancaires pour recevoir ce versement" };
}

/** Course retirée pendant qu'elle était affichée : motif neutre (le retrait vient de A, de B ou du chien de garde). */
export const rideRemovedText = (r: Pick<AppRide, "network">) =>
  r.network ? frTypo(`Cette course de ${giverName(r.network.giver)} vous a été retirée.`) : "La centrale a réattribué cette course.";

/** Lecture d'une course avec sa provenance : `legacy` = repli sur la table rides (driver_ride absente du serveur, PGRST202). */
export type RideRead = { ride: AppRide | null; legacy: boolean };

/**
 * Suite d'une lecture de la course affichée : « show » (afficher), « removed » (retirée pendant qu'elle était affichée),
 * « missing » (jamais lisible), « keep » (garder l'affichage). Une lecture de repli (table rides) ne montre jamais une
 * course partenaire (RLS : courses propres seulement) : elle ne prouve pas un retrait (PGRST202 aussi quand les noms de
 * paramètres diffèrent du contrat), l'affichage est gardé.
 */
export function rideReadAction(previous: AppRide | null, res: RideRead): "show" | "keep" | "removed" | "missing" {
  if (res.legacy && previous?.network) return "keep";
  if (res.ride) return "show";
  return previous ? "removed" : "missing";
}

/** « jusqu'à 20:06 », « jusqu'à demain 06:30 », « jusqu'au jeu. 25/09 06:30 » */
export function untilText(iso: string, tz?: string, now = new Date()) {
  const w = formatWhen(iso, tz, now);
  return w.startsWith("le ") ? `jusqu'au ${w.slice(3)}` : `jusqu'à ${w}`;
}

/** « Reçu ou facture du client : délivré par {A} » */
export const receiptText = (giver: string) => frTypo(`Reçu ou facture du client : délivré par ${giver}`);

/**
 * Course partenaire sans coordonnées du client : fenêtre de visibilité (1 h avant la prise en charge, jusqu'à 1 h
 * après la fin). null : course de sa propre organisation, ou client affiché.
 */
export function clientWindowNote(
  r: Pick<AppRide, "network" | "customer_name" | "customer_phone" | "customer_visible_until">, now = Date.now(),
): string | null {
  if (!r.network || r.customer_name || r.customer_phone) return null;
  const until = r.customer_visible_until ? Date.parse(r.customer_visible_until) : Number.NaN;
  if (Number.isFinite(until) && now >= until) return "Coordonnées du client effacées 1 h après la fin de la course.";
  return "Coordonnées du client visibles 1 h avant la prise en charge.";
}

/** Téléphone de A encore affichable (jusqu'à fin + 48 h, prolongé tant qu'un règlement est ouvert). */
export function giverPhone(r: Pick<AppRide, "network">, now = Date.now()): string | null {
  const g = r.network?.giver;
  if (!g?.phone) return null;
  if (g.phone_until && Date.parse(g.phone_until) <= now) return null;
  return g.phone;
}

// =============================================================================
// Bon de réservation (§7.5) : toutes les courses
// =============================================================================

export type VoucherLine = { key: "booked_by" | "operator" | "customer" | "booked_at" | "pickup"; label: string; value: string };

const join = (parts: (string | null | undefined | false)[]) => parts.filter((p): p is string => !!p && p.trim() !== "").join(" · ");
const at = (iso: string, tz?: string) => `${formatDate(iso, tz)} à ${formatTime(iso, tz)}`;

/** Lignes du bon (organisation qui a pris la réservation, exploitant, client, dates, lieu) et mention du reçu. */
export function voucherView(v: BookingVoucher, tz?: string): { lines: VoucherLine[]; receipt: string } {
  const b = v.booked_by;
  const bookedName = b.legal_name && b.legal_name !== b.name ? `${b.name} (${b.legal_name})` : b.name;
  const operatorName = v.operator.kind === "driver" ? `${v.operator.name} (chauffeur indépendant)` : v.operator.name;
  return {
    lines: [
      {
        key: "booked_by", label: "Réservation prise par",
        value: join([bookedName, b.vtc_registration && `inscription VTC n°${NBSP}${b.vtc_registration}`, b.phone && formatPhone(b.phone)]),
      },
      {
        key: "operator", label: "Exploitant qui exécute la course",
        value: join([operatorName, v.operator.vtc_registration && `inscription VTC n°${NBSP}${v.operator.vtc_registration}`]),
      },
      {
        key: "customer", label: "Client",
        value: v.customer ? join([v.customer.name, v.customer.phone && formatPhone(v.customer.phone)]) : "Communiqué 1 h avant la prise en charge",
      },
      { key: "booked_at", label: "Réservation faite le", value: at(v.booked_at, tz) },
      { key: "pickup", label: "Prise en charge", value: join([at(v.pickup_at, tz), v.pickup_address]) },
    ],
    receipt: receiptText(v.receipt_by),
  };
}

/**
 * Bon affiché : course partenaire, ou toute course dès que Rydar a ouvert le réseau partagé (état réseau lu, sans
 * `network_off`), y compris pour une organisation qui ne reçoit pas le réseau (§7.5 et critère 28 : « toutes les
 * courses de l'app » ; seul changement visible pour elle). Interrupteur plateforme coupé (par défaut) : rien de nouveau
 * dans l'app, même si le serveur envoie un bon.
 */
export function showVoucher(r: Pick<AppRide, "voucher" | "network">, s: DriverNetworkState | null | undefined): boolean {
  if (!r.voucher) return false;
  if (r.network) return true;
  return !!s && !(s.readiness?.missing ?? []).includes("network_off");
}

// =============================================================================
// Réglage « Courses du réseau partagé » (profil) et conditions
// =============================================================================

/**
 * Réseau visible dans l'app : interrupteur plateforme ouvert ET organisation du chauffeur qui reçoit le réseau. Sinon
 * rien de nouveau (ni réglage, ni conditions, ni bandeau) — les sommes déjà dues restent dans « Courses partenaires ».
 */
export function networkVisible(s: DriverNetworkState | null | undefined): boolean {
  if (!s) return false;
  const missing = s.readiness?.missing ?? [];
  if (missing.includes("network_off") || missing.includes("org_reception_off")) return false;
  return !!s.organization?.receiving;
}

/** Version des conditions acceptée = version en vigueur (pas seulement encore valable pendant la grâce). */
export const currentTermsAccepted = (s: DriverNetworkState) => !!s.accepted_version && s.accepted_version === s.terms?.version;

export type NetworkStatusTone = "green" | "amber" | "red" | "muted";
export type NetworkStep = { kind: NetworkReadinessAction; label: string };
export type DriverNetworkStatus = {
  tone: NetworkStatusTone;
  /** « Actif », « Désactivé », ou libellé du premier manque */
  title: string;
  hint: string | null;
  /** Un seul bouton (premier manque), null : rien à faire dans l'app */
  action: NetworkStep | null;
  /** Avertissement non bloquant : nouvelles conditions à accepter avant le … */
  warning: { text: string; action: NetworkStep } | null;
};

/** Raisons de l'organisation : l'interrupteur du chauffeur n'y change rien. */
const ORG_SIDE: DriverNetworkReadinessCode[] = ["inactive", "org_disallowed"];

/**
 * Code de lisibilité connu de CETTE version de l'app. Le SQL peut en ajouter après une app livrée (EAS Update) : un code
 * inconnu est ignoré, jamais lu dans DRIVER_NETWORK_READINESS_META (l'app n'a pas d'ErrorBoundary).
 */
const knownReadiness = (c: string): c is DriverNetworkReadinessCode => Object.prototype.hasOwnProperty.call(DRIVER_NETWORK_READINESS_META, c);

/** Manque que cette version de l'app ne sait pas nommer : repli neutre. */
const UNKNOWN_READINESS = { label: "Réseau partagé indisponible", hint: "Les courses du réseau partagé sont indisponibles pour le moment." };

function readinessDate(code: DriverNetworkReadinessCode, s: DriverNetworkState, tz?: string) {
  const iso = code === "excluded_until" ? s.readiness.excluded_until ?? s.excluded_until : code === "terms_grace" ? s.readiness.terms_grace_until : null;
  return iso ? formatDate(iso, tz) : "";
}

/** État sous l'interrupteur du profil : « Actif », ou le premier manque avec son action. */
export function driverNetworkStatus(s: DriverNetworkState, tz?: string): DriverNetworkStatus {
  const r = s.readiness;
  const missing = r?.missing ?? [];
  const grace = (r?.warnings ?? []).includes("terms_grace") && !currentTermsAccepted(s)
    ? {
      text: frTypo(networkText(DRIVER_NETWORK_READINESS_META.terms_grace.hint, { date: readinessDate("terms_grace", s, tz) })),
      action: { kind: "open_network_terms" as const, label: DRIVER_NETWORK_READINESS_META.terms_grace.driver?.label ?? "Lire les conditions" },
    }
    : null;
  const orgSide = missing.find((c) => ORG_SIDE.includes(c));
  if (orgSide) {
    const meta = DRIVER_NETWORK_READINESS_META[orgSide];
    return { tone: "amber", title: meta.label, hint: frTypo(meta.hint), action: null, warning: null };
  }
  if (!s.enabled) {
    return {
      tone: "muted", title: "Désactivé",
      hint: "Activez-les pour recevoir aussi les courses d'organisations partenaires proches de vous, quand aucun de leurs chauffeurs n'est disponible.",
      action: null, warning: null,
    };
  }
  if (r?.ready) {
    return { tone: "green", title: "Actif", hint: "Vous recevez aussi les courses d'organisations partenaires proches de vous.", action: null, warning: grace };
  }
  const first = missing.find((c) => c !== "driver_off" && c !== "terms_grace" && knownReadiness(c));
  if (!first) {
    return missing.some((c) => !knownReadiness(c))
      ? { tone: "amber", title: UNKNOWN_READINESS.label, hint: UNKNOWN_READINESS.hint, action: null, warning: grace }
      : { tone: "amber", title: "En attente", hint: null, action: null, warning: grace };
  }
  const meta = DRIVER_NETWORK_READINESS_META[first];
  return {
    tone: first.startsWith("blocked:") ? "red" : "amber",
    title: meta.label,
    hint: frTypo(networkText(meta.hint, { date: readinessDate(first, s, tz) })),
    action: meta.driver ? { kind: meta.driver.action, label: meta.driver.label } : null,
    warning: grace,
  };
}

/**
 * Écran des conditions proposé une fois à l'accueil : organisation qui reçoit le réseau, conditions en vigueur pas
 * encore acceptées, jamais proposées pour cette version. Pas de relance d'un chauffeur qui a arrêté lui-même.
 */
export function shouldProposeNetworkTerms(s: DriverNetworkState | null | undefined, proposedVersion: string | null | undefined): boolean {
  if (!s || !networkVisible(s)) return false;
  const missing = s.readiness?.missing ?? [];
  if (!s.org_allowed || ORG_SIDE.some((c) => missing.includes(c))) return false;
  const version = s.terms?.version;
  if (!version || currentTermsAccepted(s) || proposedVersion === version) return false;
  return s.enabled || s.accepted_version == null;
}

/** Bascule de l'interrupteur vers « activé » : conditions en vigueur à accepter d'abord (écran), sinon activation directe. */
export const enableNeedsTerms = (s: DriverNetworkState) => !currentTermsAccepted(s);

/** Bouton de l'écran des conditions : accepter (déjà actif), accepter ET activer (ne reçoit pas ces courses), activer seul. */
export type NetworkTermsPrimary = "J'accepte" | "J'accepte et j'active" | "Activer";

export type NetworkTermsContent = {
  title: string;
  lead: string;
  points: string[];
  /** Ce que vaut le bouton (accepter une version, et activer s'il ne reçoit pas ces courses) ; null : simple activation */
  note: string | null;
  /** null : déjà accepté et activé (« Fermer ») */
  primary: NetworkTermsPrimary | null;
  /** Confirmation affichée au retour, une fois l'action faite */
  done: string;
  /** Texte pas encore relu par le juriste (NETWORK_TERMS_REVIEWED) : mention au-dessus du bouton */
  review: string | null;
  version: string;
};

/**
 * Conditions du chauffeur (§7.3), adaptées aux décisions : il règle toujours lui-même, un seul écran d'acceptation (jamais
 * « J'ai compris »). Accepter active aussi les courses du réseau partagé : c'est dit sur le bouton et dans la note quand le
 * chauffeur ne les reçoit pas (première fois, ou arrêtées lui-même). Aucun mot interdit (NETWORK_FORBIDDEN_WORDS) : Rydar
 * n'est qu'un logiciel de dispatch.
 */
export function networkTermsContent(
  s: DriverNetworkState | null | undefined, now = new Date(), reviewed: boolean = NETWORK_TERMS_REVIEWED,
): NetworkTermsContent {
  const b = s?.organization?.name?.trim() || "votre organisation";
  const version = s?.terms?.version || NETWORK_TERMS_VERSION;
  const enabled = !!s?.enabled;
  const accepted = !!s?.accepted_version && s.accepted_version === version;
  const updated = !!s?.accepted_version && !accepted;
  const graceUntil = updated && enabled && s?.terms?.grace_until && Date.parse(s.terms.grace_until) > now.getTime() ? s.terms.grace_until : null;
  const lead = accepted
    ? enabled
      ? `Vous recevez aussi les courses du réseau partagé, pour le compte de ${b}.`
      : "Vous avez déjà accepté ces conditions : activez les courses du réseau partagé pour en recevoir."
    : updated
      ? enabled
        ? `Les conditions des courses du réseau partagé ont changé.${graceUntil ? ` Les précédentes restent valables jusqu'au ${formatDate(graceUntil)}.` : ""} Lisez-les, puis acceptez-les pour continuer à recevoir ces courses.`
        : "Les conditions des courses du réseau partagé ont changé. Lisez-les, puis acceptez-les pour recevoir de nouveau ces courses."
      : `${b} reçoit les courses du réseau partagé : des courses d'autres organisations qu'aucun de leurs chauffeurs n'a acceptées. Lisez ces conditions avant d'en recevoir.`;
  const primary: NetworkTermsPrimary | null = accepted ? (enabled ? null : "Activer") : enabled ? "J'accepte" : "J'accepte et j'active";
  const dated = `les conditions des courses du réseau partagé (version du ${formatDate(version)})`;
  const note = primary === "J'accepte"
    ? `En touchant « J'accepte », vous acceptez ${dated}.`
    : primary === "J'accepte et j'active"
      ? `En touchant « J'accepte et j'active », vous acceptez ${dated} et activez ces courses.`
      : null;
  const points = [
    `Vous faites la course pour le compte de ${b}.`,
    `Si le client paie à bord, vous réglez la part de l'organisation qui vous confie la course, pour le compte de ${b}, avec les moyens de paiement qu'elle propose.`,
    "Si le client a déjà payé, cette organisation vous verse votre part.",
    "Les montants sont affichés avant d'accepter la course et ne changent plus ensuite.",
    "L'organisation qui vous confie la course reçoit votre prénom, l'initiale de votre nom, votre véhicule, votre plaque, votre téléphone et le n° de votre carte VTC.",
    "Vous pouvez arrêter à tout moment dans votre profil.",
  ];
  return {
    title: "Courses du réseau partagé",
    lead: frTypo(lead),
    points: points.map(frTypo),
    note: note && frTypo(note),
    primary,
    done: primary === "J'accepte" ? "Nouvelles conditions acceptées" : "Courses du réseau partagé activées",
    review: reviewed ? null : frTypo("Texte en cours de relecture juridique : s'il change, la nouvelle version vous sera proposée."),
    version,
  };
}

// =============================================================================
// Coordonnées bancaires (versements des courses déjà payées) : IBAN jamais réaffiché en entier
// =============================================================================

/** « •••• 1234 » : seuls les 4 derniers caractères sont connus de l'app. */
export const maskIban = (last4: string | null | undefined) => (last4 ? `••••${NBSP}${last4}` : "—");
export const normalizeIban = (v: string) => v.replace(/\s+/g, "").toUpperCase();
export const normalizeBic = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, "").toUpperCase();

export type PayoutForm = { payee: string; iban: string; bic: string };

/** Contrôles du formulaire (mêmes règles que le serveur, PAYOUT_DETAILS_INVALID) : titulaire, IBAN (clé), BIC facultatif. */
export function payoutFormErrors(f: PayoutForm): Partial<Record<keyof PayoutForm, string>> {
  const errors: Partial<Record<keyof PayoutForm, string>> = {};
  const payee = f.payee.trim();
  if (payee.length < 2 || payee.length > 120) errors.payee = frTypo("Titulaire : entre 2 et 120 caractères.");
  if (!normalizeIban(f.iban)) errors.iban = "Saisissez l'IBAN complet.";
  else if (!isValidIban(f.iban)) errors.iban = frTypo("IBAN invalide : vérifiez les chiffres.");
  const bic = normalizeBic(f.bic);
  if (bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) errors.bic = frTypo("BIC invalide : 8 ou 11 caractères.");
  return errors;
}

// =============================================================================
// Accueil : bandeau des courses partenaires
// =============================================================================

export type BannerTone = "red" | "amber" | "green";
export type BannerIcon = "lock-closed-outline" | "wallet-outline" | "arrow-down-circle-outline";
export type BannerView = { tone: BannerTone; icon: BannerIcon; title: string; sub: string | null; late: boolean; alert: boolean; cta: string };

/**
 * Sommes des courses partenaires (driver_home().network) : blocage (rouge), à régler (ambre, retard en rouge), à
 * recevoir (vert). null : rien à signaler. `executor` : nom de l'organisation du chauffeur (plafond de B).
 */
export function networkHomeBanner(n: DriverHomeNetwork | null | undefined, executor: string | null | undefined, currency = "EUR"): BannerView | null {
  if (!n) return null;
  const creditors = n.creditors ?? [];
  // Titre court (jamais tronqué) ; l'organisation dans le sous-titre
  const who = (list: { name: string }[]) =>
    list.length === 1 ? `Courses partenaires · ${list[0]!.name}` : `Courses partenaires · ${list.length}${NBSP}organisations`;
  const owing = creditors.filter((c) => c.owed_cents > 0);
  const owed = formatPrice(n.owed_cents, currency);
  const blockedCreditor = creditors.find((c) => c.blocked);
  const executorLimit = (n.readiness?.missing ?? []).includes("blocked:executor_limit");
  if (blockedCreditor || executorLimit) {
    const m = executorLimit
      ? networkBlockerMessage("executor_limit", { executor })
      : blockerText(blockedCreditor!.blocked!, { giver: blockedCreditor!.name, executor });
    return {
      tone: "red", icon: "lock-closed-outline", alert: true, late: false, cta: "Régler",
      title: n.owed_cents > 0 ? `${owed} à régler` : m.label,
      sub: frTypo(m.message),
    };
  }
  if (n.owed_cents > 0) {
    const late = n.overdue_cents > 0;
    return {
      tone: "amber", icon: "wallet-outline", alert: false, late, cta: "Payer",
      title: `${owed} à régler`,
      sub: late ? frTypo(`Dont ${formatPrice(n.overdue_cents, currency)} en retard : réglez maintenant`) : who(owing.length > 0 ? owing : creditors),
    };
  }
  if (n.payout_due_cents > 0) {
    return {
      tone: "green", icon: "arrow-down-circle-outline", alert: false, late: false, cta: "Voir",
      title: `${formatPrice(n.payout_due_cents, currency)} à recevoir`,
      sub: creditors.length > 0 ? who(creditors) : "Votre part des courses partenaires",
    };
  }
  return null;
}

/** Sommes partenaires ouvertes (accueil) : l'entrée « Courses partenaires » reste visible même réseau coupé. */
export const hasPartnerMoney = (n: DriverHomeNetwork | null | undefined) =>
  !!n && (n.owed_cents > 0 || n.payout_due_cents > 0 || (n.creditors ?? []).length > 0);

// =============================================================================
// « Courses partenaires » : un bloc par organisation, avec SES moyens de paiement
// =============================================================================

export type CreditorView = {
  id: string;
  name: string;
  phone: string | null;
  /** À régler à cette organisation (null : rien) */
  pay: {
    amountCents: number; count: number; ids: string[]; reference: string; link: string | null; linkDomain: string | null;
    manual: Exclude<SettlementMethod, "link">[]; dueLine: string; urgent: boolean;
  } | null;
  declaredCents: number;
  /** À recevoir de cette organisation */
  payout: { cents: number; onHoldCents: number; text: string } | null;
  blocked: string | null;
  open: DriverNetworkSettlementItem[];
  closed: DriverNetworkSettlementItem[];
};

const OPEN_STATUSES = new Set(["due", "declared", "disputed"]);

export function creditorView(c: DriverNetworkCreditor, tz?: string, now = Date.now()): CreditorView {
  const name = c.organization.name;
  const currency = c.currency || "EUR";
  const items = c.items ?? [];
  const owes = items.filter((i) => i.direction === "driver_owes");
  const disputed = owes.filter((i) => i.status === "disputed");
  const overdue = c.summary?.overdue_cents ?? 0;
  const nextDue = owes.filter((i) => i.status === "due").map((i) => i.due_at).sort()[0] ?? null;
  const pay = c.pay && c.pay.amount_cents > 0 && c.pay.settlement_ids.length > 0 ? c.pay : null;
  let dueLine = "";
  if (pay) {
    dueLine = disputed.length > 0
      ? frTypo(`${name} n'a pas reçu votre paiement de ${formatPrice(disputed.reduce((s, i) => s + i.amount_cents, 0), currency)} : réglez-le de nouveau, ou contestez`)
      : overdue > 0
        ? frTypo(`${formatPrice(overdue, currency)} en retard : réglez maintenant pour recevoir de nouveau les courses de ${name}`)
        : nextDue
          ? dueText(nextDue, tz, now).text
          : `À régler dans les ${c.grace_hours}${NBSP}h après chaque course`;
  }
  const payoutCents = c.summary?.payout_due_cents ?? 0;
  const onHold = c.summary?.on_hold_cents ?? 0;
  return {
    id: c.organization.id,
    name,
    phone: c.organization.phone,
    pay: pay && {
      amountCents: pay.amount_cents, count: pay.count, ids: [...pay.settlement_ids], reference: pay.reference,
      link: pay.methods.includes("link") ? pay.link : null, linkDomain: pay.link_domain,
      manual: pay.methods.filter((m): m is Exclude<SettlementMethod, "link"> => m !== "link"),
      dueLine, urgent: disputed.length > 0 || overdue > 0,
    },
    declaredCents: c.summary?.declared_cents ?? 0,
    payout: payoutCents + onHold > 0
      ? {
        cents: payoutCents, onHoldCents: onHold,
        text: frTypo(onHold > 0 && payoutCents === 0
          ? `${formatPrice(onHold, currency)} retenus : course à vérifier par ${name}`
          : `${name} vous versera ${formatPrice(payoutCents, currency)}${onHold > 0 ? ` (et ${formatPrice(onHold, currency)} après vérification)` : ""}`),
      }
      : null,
    blocked: c.blocked ? frTypo(c.blocked_message || blockerText(c.blocked, { giver: name }).message) : null,
    open: items.filter((i) => OPEN_STATUSES.has(i.status)),
    closed: items.filter((i) => !OPEN_STATUSES.has(i.status)),
  };
}

export type ItemTone = "amber" | "blue" | "green" | "red" | "muted";
export type PartnerItemView = {
  owes: boolean;
  title: string;
  kind: string;
  route: string;
  meta: string;
  amount: string;
  amountTone: "fg" | "muted" | "red";
  status: string;
  statusTone: ItemTone;
  detail: string | null;
  /** « Je conteste » encore possible (une fois par ligne) */
  dispute: { label: string; prompt: string } | null;
  /** Contestation déjà envoyée */
  disputed: string | null;
  /** « Pas reçu » posé par l'organisation */
  notReceived: string | null;
};

const STATUS_TONE: Record<string, ItemTone> = { due: "amber", declared: "blue", paid: "green", waived: "muted", disputed: "red" };

/** Ligne d'un règlement partenaire : jamais commission ni frais, un seul montant par sens. */
export function partnerItemView(i: DriverNetworkSettlementItem, giver: string, tz?: string, now = Date.now()): PartnerItemView {
  const owes = i.direction === "driver_owes";
  const currency = i.currency || "EUR";
  const today = new Date(now);
  const overdue = i.status === "due" && (i.overdue || Date.parse(i.due_at) <= now);
  const held = !owes && i.status === "due" && i.on_hold;
  let detail: string | null = null;
  if (owes) {
    if (i.status === "due") detail = dueText(i.due_at, tz, now).short;
    else if (i.status === "declared") {
      const how = i.declared_method ? ` (${methodLabel(i.declared_method)})` : "";
      detail = `Signalé ${pastWhen(i.declared_at, tz, today)}${how} · à confirmer par ${giver}`;
    } else if (i.status === "paid") detail = `Réglé ${pastWhen(i.settled_at, tz, today)}`;
    else if (i.status === "waived") detail = `Annulé par ${giver}`;
  } else if (i.status === "due") {
    detail = held && i.hold_until
      ? `Course à vérifier : versement retenu ${untilText(i.hold_until, tz, today)}`
      : `Versement prévu d'ici ${formatWhen(i.due_at, tz, today)}`;
  } else if (i.status === "paid") detail = `Versé ${pastWhen(i.settled_at, tz, today)}`;
  else if (i.status === "waived") detail = `Versement annulé par ${giver}`;
  else if (i.status === "declared") detail = `Versement signalé par ${giver}`;
  const dispute = i.can_dispute && !i.driver_disputed_at
    ? owes
      ? { label: "Je conteste : j'ai payé", prompt: `Expliquez à ${giver} comment et quand vous avez payé (moyen, date, référence).` }
      : i.status === "paid"
        ? { label: "Je conteste : pas reçu", prompt: `Expliquez à ${giver} que vous n'avez pas reçu ce versement.` }
        : i.status === "waived"
          ? { label: "Je conteste", prompt: `Expliquez à ${giver} pourquoi vous contestez l'annulation de ce versement.` }
          : { label: "Je conteste", prompt: `Expliquez votre contestation à ${giver}.` }
    : null;
  const settled = i.status === "paid" || i.status === "waived";
  return {
    owes,
    title: `Course ${i.ride.number}`,
    kind: partnerItemKind(i),
    route: `${i.ride.pickup} → ${i.ride.dropoff}`,
    meta: join([formatRideDate(i.ride.completed_at ?? i.due_at, tz, today), formatPrice(i.price_cents, currency), partnerPaymentLabel(i.payment_method)]),
    amount: `${owes ? "−" : "+"}${formatPrice(i.amount_cents, currency)}`,
    amountTone: settled ? "muted" : overdue || i.status === "disputed" ? "red" : "fg",
    status: held ? "Retenu" : driverSettlementLabel(i.status, i.direction, overdue && owes),
    statusTone: overdue && owes ? "red" : held ? "amber" : STATUS_TONE[i.status] ?? "muted",
    detail: detail && frTypo(detail),
    dispute: dispute && { label: frTypo(dispute.label), prompt: frTypo(dispute.prompt) },
    disputed: i.driver_disputed_at
      ? frTypo(`Contestation envoyée ${pastWhen(i.driver_disputed_at, tz, today)}${i.driver_dispute_reason ? ` : « ${i.driver_dispute_reason} »` : ""}`)
      : null,
    notReceived: owes && i.status === "disputed" ? frTypo(`${giver} n'a pas reçu ce paiement.`) : null,
  };
}

/**
 * Mention à côté du n° de course, selon le sens ET l'état (une ligne réglée ne dit jamais « à reverser ») : à bord →
 * « à reverser » (dû, « Pas reçu »), « reversé » (signalé ou encaissé), « annulé » ; déjà payée → « votre part »,
 * « part versée », « part annulée ».
 */
export function partnerItemKind(i: Pick<DriverNetworkSettlementItem, "direction" | "status">): string {
  if (i.direction === "driver_owes") {
    if (i.status === "paid" || i.status === "declared") return "reversé";
    if (i.status === "waived") return "annulé";
    return "à reverser";
  }
  if (i.status === "paid") return "part versée";
  if (i.status === "waived") return "part annulée";
  return "votre part";
}

const METHOD_LABELS: Record<string, string> = { link: "lien de paiement", cash: "espèces", transfer: "virement", other: "autre moyen" };
const methodLabel = (m: string) => METHOD_LABELS[m] ?? m;

/** Contestation : motif de 5 à 300 caractères. */
export function disputeReasonError(reason: string): string | null {
  const t = reason.trim();
  if (t.length < 5) return "Expliquez en quelques mots (5 caractères au moins).";
  if (t.length > 300) return "300 caractères au plus.";
  return null;
}

// =============================================================================
// Gains : net par course (termes figés d'une course partenaire)
// =============================================================================

/** Course partenaire des gains : organisation, part du chauffeur, part de A (jamais commission ni frais). */
export function earningsPartner(r: EarningsRide): { giver: string; gainCents: number | null; giverPartCents: number | null; collects: boolean } | null {
  if (!r.network_giver) return null;
  const gain = r.net_cents ?? null;
  return {
    giver: r.network_giver,
    gainCents: gain,
    giverPartCents: gain != null && r.price_cents != null ? Math.max(0, r.price_cents - gain) : null,
    collects: (r.settlement_direction ?? (driverCollects(r.payment_method) ? "driver_owes" : "centrale_owes")) === "driver_owes",
  };
}

/** « reversé » / « reversés » : pluriel à partir de 2 € (1,50 € reversé, 12,50 € reversés). */
const reversed = (cents: number | null) => ((cents ?? 0) >= 200 ? "reversés" : "reversé");

/**
 * Texte d'une course partenaire des gains, accordé à l'état du règlement (la pastille voisine) : UN montant, jamais
 * commission ni frais. À bord : « 12,50 € à reverser à {A} » (dû, « Pas reçu »), « 12,50 € reversés à {A} · à
 * confirmer » (signalé), « 12,50 € reversés à {A} » (encaissé), « Reversement annulé par {A} ». Déjà payée : « {A} vous
 * versera 37,50 € », « Versement signalé par {A} », « Part versée par {A} », « Versement annulé par {A} ».
 */
export function earningsPartnerText(r: EarningsRide): string | null {
  const p = earningsPartner(r);
  if (!p) return null;
  const status = r.settlement_status ?? null;
  if (p.collects) {
    const amount = formatPrice(p.giverPartCents, r.currency);
    if (status === "paid") return `${amount} ${reversed(p.giverPartCents)} à ${p.giver}`;
    if (status === "declared") return `${amount} ${reversed(p.giverPartCents)} à ${p.giver} · à confirmer`;
    if (status === "waived") return `Reversement annulé par ${p.giver}`;
    return `${amount} à reverser à ${p.giver}`;
  }
  if (status === "paid") return `Part versée par ${p.giver}`;
  if (status === "declared") return `Versement signalé par ${p.giver}`;
  if (status === "waived") return `Versement annulé par ${p.giver}`;
  return `${p.giver} vous versera ${formatPrice(p.gainCents, r.currency)}`;
}

// =============================================================================
// Accès aux règlements partenaires (écran Commissions, entrées du profil et des gains) : une seule décision, testée
// =============================================================================

export type PartnerAccessInput = {
  /** Modèle de l'organisation du chauffeur (centrale : commissions propres) */
  model: DispatchModel | null | undefined;
  /** driver_home().network : null / absent = rien de réseau (jamais ouvert, aucune somme partenaire) */
  homeNetwork: DriverHomeNetwork | null | undefined;
  /** driver_network_state() : null = interrupteur coupé (NETWORK_DISABLED), serveur sans réseau partagé, pas encore lu */
  network: DriverNetworkState | null | undefined;
  /** Règlements partenaires lus (écran Commissions) ; « unsupported » : serveur sans réseau partagé */
  settlements?: DriverNetworkSettlements | "unsupported" | null;
  /** Onglet « Courses partenaires » demandé (notification de règlement, bouton « Régler ») */
  requested?: boolean;
  /** Onglet choisi dans l'écran Commissions */
  tab?: "own" | "network";
};

export type PartnerAccess = {
  /** « Courses partenaires » s'applique : réseau visible (ouvert ET reçu), ou sommes partenaires (même réseau coupé ensuite) */
  partner: boolean;
  /** Commissions de sa propre organisation (centrale) */
  own: boolean;
  /** Sélecteur « {Ma centrale} / Courses partenaires » (chauffeur de centrale) */
  tabs: boolean;
  /** Titre de l'écran Commissions */
  title: string;
  /** Entrée « Courses partenaires » séparée dans le profil et les gains (chauffeur de flotte) */
  entry: boolean;
  /** L'écran Commissions montre les courses partenaires (onglet choisi, ou seul contenu pour une flotte) */
  showNetwork: boolean;
};

/**
 * Où apparaissent les règlements partenaires. Interrupteur plateforme coupé, organisation qui ne reçoit pas le réseau,
 * serveur sans réseau partagé : rien (écran « Commissions » inchangé, aucune entrée) ; seules des sommes partenaires
 * déjà nées (réseau coupé ensuite) gardent l'entrée « Courses partenaires ».
 */
export function partnerAccess(i: PartnerAccessInput): PartnerAccess {
  const read = i.settlements && i.settlements !== "unsupported" ? i.settlements : null;
  const partner = i.settlements !== "unsupported"
    && ((read?.organizations.length ?? 0) > 0 || hasPartnerMoney(i.homeNetwork) || networkVisible(i.network) || !!i.requested);
  const own = i.model === "centrale";
  return {
    partner,
    own,
    tabs: own && partner,
    title: own || !partner ? "Commissions" : PARTNER_SETTLEMENTS_TITLE,
    entry: !own && partner,
    showNetwork: partner && (!own || i.tab === "network"),
  };
}

/** Pastille d'un onglet de l'écran Commissions : nombre à régler (lecteur d'écran : `label`), rouge s'il y a du retard. */
export type TabBadge = { count: number; late: boolean; label: string };

const counted = (n: number, one: string, many: string) => `${n}${NBSP}${n > 1 ? many : one}`;

/** Pastille de l'onglet de sa centrale : courses dont la commission est à régler. */
export function ownTabBadge(pay: { amount_cents: number; count: number } | null | undefined, overdueCents = 0): TabBadge {
  const count = pay && pay.amount_cents > 0 ? pay.count : 0;
  return { count, late: count > 0 && overdueCents > 0, label: `${counted(count, "course", "courses")} à régler` };
}

/**
 * Pastille de l'onglet « Courses partenaires » : courses partenaires à régler (dues, ou « Pas reçu ») ; avant la lecture
 * des règlements, organisations à régler d'après l'accueil (driver_home().network).
 */
export function partnerTabBadge(settlements: DriverNetworkSettlements | null | undefined, homeNetwork: DriverHomeNetwork | null | undefined): TabBadge {
  if (settlements) {
    const count = settlements.organizations
      .flatMap((o) => o.items ?? [])
      .filter((x) => x.direction === "driver_owes" && (x.status === "due" || x.status === "disputed")).length;
    return { count, late: count > 0 && (settlements.summary?.overdue_cents ?? 0) > 0, label: `${counted(count, "course", "courses")} à régler` };
  }
  if (!homeNetwork || homeNetwork.owed_cents <= 0) return { count: 0, late: false, label: "" };
  const orgs = Math.max(1, (homeNetwork.creditors ?? []).filter((c) => c.owed_cents > 0).length);
  return { count: orgs, late: homeNetwork.overdue_cents > 0, label: `à régler à ${counted(orgs, "organisation", "organisations")}` };
}

/**
 * Détail de l'entrée « Mes coordonnées bancaires » (profil) : IBAN masqué, ou à renseigner (en alerte si un versement
 * est attendu) ; null : coordonnées inconnues (rien n'est affirmé).
 */
export function payoutRowDetail(payout: DriverPayoutInfo | null | undefined, payoutDueCents = 0): { text: string; alert: boolean } | null {
  if (!payout) return null;
  if (payout.configured) return { text: `IBAN ${maskIban(payout.iban_last4)}`, alert: false };
  return payoutDueCents > 0
    ? { text: "À renseigner pour recevoir vos versements", alert: true }
    : { text: "Pour recevoir vos versements", alert: false };
}

// =============================================================================
// Vocabulaire interdit (§7.1)
// =============================================================================

/** Mots interdits (NETWORK_FORBIDDEN_WORDS) présents dans un texte. */
export function forbiddenWordsIn(text: string): string[] {
  const t = text.toLowerCase();
  return NETWORK_FORBIDDEN_WORDS.filter((w) => t.includes(w));
}
