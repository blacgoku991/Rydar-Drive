import { z } from "zod";
import { PAYMENT_METHODS, VEHICLE_CATEGORIES } from "./domain";
import { normalizePhone } from "./format";

// Messages de validation en français (API publique, formulaires).
z.config(z.locales.fr());
// Cas courants en langage simple (sinon « Trop petit : chaîne de caractères doit avoir >=2 caractères ») ;
// un message écrit dans un schéma reste prioritaire, et le reste suit la locale française.
z.config({
  customError: (issue) => {
    if (issue.code === "invalid_type" && issue.input === undefined) return "Champ obligatoire";
    if (issue.code === "invalid_format" && issue.format === "email") return "Adresse e-mail invalide";
    if (issue.code === "too_small" || issue.code === "too_big") {
      const bound = Number(issue.code === "too_small" ? issue.minimum : issue.maximum);
      const small = issue.code === "too_small";
      if (issue.origin === "string") {
        if (small && bound <= 1) return "Champ obligatoire";
        return `${bound} caractères ${small ? "minimum" : "maximum"}`;
      }
      if (issue.origin === "number" || issue.origin === "int") {
        if (issue.inclusive === false) return small ? `Doit être supérieur à ${bound}` : `Doit être inférieur à ${bound}`;
        return `${small ? "Minimum" : "Maximum"} ${bound}`;
      }
      if (issue.origin === "array" || issue.origin === "set") {
        return small ? `Au moins ${bound} élément${bound > 1 ? "s" : ""}` : `${bound} éléments au maximum`;
      }
    }
    return undefined;
  },
});

// -----------------------------------------------------------------------------
// Briques
// -----------------------------------------------------------------------------
export const phoneSchema = z
  .string()
  .trim()
  .min(6, "Numéro trop court")
  .max(30)
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({ code: "custom", message: "Numéro de téléphone invalide" });
      return z.NEVER;
    }
    return normalized;
  });

// 254 caractères maximum (RFC 5321) : refusé avant l'expression régulière et avant toute clé de limitation
export const emailSchema = z.string().trim().max(254).toLowerCase().pipe(z.email("Adresse e-mail invalide"));
const optionalEmail = z
  .union([emailSchema, z.literal("")])
  .optional()
  .transform((v) => (v ? v : undefined));

const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

export const placeSchema = z.object({
  address: z.string().trim().min(3, "Adresse requise").max(300),
  lat,
  lng,
});
export const optionalPlaceSchema = z.object({
  address: z.string().trim().min(3, "Adresse requise").max(300),
  lat: lat.nullish(),
  lng: lng.nullish(),
});

const flightNumber = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,3}\s?\d{1,5}[A-Z]?$/, "Numéro de vol invalide (ex. AF1680)");

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const vehicleCategorySchema = z.enum(VEHICLE_CATEGORIES);
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);

// -----------------------------------------------------------------------------
// Nouvelle course (dashboard rattacheur)
// -----------------------------------------------------------------------------
export const rideFormSchema = z
  .object({
    pickup: placeSchema,
    dropoff: optionalPlaceSchema,
    when: z.enum(["now", "scheduled"]),
    pickupAt: z.coerce.date().optional(),
    customerName: z.string().trim().min(1, "Nom du client requis").max(120),
    customerPhone: phoneSchema,
    customerEmail: optionalEmail,
    passengers: z.coerce.number().int().min(1).max(20),
    luggage: z.coerce.number().int().min(0).max(30),
    vehicleCategory: vehicleCategorySchema,
    priceCents: z.coerce.number().int().min(0).max(10_000_000).nullish(),
    paymentMethod: paymentMethodSchema,
    comment: optionalText(2000),
    flightNumber: z
      .union([flightNumber, z.literal("")])
      .optional()
      .transform((v) => (v ? v.replace(/\s/g, "") : undefined)),
  })
  .superRefine((v, ctx) => {
    if (v.when === "scheduled") {
      if (!v.pickupAt) ctx.addIssue({ code: "custom", path: ["pickupAt"], message: "Date et heure requises" });
      else if (v.pickupAt.getTime() < Date.now() - 5 * 60_000)
        ctx.addIssue({ code: "custom", path: ["pickupAt"], message: "La date est déjà passée" });
    }
  });
export type RideFormInput = z.input<typeof rideFormSchema>;

// -----------------------------------------------------------------------------
// API publique v1 — POST /api/v1/rides
// organization_id n'est JAMAIS accepté : la clé API détermine le tenant.
// -----------------------------------------------------------------------------
export const TENANT_FIELDS = ["organization_id", "organizationId", "tenant_id", "tenantId", "org_id"] as const;

