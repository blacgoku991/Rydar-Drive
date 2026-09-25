import { z } from "zod";
import { PAYMENT_METHODS, VEHICLE_CATEGORIES } from "./domain";
import { normalizePhone } from "./format";

// Messages de validation en français (API publique, formulaires).
z.config(z.locales.fr());

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

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email("Adresse e-mail invalide"));
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
export type RideForm = z.output<typeof rideFormSchema>;

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
export type ApiRideCreate = z.output<typeof apiRideCreateSchema>;

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
  consent: z.literal(true, { error: "Merci d'accepter le traitement de vos données" }),
  website: z.string().max(0).optional(), // pot de miel anti-bot
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
export type VehicleInput = z.output<typeof vehicleSchema>;

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
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/, "Lettres minuscules, chiffres et tirets uniquement");

export const organizationCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugSchema,
  planCode: z.string().trim().min(2).max(40),
  email: emailSchema,
  phone: z.union([phoneSchema, z.literal("")]).optional(),
  city: optionalText(80),
  ownerName: z.string().trim().min(2).max(120),
  ownerEmail: emailSchema,
  ownerPassword: z.string().min(10).max(72).optional().or(z.literal("")),
});
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
});

export const orgSettingsSchema = z.object({
  auto_dispatch: z.boolean(),
  dispatch_radii_m: z
    .array(z.number().int().min(500).max(100_000))
    .min(1)
    .max(8)
    .refine((a) => a.every((v, i) => i === 0 || v > a[i - 1]!), "Les rayons doivent être croissants"),
  offer_timeout_seconds: z.number().int().min(10).max(600),
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
}).superRefine((v, ctx) => {
  // La recherche doit laisser à chaque vague (4 → 8 → 12 → 16 km) son délai de réponse complet
  const min = v.dispatch_radii_m.length * v.offer_timeout_seconds;
  if (v.max_search_seconds < min) {
    ctx.addIssue({
      code: "custom",
      path: ["max_search_seconds"],
      message: `Durée de recherche trop courte : au moins ${Math.ceil(min / 60)} min pour ${v.dispatch_radii_m.length} vagues de ${v.offer_timeout_seconds} s.`,
    });
  }
});
export type OrgSettings = z.output<typeof orgSettingsSchema>;

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Couleur hexadécimale (#RRGGBB)");

export const bookingSiteSchema = z.object({
  enabled: z.boolean(),
  subdomain: slugSchema.nullish(),
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
});

export const API_SCOPES = ["rides:create", "rides:read", "rides:cancel"] as const;
export const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
  rateLimitPerMinute: z.coerce.number().int().min(1).max(10_000).default(60),
  allowedOrigins: z.array(z.url()).max(20).default([]),
  expiresInDays: z.coerce.number().int().min(1).max(3650).nullish(),
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
export type PlanLimits = z.output<typeof planLimitsSchema>;

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

/** Aplatit les erreurs zod : { "pickup.address": "Adresse requise" }. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
