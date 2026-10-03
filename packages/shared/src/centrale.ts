// Mode « Centrale à commission » (option 2) : libellés, calculs d'affichage, formulaires.
// Les règles qui comptent (répartition, blocages, bannissements) sont appliquées en base
// (migration 20260924002600_centrale_mode) ; ce module ne fait que les présenter.
import { z } from "zod";
import { formatPrice, isValidIban } from "./format";
import { formatIban } from "./platform-fees";
import { emailSchema, phoneSchema, vehicleSchema } from "./schemas";
import type {
  BanCategory, DispatchModel, DriverBlocker, IdentityKind, SettlementDirection, SettlementMethod, SettlementStatus, TrustLevel,
} from "./types";

type Tone = "green" | "amber" | "red" | "blue" | "violet" | "neutral";

export const DISPATCH_MODEL_META: Record<DispatchModel, { label: string; short: string; description: string }> = {
  fleet: {
    label: "Flotte",
    short: "Option 1 — Flotte",
    description: "Vos chauffeurs et véhicules : courses proposées à 4 km puis élargies, attribution automatique ou manuelle.",
  },
  centrale: {
    label: "Centrale à commission",
    short: "Option 2 — Centrale",
    description:
      "Réseau de chauffeurs indépendants (groupes WhatsApp / Telegram) : part chauffeur affichée dans l'offre, commission à régler après chaque course, blocage des mauvais payeurs, bannissement définitif.",
  },
};

export const SETTLEMENT_STATUS_META: Record<SettlementStatus, { label: string; payoutLabel: string; tone: Tone }> = {
  due: { label: "À régler", payoutLabel: "À verser", tone: "amber" },
  declared: { label: "Payé selon le chauffeur", payoutLabel: "Déclaré", tone: "blue" },
  paid: { label: "Encaissé", payoutLabel: "Versé", tone: "green" },
  waived: { label: "Annulé", payoutLabel: "Annulé", tone: "neutral" },
  disputed: { label: "Non reçu", payoutLabel: "Contesté", tone: "red" },
};

/** Libellé d'un statut selon le sens (commission encaissée vs part chauffeur versée). */
export function settlementStatusLabel(status: SettlementStatus, direction: SettlementDirection, overdue = false): string {
  if (status === "due" && overdue) return "En retard";
  const meta = SETTLEMENT_STATUS_META[status];
  return direction === "centrale_owes" ? meta.payoutLabel : meta.label;
}

export const SETTLEMENT_METHOD_META: Record<SettlementMethod | "other", { label: string; ionicon: string; lucide: string }> = {
  link: { label: "Lien de paiement", ionicon: "link-outline", lucide: "Link" },
  cash: { label: "Espèces", ionicon: "cash-outline", lucide: "Banknote" },
  transfer: { label: "Virement", ionicon: "swap-horizontal-outline", lucide: "ArrowLeftRight" },
  other: { label: "Autre moyen", ionicon: "ellipsis-horizontal", lucide: "Ellipsis" },
};

// Messages = repli de private.blocker_message (dernière définition : 20260924004400_audit_argent.sql), à garder
// identiques (blocker-message.test.ts) : « unpaid » couvre aussi une commission contestée (paiement à confirmer).
export const DRIVER_BLOCKER_META: Record<DriverBlocker, { label: string; message: string }> = {
  unpaid: {
    label: "Commission en retard ou contestée",
    message:
      "Commission en retard ou contestée : réglez-la pour recevoir de nouvelles courses (après une contestation, la centrale doit confirmer votre paiement).",
  },
  credit_limit: {
    label: "Plafond d'encours atteint",
    message:
      "Plafond de commissions à régler atteint : réglez-les ou attendez leur confirmation par la centrale pour recevoir de nouvelles courses.",
  },
  new_driver: { label: "Réservée aux confirmés", message: "Course réservée aux chauffeurs confirmés de la centrale." },
};

export const TRUST_LEVEL_META: Record<TrustLevel, { label: string; tone: Tone; description: string }> = {
  new: { label: "Nouveau", tone: "amber", description: "Courses plafonnées en prix jusqu'à la confirmation." },
  trusted: { label: "Confirmé", tone: "green", description: "Reçoit toutes les courses de la centrale." },
};

export const BAN_CATEGORY_META: Record<BanCategory, { label: string }> = {
  unpaid: { label: "Commissions impayées" },
  fraud: { label: "Arnaque / fraude" },
  behavior: { label: "Comportement" },
  documents: { label: "Faux documents" },
  other: { label: "Autre" },
};

export const IDENTITY_KIND_LABELS: Record<IdentityKind, string> = {
  phone: "Téléphone",
  email: "E-mail",
  vtc_card: "Carte VTC",
  driving_license: "Permis",
  identity_doc: "Pièce d'identité",
  plate: "Plaque",
  device: "Appareil",
};