const apiPlace = z.strictObject({
  address: z.string().trim().min(3).max(300),
  lat: lat.optional(),
  lng: lng.optional(),
});

export const apiRideCreateSchema = z
  .strictObject({
    pickup: apiPlace,
    dropoff: apiPlace,
    pickup_at: z.iso.datetime({ offset: true }).nullish(),
    date: z.iso.date().optional(),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Format HH:MM attendu")
      .optional(),
    customer: z.strictObject({
      name: z.string().trim().min(1).max(120),
      phone: phoneSchema,
      email: optionalEmail,
    }),
    passengers: z.number().int().min(1).max(20).default(1),
    luggage: z.number().int().min(0).max(30).default(0),
    vehicle_category: vehicleCategorySchema.default("standard"),
    price_cents: z.number().int().min(0).max(10_000_000).nullish(),
    payment_method: paymentMethodSchema.default("card"),
    comment: optionalText(2000),
    flight_number: flightNumber.optional(),
    external_reference: optionalText(100),
  })
  .superRefine((v, ctx) => {
    if ((v.date && !v.time) || (!v.date && v.time)) {
      ctx.addIssue({ code: "custom", path: ["time"], message: "date et time doivent être fournis ensemble" });
    }
    if (v.pickup_at && v.date) {
      ctx.addIssue({ code: "custom", path: ["pickup_at"], message: "Utilisez pickup_at OU date + time" });
    }
  });

export const apiRideCancelSchema = z.strictObject({ reason: optionalText(300) });

// -----------------------------------------------------------------------------
// Mini-site de réservation (aucun compte client)
// -----------------------------------------------------------------------------
export const bookingRequestSchema = z.object({
  pickup: placeSchema,
  dropoff: placeSchema,
  when: z.enum(["now", "scheduled"]),
  pickupAt: z.coerce.date().optional(),
  customerName: z.string().trim().min(2, "Votre nom").max(120),
  customerPhone: phoneSchema,
  customerEmail: optionalEmail,
  passengers: z.coerce.number().int().min(1).max(8),
  luggage: z.coerce.number().int().min(0).max(10),
  vehicleCategory: vehicleCategorySchema,
  flightNumber: z
    .union([flightNumber, z.literal("")])
    .optional()
    .transform((v) => (v ? v.replace(/\s/g, "") : undefined)),
  comment: optionalText(500),
  // Prix affiché au client au moment de réserver (centimes, TTC) : seul un prix affiché engage le client (« Réserver avec
  // obligation de paiement », C. conso. L221-14) ; le serveur l'enregistre s'il est identique au sien, sinon refuse
  // (PRICE_CHANGED). Absent : demande sans prix, que la centrale confirme au client.
  expectedPriceCents: z.coerce.number().int().min(0).max(10_000_000).nullish(),
  // Plus de case « J'accepte… » : les coordonnées servent à exécuter la course demandée (RGPD art. 6.1.b), le client en
  // est informé sous le formulaire ; un ancien champ « consent » encore envoyé est ignoré
  // Pot de miel anti-robot : accepté par le schéma (sinon l'erreur de validation prévient le robot),
  // l'action répond « ok » sans rien créer s'il est rempli
  website: z.string().max(200).optional(),
});
export type BookingRequest = z.output<typeof bookingRequestSchema>;

// -----------------------------------------------------------------------------
// Flotte
// -----------------------------------------------------------------------------
export const plateSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(4)
  .max(12)
  .regex(/^[A-Z0-9 -]+$/, "Plaque invalide");

export const vehicleSchema = z.object({
  brand: optionalText(40),
  model: z.string().trim().min(1, "Modèle requis").max(60),
  color: optionalText(40),
  plate: plateSchema,
  category: vehicleCategorySchema,
  seats: z.coerce.number().int().min(1).max(20),
  luggageCapacity: z.coerce.number().int().min(0).max(30).default(3),
});

export const driverCreateSchema = z
  .object({
    firstName: z.string().trim().min(1, "Prénom requis").max(80),
    lastName: z.string().trim().min(1, "Nom requis").max(80),
    phone: phoneSchema,
    email: emailSchema,
    photoUrl: z.url().optional().or(z.literal("")),
    vtcCardNumber: optionalText(40),
    status: z.enum(["active", "inactive"]).default("active"),
    vehicle: vehicleSchema,
    access: z.enum(["password", "invite"]),
    password: z.string().min(10, "10 caractères minimum").max(72).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.access === "password" && !v.password) {
      ctx.addIssue({ code: "custom", path: ["password"], message: "Mot de passe requis" });
    }
  });
