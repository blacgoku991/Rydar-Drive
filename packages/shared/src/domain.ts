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

export const SEARCHING_STATUSES: readonly RideStatus[] = ["CREATED", "SEARCHING_DRIVER", "OFFERED"];
export const ONGOING_STATUSES: readonly RideStatus[] = [
  "DRIVER_EN_ROUTE",
  "DRIVER_ARRIVED",
  "PASSENGER_ONBOARD",
  "IN_PROGRESS",
];

export const isSearching = (s: RideStatus) => SEARCHING_STATUSES.includes(s);
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

/**
 * Course planifiée acceptée mais jamais démarrée : clôturée par le serveur (annulée, motif « Non effectuée ») ce nombre
 * d'heures après l'heure de prise en charge. Même valeur que private.expire_unstarted_rides (migration 20260924005900).
 */
export const UNSTARTED_RIDE_EXPIRY_HOURS = 6;

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

export const DEFAULT_DISPATCH_RADII_M = [4000, 8000, 12000, 16000] as const;
/** Relance quand personne n'a accepté après le dernier rayon (miroir de organization_settings.dispatch_retry_radii_m). */
export const DEFAULT_RETRY_RADII_M = [4000, 8000] as const;

/** Rayons successifs de la recherche GPS : premier passage puis relance (miroir de private.dispatch_plan). */
export function dispatchPlan(radii?: readonly number[] | null, retry?: readonly number[] | null) {
  const first = radii?.length ? [...radii] : [...DEFAULT_DISPATCH_RADII_M];
  const again = retry ? [...retry] : first.slice(0, 2);
  return { first, retry: again, waves: [...first, ...again] };
}

