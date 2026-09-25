// Domaine Rydar Drive : statuts, libellés FR, couleurs, machine à états.
// Source de vérité côté TypeScript — doit rester alignée avec les enums SQL.

export const RIDE_STATUSES = [
  "CREATED",
  "SEARCHING_DRIVER",
  "OFFERED",
  "ACCEPTED",
  "DRIVER_EN_ROUTE",
  "DRIVER_ARRIVED",
  "PASSENGER_ONBOARD",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "NO_DRIVER_FOUND",
] as const;
export type RideStatus = (typeof RIDE_STATUSES)[number];

export type Tone = "neutral" | "brand" | "amber" | "blue" | "violet" | "cyan" | "green" | "red";

export const RIDE_STATUS_META: Record<RideStatus, { label: string; short: string; tone: Tone }> = {
  CREATED: { label: "Créée", short: "Créée", tone: "neutral" },
  SEARCHING_DRIVER: { label: "Recherche chauffeur", short: "Recherche", tone: "amber" },
  OFFERED: { label: "Proposée", short: "Proposée", tone: "amber" },
  ACCEPTED: { label: "Attribuée", short: "Attribuée", tone: "blue" },
  DRIVER_EN_ROUTE: { label: "Chauffeur en route", short: "En route", tone: "blue" },
  DRIVER_ARRIVED: { label: "Chauffeur arrivé", short: "Arrivé", tone: "violet" },
  PASSENGER_ONBOARD: { label: "Client à bord", short: "À bord", tone: "cyan" },
  IN_PROGRESS: { label: "En course", short: "En course", tone: "cyan" },
  COMPLETED: { label: "Terminée", short: "Terminée", tone: "green" },
  CANCELLED: { label: "Annulée", short: "Annulée", tone: "neutral" },
  NO_DRIVER_FOUND: { label: "Sans chauffeur", short: "Sans chauffeur", tone: "red" },
};

export const TERMINAL_STATUSES: readonly RideStatus[] = ["COMPLETED", "CANCELLED", "NO_DRIVER_FOUND"];
export const SEARCHING_STATUSES: readonly RideStatus[] = ["CREATED", "SEARCHING_DRIVER", "OFFERED"];
export const ONGOING_STATUSES: readonly RideStatus[] = [
  "DRIVER_EN_ROUTE",
  "DRIVER_ARRIVED",
  "PASSENGER_ONBOARD",
  "IN_PROGRESS",
];

export const isTerminal = (s: RideStatus) => TERMINAL_STATUSES.includes(s);
export const isSearching = (s: RideStatus) => SEARCHING_STATUSES.includes(s);
export const isOngoing = (s: RideStatus) => ONGOING_STATUSES.includes(s);
export const isLive = (s: RideStatus) => !isTerminal(s);
export const canCancel = (s: RideStatus) => s !== "COMPLETED" && s !== "CANCELLED";
export const canRedispatch = (s: RideStatus) => isSearching(s) || s === "NO_DRIVER_FOUND";
export const canAssign = (s: RideStatus) => isSearching(s) || s === "NO_DRIVER_FOUND" || s === "ACCEPTED";

/** Cycle chauffeur : statut courant → action suivante (boutons de l'app). */
export const DRIVER_FLOW: Partial<Record<RideStatus, { next: RideStatus; label: string; hint: string }>> = {
  ACCEPTED: { next: "DRIVER_EN_ROUTE", label: "Aller au départ", hint: "Prévenez le client de votre arrivée" },
  DRIVER_EN_ROUTE: { next: "DRIVER_ARRIVED", label: "Je suis arrivé", hint: "Vous êtes au point de prise en charge" },
  DRIVER_ARRIVED: { next: "PASSENGER_ONBOARD", label: "Client à bord", hint: "Le client est installé" },
  PASSENGER_ONBOARD: { next: "IN_PROGRESS", label: "Démarrer", hint: "Départ vers la destination" },
  IN_PROGRESS: { next: "COMPLETED", label: "Terminer la course", hint: "Arrivé à destination" },
};

export function canDriverTransition(from: RideStatus, to: RideStatus): boolean {
  return DRIVER_FLOW[from]?.next === to;
}

