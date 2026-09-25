// Types des lignes / RPC utilisés par les applications (sous-ensemble).
import type {
  DriverPresence, DriverStatus, OfferStatus, OrgRole, OrgStatus, PaymentMethod, RideSource, RideStatus, RideType,
  VehicleCategory,
} from "./domain";

export type Uuid = string;
export type Iso = string;

export interface Organization {
  id: Uuid;
  name: string;
  slug: string;
  status: OrgStatus;
  plan_id: Uuid | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  timezone: string;
  currency: string;
  logo_url: string | null;
  brand_color: string | null;
  created_at: Iso;
}

export interface Vehicle {
  id: Uuid;
  organization_id: Uuid;
  brand: string | null;
  model: string;
  color: string | null;
  plate: string;
  category: VehicleCategory;
  seats: number;
  luggage_capacity: number;
}

export interface Driver {
  id: Uuid;
  organization_id: Uuid;
  number: number;
  user_id: Uuid | null;
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  photo_url: string | null;
  status: DriverStatus;
  presence: DriverPresence;
  vehicle_id: Uuid | null;
  current_ride_id: Uuid | null;
  online_since: Iso | null;
  last_seen_at: Iso | null;
  created_at: Iso;
}

export interface DriverLocation {
  driver_id: Uuid;
  organization_id: Uuid;
  lat: number;
  lng: number;
  heading: number | null;
  speed_mps: number | null;
  accuracy_m: number | null;
  battery_level: number | null;
  updated_at: Iso;
}

export interface Ride {
  id: Uuid;
  organization_id: Uuid;
  number: number;
  type: RideType;
  status: RideStatus;
  source: RideSource;
  dispatch_mode: "geo" | "fleet" | null;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address: string;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  pickup_at: Iso;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  passengers: number;
  luggage: number;
  vehicle_category: VehicleCategory;
  price_cents: number | null;
  currency: string;
  payment_method: PaymentMethod;
  comment: string | null;
  flight_number: string | null;
  external_reference: string | null;
  estimated_distance_m: number | null;
  estimated_duration_s: number | null;
  /** Tracé routier encodé (polyline précision 5) */
  route_polyline?: string | null;
  driver_id: Uuid | null;
  vehicle_id: Uuid | null;
  dispatch_wave: number;
  dispatch_radius_m: number | null;
  dispatch_started_at: Iso | null;
  next_dispatch_at: Iso | null;
  accepted_at: Iso | null;
  completed_at: Iso | null;
  cancelled_at: Iso | null;
  cancel_reason: string | null;
  created_at: Iso;
  updated_at: Iso;
}

export interface RideOffer {
  id: Uuid;
  ride_id: Uuid;
  driver_id: Uuid;
  status: OfferStatus;
  mode: "geo" | "fleet";
  wave: number;
  radius_m: number | null;
  distance_m: number | null;
  sent_at: Iso;
  expires_at: Iso | null;
  responded_at: Iso | null;
}

export interface RideEvent {
  id: number;
  organization_id: Uuid;
  ride_id: Uuid | null;
  category: "timeline" | "dispatch" | "system";
  level: "debug" | "info" | "success" | "warning" | "error";
  type: string;
  message: string;
  actor_type: string;
  data: Record<string, unknown>;
  created_at: Iso;
}

export interface Membership {
  organization_id: Uuid;
  role: OrgRole;
  organization: Pick<Organization, "id" | "name" | "slug" | "status" | "logo_url" | "timezone">;
}

export interface RpcResult {
  ok: boolean;
  code: string;
  message?: string;
  [key: string]: unknown;
}

export interface OrgKpis {
  rides_today: number;
  revenue_today_cents: number;
  expected_revenue_today_cents: number;
  rides_week: number;
  revenue_week_cents: number;
  instant_active: number;
  scheduled_upcoming: number;
  scheduled_unassigned: number;
  searching: number;
  offered: number;
  assigned: number;
  in_progress: number;
  completed_today: number;
  cancelled_today: number;
  no_driver_today: number;
  avg_assign_seconds_today: number | null;
  drivers_total: number;
  drivers_online: number;
  drivers_available: number;
  drivers_offered: number;
  drivers_busy: number;
  timezone: string;
}

