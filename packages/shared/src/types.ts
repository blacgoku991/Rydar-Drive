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
