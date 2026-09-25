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

// ---------------------------------------------------------------------------
// Gains + documents chauffeur (migration 20260924002400_driver_money_docs)
// ---------------------------------------------------------------------------
export type DocumentType = "driving_license" | "vtc_card" | "insurance" | "vehicle_registration" | "identity" | "medical" | "other";
/** Statut stocké (colonne driver_documents.status). */
export type DocumentStoredStatus = "pending" | "valid" | "expired" | "rejected";
/** Statut affiché, calculé côté SQL (expiring = échéance ≤ 30 j). */
export type DocumentState = "valid" | "expiring" | "expired" | "pending" | "rejected";

/** Réglage centrale : organization_settings.driver_commission_percent (0..100, null = pas de net estimé). */
export interface DriverCommissionSetting {
  driver_commission_percent: number | null;
}

/** Ligne public.driver_documents (colonnes ajoutées : source, reminders_sent, reviewed_at, reviewed_by, review_note). */
export interface DriverDocumentRow {
  id: Uuid;
  organization_id: Uuid;
  driver_id: Uuid;
  type: DocumentType;
  label: string | null;
  file_path: string | null;
  number: string | null;
  issued_at: string | null;
  expires_at: string | null;
  status: DocumentStoredStatus;
  source: "dashboard" | "driver";
  reminders_sent: number[];
  reviewed_at: Iso | null;
  reviewed_by: Uuid | null;
  review_note: string | null;
  created_at: Iso;
  updated_at: Iso;
}

export interface EarningsPeriod {
  from: Iso;
  rides: number;
  revenue_cents: number;
  net_cents: number | null;
  commission_cents: number | null;
  cash_cents: number;
  distance_m: number;
  duration_s: number;
  unpriced_rides: number;
}

export interface EarningsDay {
  /** AAAA-MM-JJ (fuseau de l'organisation) */
  date: string;
  rides: number;
  revenue_cents: number;
  net_cents: number | null;
  distance_m: number;
}

export interface EarningsRide {
  id: Uuid;
  number: number;
  pickup: string;
  dropoff: string;
  completed_at: Iso;
  price_cents: number | null;
  net_cents: number | null;
  currency: string;
  payment_method: PaymentMethod;
  vehicle_category: VehicleCategory;
  distance_m: number | null;
  duration_s: number | null;
}

/** RPC driver_earnings(p_days) */
export interface DriverEarnings {
  currency: string;
  timezone: string;
  commission_percent: number | null;
  days: number;
  today: EarningsPeriod;
  week: EarningsPeriod;
  month: EarningsPeriod;
  upcoming: { rides: number; revenue_cents: number; net_cents: number | null };
  series: EarningsDay[];
  recent: EarningsRide[];
}

/** Document tel que renvoyé par les RPC (driver_documents, driver_submit_document, review, alertes, temps réel). */
export interface DriverDocumentItem {
  id: Uuid;
  driver_id: Uuid;
  type: DocumentType;
  /** Intitulé affichable (label saisi, sinon libellé FR du type) */
  label: string;
  number: string | null;
  issued_at: string | null;
  expires_at: string | null;
  status: DocumentState;
  /** expires_at − aujourd'hui (fuseau org) ; négatif si échu ; null sans échéance */
  days_left: number | null;
  file_path: string | null;
  source: "dashboard" | "driver";
  review_note: string | null;
  reviewed_at: Iso | null;
  created_at: Iso;
  updated_at: Iso;
}

/** RPC driver_documents() */
export interface DriverDocuments {
  today: string;
  documents: DriverDocumentItem[];
  summary: Record<DocumentState, number>;
  /** Types exigés sans document valide / bientôt échu / en validation */
  missing_types: DocumentType[];
}

export interface DocumentDriverRef {
  id: Uuid;
  number: number;
  first_name: string;
  last_name: string;
}

export interface OrgDocumentAlert extends DriverDocumentItem {
  driver: DocumentDriverRef & { photo_url: string | null; status: DriverStatus };
}

/** RPC org_document_alerts(p_org) */
export interface OrgDocumentAlerts {
  today: string;
  counts: { pending: number; expired: number; expiring: number };
  pending: OrgDocumentAlert[];
  expired: OrgDocumentAlert[];
  expiring: OrgDocumentAlert[];
}

/** Temps réel « driver.document » (org:{id} avec driver ; driver:{id} sans). */
export interface DriverDocumentEvent {
  action: "submitted" | "validated" | "rejected" | "expiring" | "expired";
  document: DriverDocumentItem;
  driver?: DocumentDriverRef;
  /** submitted : documents en attente retirés par ce nouveau dépôt */
  replaced_ids?: Uuid[];
  /** expiring / expired : seuil de rappel (30, 7 ou 0 jours) */
  threshold?: 30 | 7 | 0;
}