/** Paiement par le chauffeur ? Espèces / carte à bord : oui (il doit la commission). Sinon la centrale doit sa part. */
export const driverCollects = (paymentMethod: string | null | undefined) => paymentMethod === "cash" || paymentMethod === "card";

/**
 * Lien de paiement prérempli, identique au calcul SQL (private.settlement_payment_link) :
 * {montant} → « 19.00 », {montant_centimes} → « 1900 », {reference} → « C1783 ».
 */
export function settlementPaymentLink(template: string | null | undefined, amountCents: number, reference: string | null | undefined): string | null {
  if (!template || !(amountCents > 0)) return null;
  return template
    .replaceAll("{montant_centimes}", String(amountCents))
    .replaceAll("{montant}", (amountCents / 100).toFixed(2))
    .replaceAll("{reference}", reference ?? "");
}

/** Exemples de liens pour l'écran de réglages (la centrale adapte à son compte). */
export const SETTLEMENT_LINK_EXAMPLES = [
  { label: "Revolut", value: "https://revolut.me/votre-identifiant/{montant}" },
  { label: "PayPal", value: "https://paypal.me/votre-identifiant/{montant}EUR" },
  { label: "Lydia / Sumeria", value: "https://lydia-app.com/pots?id=votre-cagnotte" },
] as const;

/** Chiffres seuls pour wa.me (+33 6 12… → 33612…). null si numéro inexploitable. */
export function whatsappNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let v = phone.replace(/[^\d+]/g, "");
  if (v.startsWith("00")) v = `+${v.slice(2)}`;
  if (!v.startsWith("+") && v.startsWith("0") && v.length === 10) v = `+33${v.slice(1)}`;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

/** Message prêt à envoyer (WhatsApp / SMS) pour réclamer une commission. */
export function settlementRequestMessage(opts: {
  firstName: string;
  organizationName: string;
  amountCents: number;
  currency?: string;
  rideNumbers: (number | string)[];
  link?: string | null;
  reference?: string | null;
  instructions?: string | null;
  /** Virement accepté : coordonnées bancaires de la centrale */
  bank?: { payeeName: string; iban: string; bic?: string | null } | null;
}): string {
  const amount = formatPrice(opts.amountCents, opts.currency ?? "EUR");
  const rides = opts.rideNumbers.length === 1 ? `la course #${opts.rideNumbers[0]}` : `les courses ${opts.rideNumbers.map((n) => `#${n}`).join(", ")}`;
  const lines = [
    `Bonjour ${opts.firstName}, merci pour ${rides} !`,
    `Commission ${opts.organizationName} : ${amount}${opts.reference ? ` (réf. ${opts.reference})` : ""}.`,
  ];
  if (opts.link) lines.push(`Paiement : ${opts.link}`);
  if (opts.bank?.iban) {
    lines.push(`Virement : ${opts.bank.payeeName} — IBAN ${formatIban(opts.bank.iban)}${opts.bank.bic ? ` — BIC ${opts.bank.bic}` : ""}${opts.reference ? ` (libellé : ${opts.reference})` : ""}`);
  }
  if (opts.instructions) lines.push(opts.instructions);
  lines.push("Vous pouvez aussi régler depuis l'application Rydar Drive, onglet Commissions.");
  return lines.join("\n");
}

/** Lien wa.me avec message prérempli (null si numéro inexploitable). */
export function whatsappLink(phone: string | null | undefined, text: string): string | null {
  const n = whatsappNumber(phone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
}

/** Répartition affichée (« 59 € = 40 € chauffeur + 14 € commission + 5 € plateforme »). */
export function splitSummary(r: { price_cents?: number | null; driver_payout_cents?: number | null; commission_cents?: number | null; platform_fee_cents?: number | null; currency?: string }): string | null {
  if (r.price_cents == null || r.driver_payout_cents == null) return null;
  const c = r.currency ?? "EUR";
  const parts = [`${formatPrice(r.driver_payout_cents, c)} chauffeur`, `${formatPrice(r.commission_cents ?? 0, c)} commission`];
  if (r.platform_fee_cents) parts.push(`${formatPrice(r.platform_fee_cents, c)} plateforme`);
  return `${formatPrice(r.price_cents, c)} = ${parts.join(" + ")}`;
}

// -----------------------------------------------------------------------------
// Formulaires
// -----------------------------------------------------------------------------
const cents = (max: number) => z.coerce.number().int().min(0).max(max);
const optionalCents = (max: number) =>
  z.union([z.literal(""), z.null(), z.undefined(), cents(max)]).transform((v) => (v === "" || v == null ? null : v));

/**
 * Moyens de paiement proposés aux chauffeurs (organization_settings.settlement_methods, _link, _instructions,
 * _payee_name, _iban, _bic) : UNE seule définition pour « Commission & encaissement » (centrale) et la carte
 * « Encaissement » du réseau partagé (flotte).
 */
const settlementPaymentShape = {
  methods: z.array(z.enum(["link", "transfer", "cash", "other"])).min(1, "Choisissez au moins un moyen de paiement").max(4),
  link: z.union([z.literal(""), z.null(), z.undefined(), z.string().trim().max(500, "Lien : 500 caractères au maximum").regex(/^https:\/\/\S+$/, "Lien https:// requis")])
    .transform((v) => (v ? v : null)),
  instructions: z.string().trim().max(500, "Instructions : 500 caractères au maximum").optional().transform((v) => (v ? v : null)),
  // Virement : coordonnées bancaires (facultatives hors virement)
  payeeName: z.string().nullish().transform((v) => v?.trim() || null)
    .refine((v) => v == null || (v.length >= 2 && v.length <= 120), "Bénéficiaire : entre 2 et 120 caractères"),
  iban: z.string().nullish().transform((v) => (v ?? "").replace(/\s+/g, "").toUpperCase() || null)
    .refine((v) => v == null || isValidIban(v), "IBAN invalide (vérifiez les chiffres)"),
  bic: z.string().nullish().transform((v) => (v ?? "").replace(/\s+/g, "").toUpperCase() || null)
    .refine((v) => v == null || /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v), "BIC invalide (8 ou 11 caractères)"),
};