export type DriverCreateInput = z.output<typeof driverCreateSchema>;

export const driverUpdateSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone: phoneSchema,
  email: emailSchema,
  vtcCardNumber: optionalText(40),
  notes: optionalText(2000),
  vehicle: vehicleSchema,
});

export const driverStatusChangeSchema = z.object({
  status: z.enum(["active", "inactive", "suspended"]),
  reason: optionalText(300),
});

// -----------------------------------------------------------------------------
// Organisation / réglages / mini-site / API
// -----------------------------------------------------------------------------
/**
 * Sous-domaines réservés à la plateforme (hameçonnage sous le domaine officiel, noms techniques) :
 * refusés pour un mini-site ou un identifiant de centrale, ainsi que tout nom commençant par « rydar ».
 * Liste identique au trigger SQL private.reject_reserved_subdomain (migration 004900).
 */
export const RESERVED_SUBDOMAINS = [
  "www", "app", "api", "admin", "administration", "support", "aide", "help", "status", "statut", "mail", "email", "smtp", "imap",
  "pop", "mx", "mta-sts", "autodiscover", "autoconfig", "docs", "doc", "blog", "login", "connexion", "auth", "compte", "account",
  "securite", "security", "paiement", "payment", "facturation", "billing", "dashboard", "static", "cdn", "assets", "book",
  "rejoindre", "chauffeur", "driver", "centrale", "legal", "juridique",
] as const;

export function isReservedSubdomain(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v.startsWith("rydar") || (RESERVED_SUBDOMAINS as readonly string[]).includes(v);
}

/** Format d'un identifiant / sous-domaine, sans le contrôle des noms réservés. */
const subdomainFormatSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/, "Lettres minuscules, chiffres et tirets uniquement");

export const slugSchema = subdomainFormatSchema.refine((s) => !isReservedSubdomain(s), "Nom réservé à la plateforme");

export const organizationCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugSchema,
  // Facultative : sans offre, aucune limite (tests, offres pas encore définies)
  planCode: z.string().trim().max(40).optional(),
  email: emailSchema,
  phone: z.union([phoneSchema, z.literal("")]).optional(),
  city: optionalText(80),
  ownerName: z.string().trim().min(2).max(120),
  ownerEmail: emailSchema,
  ownerPassword: z.string().min(10).max(72).optional().or(z.literal("")),
});
export const ORGANIZATION_CREATE_LABELS: Record<string, string> = {
  name: "Nom de la centrale", slug: "Identifiant", planCode: "Offre", email: "E-mail de la centrale", phone: "Téléphone",
  city: "Ville", ownerName: "Nom du propriétaire", ownerEmail: "E-mail du propriétaire", ownerPassword: "Mot de passe provisoire",
};
export type OrganizationCreateInput = z.output<typeof organizationCreateSchema>;

export const organizationUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: optionalText(160),
  siret: optionalText(20),
  email: z.union([emailSchema, z.literal("")]).optional(),
  phone: optionalText(30),
  address: optionalText(200),
  city: optionalText(80),
  postalCode: optionalText(12),
  /** Inscription au registre des exploitants VTC / déclaration de centrale de réservation */
  vtcRegistration: optionalText(120),
});