/** Codes d'erreur métier renvoyés par les RPC / l'API. */
export const ERROR_MESSAGES: Record<string, string> = {
  RIDE_ALREADY_ASSIGNED: "Course déjà attribuée.",
  // Acceptation refusée : motif réel (20260924004500)
  RIDE_CANCELLED: "Course annulée.",
  SEARCH_ENDED: "Recherche terminée : la course n'est plus proposée.",
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
  // Compte supprimé par le chauffeur (20260924004000) : fiche anonyme conservée pour les courses et règlements
  DRIVER_DELETED: "Ce chauffeur a supprimé son compte : fiche anonyme, non modifiable.",
  // Invitation d'un compte existant (20260924004700) : activée par la personne elle-même (lien reçu par e-mail)
  INVITATION_PENDING: "Invitation en attente : seule la personne invitée peut activer cet accès, avec le lien reçu par e-mail.",
  // Frais plateforme (20260924003000)
  PLATFORM_FEES_OVERDUE: "Frais plateforme en retard : réglez Rydar Drive (Encaissements) pour créer de nouvelles courses.",
  PLATFORM_LEDGER_IMMUTABLE: "Les frais plateforme enregistrés ne se modifient pas.",
  // Visite médicale (donnée de santé) retirée des justificatifs déposés (20260924004300)
  TYPE_NOT_ALLOWED: "Ce type de document ne se dépose plus dans l'application.",
  // Codes levés par les migrations 20260924004300 à 20260924005300
  DRIVER_NOT_FOUND: "Chauffeur introuvable.",
  INVALID_INSTALLATION_ID: "Appareil non reconnu : relancez l'application.",
  SETTLEMENTS_OPEN: "Des règlements chauffeur sont encore ouverts : soldez-les ou annulez-les avant le retour au mode flotte.",
  SUBDOMAIN_RESERVED: "Ce sous-domaine est réservé à la plateforme : choisissez-en un autre.",
  SUBDOMAIN_CHANGE_LIMIT: "Sous-domaine déjà modifié 5 fois ces 7 derniers jours : réessayez plus tard ou contactez l'équipe Rydar.",
  MESSAGE_NOT_FOUND: "Message introuvable : il a peut-être été supprimé.",
  INVALID_MESSAGE: "Message introuvable.",
  NOT_REMOVABLE: "Seuls les messages du fil de la flotte peuvent être supprimés.",
  // Formulaire de contact du site vitrine (20260924005700)
  CONTACT_BUSY: "Trop de demandes de contact en ce moment : réessayez un peu plus tard.",
  CONTACT_INVALID: "Demande de contact invalide : vérifiez les champs du formulaire.",
  // Webhooks sortants (20260924006000)
  WEBHOOK_INVALID_URL:
    "Adresse invalide : https:// obligatoire, adresse publique (ni localhost ni réseau privé), sans identifiants, 500 caractères au plus.",
  WEBHOOK_INVALID_EVENTS: "Événement inconnu : choisissez parmi les événements proposés.",
  WEBHOOK_INVALID_SECRET: "Secret invalide : 32 à 200 caractères (lettres, chiffres, _ . -).",
  WEBHOOK_LIMIT: "10 webhooks au plus par organisation : supprimez-en un avant d'en ajouter un autre.",
  WEBHOOK_NOT_FOUND: "Webhook introuvable.",
  WEBHOOK_DISABLED: "Webhook désactivé : réactivez-le avant de l'essayer.",
  WEBHOOK_DELIVERY_NOT_FOUND: "Envoi introuvable.",
  // Tests et renvois bornés (20260924006100)
  WEBHOOK_TEST_PENDING: "Un test de ce webhook est déjà en cours d'envoi : attendez son résultat avant d'en relancer un.",
  WEBHOOK_TEST_RATE_LIMITED: "Trop de tests et de renvois de webhooks en une minute (10 au plus par centrale) : réessayez dans un instant.",
  // Interrupteur plateforme des mini-sites (20260924006200)
  BOOKING_SITES_DISABLED: "Les mini-sites de réservation sont momentanément désactivés par Rydar.",
  // Réseau partagé (20260924006700 à 20260924007100 ; liste : NETWORK_ERROR_CODES de network.ts)
  NETWORK_DISABLED: "Le réseau partagé est momentanément désactivé par Rydar.",
  NETWORK_SUSPENDED: "Réseau partagé suspendu par Rydar pour votre organisation : contactez Rydar.",
  NETWORK_TERMS_REQUIRED: "Acceptez la convention du réseau partagé pour l'activer.",
  NETWORK_TERMS_OUTDATED: "La convention du réseau partagé a changé : lisez et acceptez la nouvelle version.",
  NETWORK_VTC_REGISTRATION_REQUIRED:
    "N° d'inscription au registre des exploitants VTC manquant : complétez-le avant d'activer le réseau partagé.",
  NETWORK_PAYMENT_METHODS_REQUIRED:
    "Partage actif : proposez un lien de paiement ou un virement (RIB) aux chauffeurs partenaires, les espèces restent possibles en plus.",
  NETWORK_INSURANCE_REQUIRED: "Confirmez que votre assurance couvre les courses faites pour d'autres organisations.",
  NETWORK_RIDE_LOCKED: "Course confiée à un partenaire : retirez-la-lui pour la modifier.",
  NETWORK_CLOSE_NOT_ALLOWED:
    "Clôture impossible : réservée à une course en cours dont le chauffeur partenaire n'est plus actif ou sans position depuis 30 min.",
  NETWORK_CONTEST_EXPIRED: "Délai dépassé : une course partagée se conteste dans les 7 jours qui suivent sa fin.",
  NETWORK_SETTLEMENT_ACTION_FORBIDDEN:
    "Action impossible sur un règlement du réseau partagé : un versement dû à un chauffeur partenaire ne s'annule pas (contestez la course).",
  NETWORK_CONSENT_REQUIRED: "Activez « Courses du réseau partagé » et acceptez ses conditions dans votre profil.",
  NETWORK_PAYOUT_ON_HOLD: "Versement retenu : course à vérifier (validez-la, ou attendez 72 h après sa fin).",
  NETWORK_DISPUTE_NOT_ALLOWED: "Contestation impossible pour ce règlement (déjà contesté, ou rien à contester).",
  OFFER_CHANGED: "La course a été modifiée : elle vous sera reproposée si elle est encore disponible.",
  DRIVER_BUSY_AT_TIME: "Créneau déjà pris : une autre course de ce chauffeur chevauche celle-ci.",
  DRIVER_HAS_NETWORK_OBLIGATIONS:
    "Ce chauffeur a une course ou un règlement en cours avec une organisation partenaire : archivez-le au lieu de le supprimer.",
  PAYOUT_DETAILS_INVALID: "Coordonnées bancaires invalides : vérifiez le titulaire, l'IBAN et le BIC.",
  PAYOUT_DETAILS_IN_USE: "Un versement vous est encore dû : modifiez vos coordonnées bancaires au lieu de les supprimer.",
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