export interface DriverOffer {
  offer_id: Uuid;
  ride_id: Uuid;
  number: number;
  mode: "geo" | "fleet";
  status: OfferStatus;
  ride_type: RideType;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address: string;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  pickup_at: Iso;
  price_cents: number | null;
  currency: string;
  payment_method: PaymentMethod;
  passengers: number;
  luggage: number;
  vehicle_category: VehicleCategory;
  distance_m: number | null;
  estimated_distance_m: number | null;
  estimated_duration_s: number | null;
  route_polyline?: string | null;
  flight_number: string | null;
  comment: string | null;
  sent_at: Iso;
  expires_at: Iso | null;
}

export interface DriverHome {
  driver: { id: Uuid; number: number; first_name: string; last_name: string; presence: DriverPresence; photo_url: string | null; current_ride_id: Uuid | null };
  organization: { id: Uuid; name: string; logo_url: string | null; phone: string | null; timezone: string };
  vehicle: { brand: string | null; model: string; plate: string; color: string | null; category: VehicleCategory; seats: number } | null;
  today: { rides: number; revenue_cents: number };
  next_scheduled: { id: Uuid; number: number; pickup_at: Iso; pickup_address: string; dropoff_address: string; price_cents: number | null } | null;
  pending_offers: number;
}

// -----------------------------------------------------------------------------
// Suivi des vols (migration 20260924002100_flight_tracking)
// -----------------------------------------------------------------------------
export type FlightStatus = "scheduled" | "delayed" | "departed" | "landed" | "cancelled" | "diverted" | "unknown";
/** arrival : prise en charge à l'aéroport ; departure : dépôt pour un vol (information seulement). */
export type FlightMode = "arrival" | "departure";

/**
 * Colonnes vol d'une course (lecture seule côté client, écrites par le worker).
 * Horaires = arrivée du vol en mode `arrival`, départ du vol en mode `departure` ;
 * `flight_origin` = provenance (arrival) ou destination (departure).
 */
export interface RideFlightFields {
  flight_mode: FlightMode | null;
  flight_status: FlightStatus | null;
  flight_scheduled_arrival: Iso | null;
  flight_estimated_arrival: Iso | null;
  flight_actual_arrival: Iso | null;
  flight_terminal: string | null;
  flight_origin: string | null;
  /** Retard en minutes (négatif = en avance). */
  flight_delay_minutes: number | null;
  flight_checked_at: Iso | null;
  /** Heure demandée avant recalage automatique (null si jamais recalée). */
  pickup_at_original: Iso | null;
}

// Fusion de déclarations : les lignes `rides` (select *) et les offres chauffeur portent les champs vol.
export interface Ride extends Partial<RideFlightFields> {}
export interface DriverOffer extends Partial<Omit<RideFlightFields, "flight_checked_at">> {}

export interface FlightSettings {
  flight_tracking_enabled: boolean;
  /** Marge entre l'arrivée du vol et la prise en charge (0..120 min). */
  flight_pickup_buffer_minutes: number;
}

/** Ligne renvoyée par private.flights_to_check(n) (worker). */
export interface FlightToCheck {
  id: Uuid;
  organization_id: Uuid;
  /** bigint : chaîne avec node-postgres */
  number: number | string;
  /** Normalisé : majuscules, sans espaces (« AF1234 »). */
  flight_number: string;
  /** Date locale du vol (type SQL date). */
  flight_date: string | Date;
  mode: FlightMode;
  timezone: string;
  pickup_at: Iso | Date;
  flight_status: FlightStatus | null;
  flight_scheduled_arrival: Iso | Date | null;
}