/** Filtres de l'écran Courses (dashboard). */
export const RIDE_FILTERS = [
  { key: "all", label: "Toutes" },
  { key: "instant", label: "Instantanées" },
  { key: "scheduled", label: "Planifiées" },
  { key: "searching", label: "En recherche" },
  { key: "offered", label: "Proposées" },
  { key: "assigned", label: "Attribuées" },
  { key: "ongoing", label: "En cours" },
  { key: "completed", label: "Terminées" },
  { key: "cancelled", label: "Annulées" },
  { key: "no_driver", label: "Sans chauffeur" },
] as const;
export type RideFilterKey = (typeof RIDE_FILTERS)[number]["key"];

export const RIDE_FILTER_STATUSES: Record<RideFilterKey, readonly RideStatus[] | null> = {
  all: null,
  instant: null,
  scheduled: null,
  searching: ["CREATED", "SEARCHING_DRIVER"],
  offered: ["OFFERED"],
  assigned: ["ACCEPTED"],
  ongoing: ONGOING_STATUSES,
  completed: ["COMPLETED"],
  cancelled: ["CANCELLED"],
  no_driver: ["NO_DRIVER_FOUND"],
};

// -----------------------------------------------------------------------------
// Chauffeurs
// -----------------------------------------------------------------------------
export const DRIVER_PRESENCES = ["offline", "available", "offered", "en_route", "arrived", "on_trip"] as const;
export type DriverPresence = (typeof DRIVER_PRESENCES)[number];

export const PRESENCE_META: Record<DriverPresence, { label: string; tone: Tone }> = {
  available: { label: "Disponible", tone: "brand" },
  offered: { label: "Course proposée", tone: "amber" },
  en_route: { label: "En route client", tone: "blue" },
  arrived: { label: "Arrivé", tone: "violet" },
  on_trip: { label: "En course", tone: "cyan" },
  offline: { label: "Hors ligne", tone: "neutral" },
};

export const DRIVER_STATUSES = ["invited", "active", "inactive", "suspended"] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];
export const DRIVER_STATUS_META: Record<DriverStatus, { label: string; tone: Tone }> = {
  invited: { label: "Invité", tone: "blue" },
  active: { label: "Actif", tone: "green" },
  inactive: { label: "Désactivé", tone: "neutral" },
  suspended: { label: "Suspendu", tone: "red" },
};

// -----------------------------------------------------------------------------
// Véhicules
// -----------------------------------------------------------------------------
export const VEHICLE_CATEGORIES = ["standard", "business", "first", "van", "green"] as const;
export type VehicleCategory = (typeof VEHICLE_CATEGORIES)[number];

export const VEHICLE_CATEGORY_META: Record<VehicleCategory, { label: string; description: string; seats: number }> = {
  standard: { label: "Berline", description: "Toyota Camry, Skoda Superb, Peugeot 508…", seats: 4 },
  business: { label: "Business", description: "Mercedes Classe E, BMW Série 5, Audi A6…", seats: 4 },
  first: { label: "Prestige", description: "Mercedes Classe S, BMW Série 7…", seats: 4 },
  van: { label: "Van", description: "Mercedes Classe V, Vito — jusqu'à 7-8 places", seats: 7 },
  green: { label: "Électrique", description: "Tesla, Mercedes EQE, 100 % électrique", seats: 4 },
};

/** Même logique que private.category_compatible (SQL). */
export function isCategoryCompatible(requested: VehicleCategory, vehicle: VehicleCategory, allowUpgrade: boolean): boolean {
  if (requested === vehicle) return true;
  if (!allowUpgrade) return false;
  if (requested === "standard") return ["business", "first", "green", "van"].includes(vehicle);
  if (requested === "business") return vehicle === "first";
  return false;
}

// -----------------------------------------------------------------------------
// Divers
// -----------------------------------------------------------------------------
export const PAYMENT_METHODS = ["card", "cash", "online", "invoice", "account"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  card: "Carte à bord",
  cash: "Espèces",
  online: "Payé en ligne",
  invoice: "Sur facture",
  account: "Compte entreprise",
};

export const RIDE_SOURCES = ["dashboard", "api", "booking_site"] as const;
export type RideSource = (typeof RIDE_SOURCES)[number];
export const RIDE_SOURCE_LABELS: Record<RideSource, string> = {
  dashboard: "Dashboard",
  api: "Site (API)",
  booking_site: "Mini-site",
};

export type RideType = "instant" | "scheduled";
export const RIDE_TYPE_LABELS: Record<RideType, string> = { instant: "Instantanée", scheduled: "Planifiée" };