/** Moyen coché mais non renseigné : refusé (le chauffeur ne le verrait pas). */
function refineSettlementPayment(
  v: { methods: SettlementMethod[]; link: string | null; iban: string | null; instructions: string | null },
  ctx: z.RefinementCtx,
) {
  if (v.methods.includes("link") && !v.link) {
    ctx.addIssue({ code: "custom", path: ["link"], message: "Ajoutez votre lien de paiement (ou retirez « Lien de paiement »)" });
  }
  if (v.methods.includes("transfer") && !v.iban) {
    ctx.addIssue({ code: "custom", path: ["iban"], message: "Ajoutez votre IBAN (ou retirez « Virement »)" });
  }
  if (v.methods.includes("other") && !v.instructions) {
    ctx.addIssue({ code: "custom", path: ["instructions"], message: "Décrivez l'autre moyen de paiement (ou retirez « Autre moyen »)" });
  }
}

/** Moyens de paiement seuls : carte « Encaissement » d'une flotte dans « Réseau partagé ». */
export const settlementPaymentSchema = z.object(settlementPaymentShape).superRefine(refineSettlementPayment);
export type SettlementPaymentInput = z.input<typeof settlementPaymentSchema>;

/** Réglages « Commission & encaissement » de la centrale (organization_settings). */
export const centraleSettingsSchema = z
  .object({
    commissionPercent: z.union([z.literal(""), z.null(), z.undefined(), z.coerce.number().min(0).max(100)])
      .transform((v) => (v === "" || v == null ? null : v)),
    commissionFixedCents: optionalCents(100_000),
    graceHours: z.coerce.number().int().min(0).max(720),
    creditLimitCents: optionalCents(10_000_000),
    blockUnpaid: z.boolean(),
    newDriverMaxPriceCents: optionalCents(10_000_000),
    trustAfterRides: z.union([z.literal(""), z.null(), z.undefined(), z.coerce.number().int().min(1).max(1000)])
      .transform((v) => (v === "" || v == null ? null : v)),
    ...settlementPaymentShape,
  })
  .superRefine(refineSettlementPayment);

/** Super admin : modèle d'exploitation + frais plateforme d'un compte. */
export const dispatchModelSchema = z.object({
  dispatchModel: z.enum(["fleet", "centrale"]),
  platformFeePercent: z.coerce.number().min(0).max(50),
  platformFeeFixedCents: cents(100_000),
});
export type DispatchModelInput = z.output<typeof dispatchModelSchema>;

/** Page publique /rejoindre/{code} : candidature d'un chauffeur. */
export const joinApplicationSchema = z.object({
  firstName: z.string().trim().min(1, "Prénom requis").max(80),
  lastName: z.string().trim().min(1, "Nom requis").max(80),
  phone: phoneSchema,
  email: emailSchema,
  password: z.string().min(10, "10 caractères minimum").max(72),
  vtcCardNumber: z.string().trim().max(40).optional().transform((v) => (v ? v : undefined)),
  vehicle: vehicleSchema,
  message: z.string().trim().max(1000).optional().transform((v) => (v ? v : undefined)),
  acceptTerms: z.literal(true, { error: "Acceptez les conditions pour continuer" }),
  /** piège à robots : doit rester vide */
  website: z.string().max(0).optional(),
});

/** Bannissement (dashboard). */
export const banDriverSchema = z.object({
  reason: z.string().trim().min(3, "Indiquez le motif").max(500),
  category: z.enum(["unpaid", "fraud", "behavior", "documents", "other"]),
  reportToPlatform: z.boolean().default(false),
  banVehicle: z.boolean().default(false),
});