/** Étiquettes renvoyées par apply_flight_status (`events`) et dans `data.event` des notifications `flight_update`. */
export type FlightEventTag =
  | "flight.delayed" | "flight.early" | "flight.updated" | "flight.landed" | "flight.cancelled"
  | "flight.diverted" | "flight.departure_delayed" | "flight.terminal" | "flight.incoherent";

/** Résultat de private.apply_flight_status(...). */
export interface ApplyFlightStatusResult {
  ok: boolean;
  code: "UPDATED" | "UNCHANGED" | "RIDE_NOT_FOUND" | "NO_FLIGHT" | "RIDE_CLOSED" | "TRACKING_DISABLED" | "FLIGHT_CHANGED";
  message?: string;
  ride_id?: Uuid;
  mode?: FlightMode;
  flight_status?: FlightStatus;
  delay_minutes?: number | null;
  pickup_changed?: boolean;
  pickup_at?: Iso;
  previous_pickup_at?: Iso;
  pickup_at_original?: Iso | null;
  events?: FlightEventTag[];
  notified?: boolean;
}

/** `data` des notifications push de type `flight_update` (chauffeur). */
export interface FlightUpdateNotificationData {
  type: "flight_update";
  event: FlightEventTag;
  ride_id: Uuid;
  flight_number: string;
  flight_status: FlightStatus;
  delay_minutes: number | null;
  terminal: string | null;
  pickup_at: Iso;
  pickup_at_original: Iso | null;

// ---------------------------------------------------------------------------
// Alertes de suivi des courses (migration 20260924002200_ride_alerts.sql)
// ---------------------------------------------------------------------------
export type RideAlertKind = "late" | "stalled" | "no_gps" | "not_started";
export type RideAlertSeverity = "warning" | "critical";
export type RideAlertStatus = "open" | "acknowledged" | "resolved";
export type RideAlertResolution = "kept" | "reassigned" | "relaunched" | "auto_resolved";
/** keep → acknowledge_ride_alert(alert_id) · reassign → assign_ride(ride_id, driver_id) · relaunch → reassign_ride(ride_id, reason) */
export type RideAlertAction = "keep" | "reassign" | "relaunch";

export interface RideAlertData {
  alert_id: Uuid;
  ride_number: number;
  driver_id: Uuid;
  driver_name: string;
  driver_number: number;
  actions: RideAlertAction[];
  /** late */
  delay_minutes?: number;
  eta_minutes?: number;
  expected_at?: Iso;
  reference_at?: Iso;
  tolerance_minutes?: number;
  /** late · stalled */
  distance_m?: number | null;
  /** stalled */
  still_minutes?: number;
  since?: Iso;
  threshold_minutes?: number;
  /** stalled · no_gps */
  lat?: number | null;
  lng?: number | null;
  /** no_gps · not_started */
  last_location_at?: Iso | null;
  location_age_s?: number | null;
  max_age_s?: number;
  /** late · not_started */
  pickup_at?: Iso;
  minutes_to_pickup?: number;
  presence?: DriverPresence;
}

export interface RideAlert {
  id: Uuid;
  organization_id: Uuid;
  ride_id: Uuid;
  driver_id: Uuid | null;
  kind: RideAlertKind;
  severity: RideAlertSeverity;
  message: string;
  data: RideAlertData;
  status: RideAlertStatus;
  resolution: RideAlertResolution | null;
  muted_until: Iso | null;
  created_at: Iso;
  updated_at: Iso;
  resolved_at: Iso | null;
  resolved_by: Uuid | null;
}

/** Diffusion temps réel `ride.alert` sur `org:{organization_id}` (et champ `alert` des RPC). */
export interface RideAlertBroadcast extends Omit<RideAlert, "organization_id"> {
  op: "insert" | "update" | "resolve";
}

/** Réglages (organization_settings) des alertes. */
export interface RideAlertSettings {
  /** Retard toléré avant alerte (1..60 min, défaut 5) */
  late_alert_tolerance_minutes: number;
  /** Immobilité avant alerte (2..30 min, défaut 4) */
  stalled_alert_minutes: number;
}