export type OfferStatus = "pending" | "accepted" | "declined" | "expired" | "closed";
export const OFFER_STATUS_META: Record<OfferStatus, { label: string; tone: Tone }> = {
  pending: { label: "En attente", tone: "amber" },
  accepted: { label: "Acceptée", tone: "green" },
  declined: { label: "Refusée", tone: "red" },
  expired: { label: "Expirée", tone: "neutral" },
  closed: { label: "Fermée", tone: "neutral" },
};

export type OrgRole = "owner" | "admin" | "dispatcher";
export const ORG_ROLE_LABELS: Record<OrgRole, string> = {
  owner: "Propriétaire",
  admin: "Administrateur",
  dispatcher: "Dispatcher",
};

export type OrgStatus = "active" | "suspended" | "archived";
export const ORG_STATUS_META: Record<OrgStatus, { label: string; tone: Tone }> = {
  active: { label: "Actif", tone: "green" },
  suspended: { label: "Suspendu", tone: "amber" },
  archived: { label: "Archivé", tone: "neutral" },
};

/** Classification instantanée / planifiée (miroir du trigger SQL). */
export function classifyRide(pickupAt: Date | null, now: Date, instantThresholdMinutes = 45): RideType {
  if (!pickupAt) return "instant";
  return pickupAt.getTime() <= now.getTime() + instantThresholdMinutes * 60_000 ? "instant" : "scheduled";
}

export const DEFAULT_DISPATCH_RADII_M = [4000, 8000, 12000, 16000] as const;
export const DEFAULT_REMINDER_OFFSETS_MIN = [1440, 180, 60, 30] as const;

/** Codes d'erreur métier renvoyés par les RPC / l'API. */
export const ERROR_MESSAGES: Record<string, string> = {
  RIDE_ALREADY_ASSIGNED: "Course déjà attribuée.",
  OFFER_NOT_FOUND: "Offre introuvable.",
  OFFER_CLOSED: "Cette offre n'est plus disponible.",
  DRIVER_BUSY: "Vous avez déjà une course en cours.",
  INVALID_TRANSITION: "Action impossible pour ce statut.",
  RIDE_NOT_FOUND: "Course introuvable.",
  RIDE_CLOSED: "Course déjà clôturée.",
  ACTIVE_RIDE: "Terminez votre course avant de passer hors ligne.",
  FORBIDDEN_TENANT: "Accès refusé.",
  PLAN_LIMIT_DRIVERS: "Limite de chauffeurs atteinte pour votre offre.",
  PLAN_LIMIT_RIDES: "Limite mensuelle de courses atteinte pour votre offre.",
  PLAN_LIMIT_ADMINS: "Limite d'administrateurs atteinte pour votre offre.",
  PLAN_FEATURE_API: "L'API n'est pas incluse dans votre offre.",
  PLAN_FEATURE_BOOKING_SITE: "Le site de réservation n'est pas inclus dans votre offre.",
  PLAN_FEATURE_CUSTOM_DOMAIN: "Le domaine personnalisé n'est pas inclus dans votre offre.",
  PICKUP_IN_PAST: "La date de prise en charge est déjà passée.",
  PICKUP_TOO_FAR: "Date de prise en charge trop lointaine.",
  // Mode centrale (20260924002600)
  PRICE_REQUIRED: "Prix obligatoire : le chauffeur doit voir sa part avant d'accepter.",
  COMMISSION_TOO_HIGH: "La commission et les frais dépassent le prix de la course.",
  SETTLEMENT_LOCKED: "Paiement déjà déclaré ou encaissé : prix et commission ne sont plus modifiables.",
  DRIVER_BLOCKED: "Commissions à régler : réglez-les pour accepter de nouvelles courses.",
  DRIVER_BANNED: "Chauffeur banni : levez d'abord le bannissement.",
  DRIVER_ON_RIDE: "Client à bord : attendez la fin de la course.",
  IDENTITY_BANNED: "Identité bannie (téléphone, e-mail, carte VTC, plaque…) : ce chauffeur ne peut pas être ajouté.",
};

/** Extrait un code métier (ex. « PLAN_LIMIT_DRIVERS ») d'un message d'erreur PostgreSQL. */
export function extractErrorCode(message: string | undefined | null): string | null {
  if (!message) return null;
  const match = /\b([A-Z][A-Z_]{3,}[A-Z])\b(?=:|$|\s)/.exec(message);
  return match?.[1] ?? null;
}

export function humanizeError(message: string | undefined | null, fallback = "Une erreur est survenue."): string {
  const code = extractErrorCode(message);
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  if (code?.startsWith("FORBIDDEN")) return "Accès refusé.";
  return fallback;
}