export const orgSettingsSchema = z.object({
  auto_dispatch: z.boolean(),
  dispatch_radii_m: z
    .array(z.number().int().min(500).max(100_000))
    .min(1)
    .max(8)
    .refine((a) => a.every((v, i) => i === 0 || v > a[i - 1]!), "Les rayons doivent être croissants"),
  // Relance après le dernier rayon (migration 003200) : 0 à 4 rayons croissants, [] = pas de relance
  dispatch_retry_radii_m: z
    .array(z.number().int().min(500).max(100_000))
    .max(4)
    .refine((a) => a.every((v, i) => i === 0 || v > a[i - 1]!), "Les rayons doivent être croissants"),
  offer_timeout_seconds: z.number().int().min(10).max(600),
  // N'est plus utilisé par le dispatch GPS (la séquence de vagues fixe la fin de la recherche) ; conservé
  max_search_seconds: z.number().int().min(30).max(7200),
  max_offers_per_wave: z.number().int().min(1).max(500),
  instant_threshold_minutes: z.number().int().min(0).max(720),
  scheduled_dispatch_lead_minutes: z.number().int().min(5).max(1440),
  reminder_offsets_minutes: z.array(z.number().int().min(5).max(10_080)).max(8),
  allow_category_upgrade: z.boolean(),
  location_max_age_seconds: z.number().int().min(30).max(3600),
  default_payment_method: paymentMethodSchema,
  // Suivi des vols (migration 002100)
  flight_tracking_enabled: z.boolean(),
  flight_pickup_buffer_minutes: z.number({ error: "Marge : nombre de minutes" }).int("Marge : minutes entières").min(0, "Marge : 0 min au minimum").max(120, "Marge : 120 min au maximum"),
  // Alertes de suivi (migration 002200)
  late_alert_tolerance_minutes: z.number({ error: "Tolérance de retard : nombre de minutes" }).int("Tolérance de retard : minutes entières").min(1, "Tolérance de retard : 1 min au minimum").max(60, "Tolérance de retard : 60 min au maximum"),
  stalled_alert_minutes: z.number({ error: "Immobilité : nombre de minutes" }).int("Immobilité : minutes entières").min(2, "Immobilité : 2 min au minimum").max(30, "Immobilité : 30 min au maximum"),
  // Commission de la centrale sur le prix de la course, pour le « net chauffeur » (migration 002400) ; null = aucune
  driver_commission_percent: z.number({ error: "Commission : pourcentage" }).min(0, "Commission : 0 % au minimum").max(100, "Commission : 100 % au maximum").nullable(),
});
export type OrgSettings = z.output<typeof orgSettingsSchema>;

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Couleur hexadécimale (#RRGGBB)");

const bookingSiteObjectSchema = z.object({
  enabled: z.boolean(),
  subdomain: subdomainFormatSchema.nullish(),
  custom_domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Domaine invalide")
    .nullish()
    .or(z.literal("").transform(() => null)),
  title: optionalText(120),
  tagline: optionalText(160),
  description: optionalText(1000),
  logo_url: z.url().nullish().or(z.literal("").transform(() => null)),
  hero_image_url: z.url().nullish().or(z.literal("").transform(() => null)),
  primary_color: hexColor,
  phone: optionalText(30),
  email: z.union([emailSchema, z.literal("")]).optional(),
  whatsapp: optionalText(30),
  service_area: optionalText(300),
  vehicle_categories: z.array(vehicleCategorySchema).min(1),
  show_price_estimate: z.boolean(),
  // Informations précontractuelles de la centrale pour ses clients particuliers (conditions de réservation,
  // d'annulation et de paiement, médiateur de la consommation) : affichées avant le bouton de réservation
  legal_mentions: optionalText(2000),
});

/** Longueur minimale des « Conditions pour vos clients » d'un mini-site en ligne. */
export const BOOKING_SITE_MIN_CONDITIONS = 40;

/**
 * Mini-site publiable auprès de particuliers : conditions de la centrale (identité, paiement, annulation, médiateur :
 * C. conso. L111-1, L221-5, L221-14, L612-1), téléphone et e-mail de la centrale. Contrôlé à l'enregistrement
 * (bookingSiteSchemaFor) ET à chaque réservation (mini-site publié avant la règle : réservation en ligne refusée).
 */
export function bookingSitePublishable(site: { legal_mentions?: string | null; phone?: string | null; email?: string | null }): boolean {
  return (site.legal_mentions ?? "").trim().length >= BOOKING_SITE_MIN_CONDITIONS && !!site.phone?.trim() && !!site.email?.trim();
}

/**
 * Réglages du mini-site. `currentSubdomain` = sous-domaine enregistré : un nom réservé n'est refusé que s'il CHANGE
 * (comme le trigger SQL booking_sites_reserved_subdomain, migration 004900) ; une centrale dont le sous-domaine
 * existant est réservé (pris avant la règle) enregistre ses autres réglages sans devoir le renommer. Mise en ligne
 * (enabled) : conditions pour les clients, téléphone et e-mail obligatoires (bookingSitePublishable).
 */
export function bookingSiteSchemaFor(currentSubdomain: string | null | undefined) {
  const current = currentSubdomain?.trim().toLowerCase() || null;
  return bookingSiteObjectSchema.superRefine((v, ctx) => {
    if (v.subdomain && v.subdomain !== current && isReservedSubdomain(v.subdomain)) {
      ctx.addIssue({ code: "custom", path: ["subdomain"], message: "Nom réservé à la plateforme" });
    }
    if (!v.enabled) return;
    if ((v.legal_mentions ?? "").trim().length < BOOKING_SITE_MIN_CONDITIONS) {
      ctx.addIssue({
        code: "custom",
        path: ["legal_mentions"],
        message: `Pour mettre le mini-site en ligne : vos conditions pour les clients (identité, moyens de paiement, annulation, médiateur), ${BOOKING_SITE_MIN_CONDITIONS} caractères au moins`,
      });
    }
    if (!v.phone?.trim()) ctx.addIssue({ code: "custom", path: ["phone"], message: "Pour mettre le mini-site en ligne : téléphone de la centrale" });
    if (!v.email?.trim()) ctx.addIssue({ code: "custom", path: ["email"], message: "Pour mettre le mini-site en ligne : e-mail de la centrale" });
  });
}

/** Sans sous-domaine enregistré : tout nom réservé est refusé. */
export const bookingSiteSchema = bookingSiteSchemaFor(null);

export const API_SCOPES = ["rides:create", "rides:read", "rides:cancel", "webhooks:manage"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
/** Libellés des permissions (Dashboard → Intégrations). */
export const API_SCOPE_LABELS: Record<ApiScope, string> = {
  "rides:create": "Créer des courses",
  "rides:read": "Lire le statut",
  "rides:cancel": "Annuler",
  "webhooks:manage": "Webhooks",
};
/** Seule portée permise à une clé « navigateur » (origines autorisées) : la clé est lisible par tout visiteur du site. */
export const BROWSER_KEY_SCOPES = ["rides:create"] as const;
export const apiKeyCreateSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    scopes: z.array(z.enum(API_SCOPES)).min(1),
    rateLimitPerMinute: z.coerce.number().int().min(1).max(10_000).default(60),
    allowedOrigins: z.array(z.url()).max(20).default([]),
    expiresInDays: z.coerce.number().int().min(1).max(3650).nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.allowedOrigins.length && v.scopes.some((s) => !(BROWSER_KEY_SCOPES as readonly string[]).includes(s))) {
      ctx.addIssue({
        code: "custom",
        path: ["scopes"],
        message: "Clé utilisée depuis le navigateur (origines autorisées) : seule la création de courses est permise.",
      });
    }
  });

export const planLimitsSchema = z.object({
  max_drivers: z.number().int().min(1).nullable(),
  max_rides_per_month: z.number().int().min(1).nullable(),
  max_admins: z.number().int().min(1).nullable(),
  api_access: z.boolean(),
  booking_site: z.boolean(),
  custom_domain: z.boolean(),
  advanced_stats: z.boolean(),
  history_days: z.number().int().min(1).nullable(),
});

export const planSchema = z.object({
  code: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().trim().min(2).max(60),
  description: optionalText(300),
  price_monthly_cents: z.number().int().min(0),
  price_yearly_cents: z.number().int().min(0),
  limits: planLimitsSchema,
  features: z.array(z.string().trim().min(1).max(120)).max(20),
  is_active: z.boolean(),
  is_public: z.boolean(),
  highlighted: z.boolean(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Mot de passe requis").max(200),
});

/** « Mot de passe oublié » de l'application chauffeur (POST /api/auth/driver-password-reset). */
export const driverPasswordResetSchema = z.object({ email: emailSchema });

/** Nouveau mot de passe (réinitialisation, invitation) : même règle que l'inscription par lien. */
export const NEW_PASSWORD_MIN = 10;
/** Au-delà, Supabase Auth (bcrypt) ignore les caractères suivants : refusé plutôt que tronqué en silence. */
export const NEW_PASSWORD_MAX = 72;

/**
 * « Mot de passe oublié » de l'application chauffeur, étape 2 (POST /api/auth/driver-password-reset/confirm) :
 * code reçu par e-mail (6 à 10 chiffres selon la configuration Supabase, espaces retirés) + nouveau mot de passe.
 */
export const driverResetConfirmSchema = z.object({
  email: emailSchema,
  code: z
    .string()
    .max(40)
    .transform((v) => v.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^\d{6,10}$/, "Code invalide")),
  password: z.string().min(NEW_PASSWORD_MIN).max(NEW_PASSWORD_MAX),
});

/** Aplatit les erreurs zod : { "pickup.address": "Adresse requise" }. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/** Première erreur, précédée du nom du champ : « Offre : choisissez une offre ». */
export function describeError(error: z.ZodError, labels: Record<string, string> = {}): string {
  const issue = error.issues[0];
  if (!issue) return "Formulaire invalide.";
  const label = labels[issue.path.join(".")] ?? labels[String(issue.path[0] ?? "")];
  if (!label || issue.message.startsWith(`${label} :`)) return issue.message;
  return `${label} : ${issue.message.charAt(0).toLowerCase()}${issue.message.slice(1)}`;
}
