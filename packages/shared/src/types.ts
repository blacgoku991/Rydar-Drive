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
  driver: {
    id: Uuid; number: number; first_name: string; last_name: string; presence: DriverPresence; photo_url: string | null;
    current_ride_id: Uuid | null; trust_level?: TrustLevel;
  };
  organization: { id: Uuid; name: string; logo_url: string | null; phone: string | null; timezone: string; dispatch_model?: DispatchModel };
  vehicle: { brand: string | null; model: string; plate: string; color: string | null; category: VehicleCategory; seats: number } | null;
  /** net_cents : part chauffeur du jour (mode centrale), null en mode flotte */
  today: { rides: number; revenue_cents: number; net_cents?: number | null };
  next_scheduled: {
    id: Uuid; number: number; pickup_at: Iso; pickup_address: string; dropoff_address: string; price_cents: number | null;
    driver_payout_cents?: number | null;
  } | null;
  pending_offers: number;
  /** Modèle d'exploitation de l'organisation (migration 20260924002600) */
  model?: DispatchModel;
  /** Mode centrale : commissions à régler, gains à recevoir, blocage éventuel (null en mode flotte) */
  settlement?: DriverSettlementSummary | null;
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
  /** Instantanée repoussée au-delà du seuil : repassée en planifiée ('fleet' = proposée à la flotte,
   *  'assigned' = chauffeur gardé et libéré d'ici là), sinon null */
  requalified?: "fleet" | "assigned" | null;
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
}

// ---------------------------------------------------------------------------
// Alertes de suivi des courses (migration 20260924002200_ride_alerts.sql)
// ---------------------------------------------------------------------------
export type RideAlertKind = "late" | "stalled" | "no_gps" | "not_started";
export type RideAlertSeverity = "warning" | "critical";
export type RideAlertStatus = "open" | "acknowledged" | "resolved";
export type RideAlertResolution = "kept" | "reassigned" | "relaunched" | "auto_resolved";
/** keep → acknowledge_ride_alert(alert_id) · reassign → assign_ride(ride_id, driver_id) · relaunch → reassign_ride(ride_id, reason, expected_driver_id) (DRIVER_CHANGED si le chauffeur a changé ; UNASSIGNED si dispatch auto désactivé) */
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

// Messagerie centrale ⇄ chauffeurs + signalements flotte (migration 20260924002300_chat)
// -----------------------------------------------------------------------------
export type ChatChannel = "driver" | "fleet";
export type ChatAuthorType = "user" | "driver" | "system";
export type FleetReportType = "police" | "control" | "accident" | "traffic" | "danger" | "other";
/** Clé de fil : « fleet » ou « driver:<driver_id> » (fil direct centrale ⇄ chauffeur). */
export type ChatThreadKey = "fleet" | `driver:${string}`;

/** Ligne de public.chat_messages (lecture directe via RLS). */
export interface ChatMessageRow {
  id: Uuid;
  organization_id: Uuid;
  channel: ChatChannel;
  driver_id: Uuid | null;
  author_type: ChatAuthorType;
  author_user_id: Uuid | null;
  author_driver_id: Uuid | null;
  author_name: string;
  body: string;
  report_type: FleetReportType | null;
  lat: number | null;
  lng: number | null;
  expires_at: Iso | null;
  confirmations: number;
  dismissals: number;
  created_at: Iso;
}

/** Message tel que renvoyé par les RPC et diffusé en temps réel (« chat.message »). */
export interface ChatMessage extends ChatMessageRow {
  thread: ChatThreadKey;
  /** Signalement non expiré au moment de l'envoi / de la lecture */
  active: boolean;
}

export interface SendChatMessageResult extends ChatMessage {
  /** Push mis en file : 1 pour un message direct de la centrale, N chauffeurs pour un signalement */
  notified: number;
}

/** Signalement actif vu par un chauffeur (driver_chat_overview). */
export interface FleetReport extends ChatMessage {
  distance_m: number | null;
  my_vote: boolean | null;
}

export interface ChatThreadSummary {
  thread: ChatThreadKey;
  last_message: ChatMessage | null;
  unread: number;
  last_read_at: Iso | null;
}

export interface ChatOverview {
  organization_id: Uuid;
  fleet: ChatThreadSummary & { thread: "fleet"; active_reports: number };
  drivers: Array<ChatThreadSummary & {
    driver: { id: Uuid; number: number; first_name: string; last_name: string; presence: DriverPresence; status: DriverStatus; photo_url: string | null };
    /** Dernière lecture du fil par le chauffeur (« Vu ») */
    driver_last_read_at: Iso | null;
  }>;
  unread_total: number;
}

export interface DriverChatOverview {
  driver_id: Uuid;
  organization_id: Uuid;
  dispatch: ChatThreadSummary & { seen_by_dispatch_at: Iso | null; messages: ChatMessage[] };
  fleet: ChatThreadSummary & { thread: "fleet"; messages: ChatMessage[] };
  reports: FleetReport[];
  unread_total: number;
}

export interface MarkChatReadResult {
  ok: true;
  thread: ChatThreadKey;
  last_read_at: Iso;
}

export interface FleetReportVoteResult {
  ok: boolean;
  /** OWN_REPORT : l'auteur ne confirme pas son propre signalement (il peut le retirer) */
  code: "VOTED" | "ALREADY_VOTED" | "REPORT_EXPIRED" | "OWN_REPORT";
  message?: string;
  report: ChatMessage;
  my_vote?: boolean;
  expired?: boolean;
}

/** Temps réel « chat.report » (org:<org> et fleet:<org>) */
export interface FleetReportUpdate {
  id: Uuid;
  organization_id: Uuid;
  report_type: FleetReportType;
  expires_at: Iso;
  confirmations: number;
  dismissals: number;
  active: boolean;
}

/** Temps réel « chat.read » (accusé de lecture) */
export interface ChatReadEvent {
  organization_id: Uuid;
  thread: ChatThreadKey;
  reader_key: string;
  reader_type: "user" | "driver";
  last_read_at: Iso;
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

// -----------------------------------------------------------------------------
// Mode « Centrale à commission » (migration 20260924002600_centrale_mode)
// -----------------------------------------------------------------------------
/** fleet : flotte de la société (option 1) ; centrale : réseau de chauffeurs indépendants à commission (option 2). */
export type DispatchModel = "fleet" | "centrale";
/** new : plafond de prix des offres (réglage) jusqu'à N courses réglées ; trusted : toutes les courses. */
export type TrustLevel = "new" | "trusted";
/** Motif de blocage des offres : commission en retard / contestée, encours au-delà du plafond, course trop chère pour un nouveau. */
export type DriverBlocker = "unpaid" | "credit_limit" | "new_driver";
export type SettlementDirection = "driver_owes" | "centrale_owes";
export type SettlementStatus = "due" | "declared" | "paid" | "waived" | "disputed";
export type SettlementMethod = "link" | "cash" | "transfer";
export type BanCategory = "unpaid" | "fraud" | "behavior" | "documents" | "other";
export type IdentityKind = "phone" | "email" | "vtc_card" | "driving_license" | "identity_doc" | "plate" | "device";
export type DriverApplicationStatus = "pending" | "approved" | "rejected";

/** Répartition stockée sur la course (mode centrale). */
export interface RideSplitFields {
  commission_cents: number | null;
  platform_fee_cents: number | null;
  driver_payout_cents: number | null;
  /** commission saisie à la course (sinon % + fixe des réglages) */
  commission_manual: boolean;
}
export interface Ride extends Partial<RideSplitFields> {}

export interface DriverOfferSplit {
  dispatch_model: DispatchModel;
  commission_cents: number | null;
  platform_fee_cents: number | null;
  /** « Vous gagnez … » */
  driver_payout_cents: number | null;
  /** espèces / carte à bord : le chauffeur encaisse le client (et doit commission + frais) */
  driver_collects: boolean;
  blocked: DriverBlocker | null;
}
export interface DriverOffer extends Partial<DriverOfferSplit> {}

export interface OrganizationCentraleFields {
  dispatch_model: DispatchModel;
  platform_fee_percent: number;
  platform_fee_fixed_cents: number;
  join_code: string | null;
  join_enabled: boolean;
  join_auto_approve: boolean;
}
export interface Organization extends Partial<OrganizationCentraleFields> {}

export interface DriverCentraleFields {
  trust_level: TrustLevel;
  joined_via: "dashboard" | "join_link";
  application_status: DriverApplicationStatus | null;
  application_message: string | null;
  applied_at: Iso | null;
  application_reviewed_at: Iso | null;
  application_note: string | null;
  banned_at: Iso | null;
  ban_reason: string | null;
  ban_scope: "org" | "platform" | null;
  suspended_reason: string | null;
}
export interface Driver extends Partial<DriverCentraleFields> {}

export interface EarningsRide {
  commission_cents?: number | null;
  platform_fee_cents?: number | null;
  settlement_status?: SettlementStatus | null;
  settlement_direction?: SettlementDirection | null;
}
export interface DriverEarnings {
  model?: DispatchModel;
}

/** Résumé renvoyé par driver_home().settlement */
export interface DriverSettlementSummary {
  owed_cents: number;
  overdue_cents: number;
  declared_cents: number;
  to_receive_cents: number;
  open_count: number;
  next_due_at: Iso | null;
  blocked: DriverBlocker | null;
  blocked_message: string | null;
}

/** Règlement d'une course (private.settlement_json) */
export interface Settlement {
  id: Uuid;
  ride_id: Uuid;
  driver_id: Uuid | null;
  driver_label: string;
  direction: SettlementDirection;
  /** driver_owes : commission + frais ; centrale_owes : part chauffeur */
  amount_cents: number;
  price_cents: number;
  commission_cents: number;
  platform_fee_cents: number;
  driver_payout_cents: number;
  currency: string;
  payment_method: PaymentMethod;
  /** « C1783 » : libellé de virement / lien de paiement */
  reference: string;
  status: SettlementStatus;
  /** à régler et échéance passée */
  overdue: boolean;
  /** bloque les offres : en retard ou contesté */
  blocking: boolean;
  due_at: Iso;
  declared_at: Iso | null;
  declared_method: SettlementMethod | null;
  declared_note: string | null;
  settled_at: Iso | null;
  settled_method: SettlementMethod | "other" | null;
  note: string | null;
  reminders_sent: number;
  last_reminded_at: Iso | null;
  created_at: Iso;
  updated_at: Iso;
}

export interface DriverSettlementItem extends Settlement {
  ride: { number: number; pickup: string; dropoff: string; completed_at: Iso | null };
}

/** RPC driver_settlements(p_limit) */
export interface DriverSettlements {
  model: DispatchModel;
  currency: string;
  organization: { name: string; phone: string | null };
  grace_hours: number;
  summary: {
    owed_cents: number;
    overdue_cents: number;
    declared_cents: number;
    to_receive_cents: number;
    paid_month_cents: number;
    received_month_cents: number;
    next_due_at: Iso | null;
  };
  /** Tout ce qui est à régler (à régler + contesté), avec le lien prérempli ({montant}, {reference}) */
  pay: {
    amount_cents: number;
    count: number;
    settlement_ids: Uuid[];
    reference: string | null;
    link: string | null;
    methods: SettlementMethod[];
    instructions: string | null;
  };
  blocked: DriverBlocker | null;
  blocked_message: string | null;
  items: DriverSettlementItem[];
}

export type OrgSettlementFilter = "open" | "declared" | "overdue" | "disputed" | "to_pay" | "paid" | "waived" | "all";

export interface OrgSettlementItem extends Settlement {
  ride: { number: number; pickup: string; dropoff: string; completed_at: Iso | null; customer_name: string };
  driver: {
    id: Uuid; number: number; first_name: string; last_name: string; phone: string; trust_level: TrustLevel; banned: boolean;
  } | null;
}

/** RPC org_settlements(p_org, p_filter, p_driver, p_limit, p_before) */
export interface OrgSettlements {
  filter: OrgSettlementFilter;
  items: OrgSettlementItem[];
}

export interface OrgSettlementDriver {
  driver_id: Uuid;
  number: number;
  first_name: string;
  last_name: string;
  phone: string;
  status: DriverStatus;
  trust_level: TrustLevel;
  banned: boolean;
  owed_cents: number;
  overdue_cents: number;
  declared_cents: number;
  to_pay_cents: number;
  open_count: number;
  oldest_due_at: Iso | null;
  last_reminded_at: Iso | null;
  blocked: DriverBlocker | null;
}

export interface CentraleSettings {
  commission_percent: number | null;
  commission_fixed_cents: number | null;
  grace_hours: number;
  credit_limit_cents: number | null;
  block_unpaid: boolean;
  new_driver_max_price_cents: number | null;
  trust_after_rides: number | null;
  methods: SettlementMethod[];
  link: string | null;
  instructions: string | null;
}

/** RPC org_settlement_overview(p_org) */
export interface OrgSettlementOverview {
  model: DispatchModel;
  currency: string;
  month_start: Iso;
  platform_fee: { percent: number; fixed_cents: number };
  settings: CentraleSettings;
  totals: {
    to_collect_cents: number;
    overdue_cents: number;
    declared_cents: number;
    declared_count: number;
    disputed_count: number;
    open_count: number;
    to_pay_cents: number;
    collected_month_cents: number;
    paid_out_month_cents: number;
    waived_month_cents: number;
  };
  month: { rides: number; volume_cents: number; commission_cents: number; platform_fee_cents: number; driver_payout_cents: number };
  drivers: OrgSettlementDriver[];
}

/** Temps réel « settlement.updated » (org:{id} et driver:{id}) */
export interface SettlementEvent {
  action: "created" | "updated" | "declared" | "paid" | "disputed" | "waived" | "reopened";
  settlement: Settlement;
}

/** RPC preview_ride_split(p_org, p_price, p_commission) */
export interface PreviewRideSplit {
  model: DispatchModel;
  price_cents?: number | null;
  commission_cents?: number | null;
  platform_fee_cents?: number | null;
  driver_payout_cents?: number | null;
  manual?: boolean;
  error?: "PRICE_REQUIRED" | "COMMISSION_TOO_HIGH" | null;
}

export type DriverAccountStateKind =
  | "active" | "pending" | "rejected" | "banned" | "suspended" | "inactive" | "invited" | "organization_suspended" | "none";

/** RPC driver_account_state() — utilisable même compte en attente, refusé ou banni */
export interface DriverAccountState {
  state: DriverAccountStateKind;
  message?: string;
  driver?: { id: Uuid; number: number; first_name: string; last_name: string; applied_at: Iso | null; trust_level: TrustLevel };
  organization?: { name: string; logo_url: string | null; phone: string | null; email: string | null; dispatch_model: DispatchModel };
  reason?: string | null;
  can_submit_documents?: boolean;
}

/** RPC svc_join_info(p_code) (service role) */
export interface JoinInfo {
  ok: boolean;
  code?: "JOIN_LINK_INVALID";
  message?: string;
  organization?: { id: Uuid; name: string; logo_url: string | null; brand_color: string | null; city: string | null; phone: string | null; email: string | null };
  auto_approve?: boolean;
}

/** RPC svc_identity_check (service role) */
export interface IdentityCheck {
  banned: boolean;
  duplicate: "phone" | "email" | "plate" | null;
}

export type DriverApplyCode =
  | "PENDING" | "APPROVED" | "JOIN_DISABLED" | "ALREADY_REGISTERED" | "INVALID_FORM" | "PHONE_TAKEN" | "PLATE_TAKEN"
  | "EMAIL_TAKEN" | "IDENTITY_BANNED";

/** RPC svc_driver_apply (service role) */
export interface DriverApplyResult {
  ok: boolean;
  code: DriverApplyCode;
  message?: string;
  driver_id?: Uuid;
  number?: number;
  organization?: { name: string };
}

/** Temps réel « driver.application » (org:{id}) */
export interface DriverApplicationEvent {
  action: "applied" | "approved" | "rejected";
  driver: { id: Uuid; number: number; first_name: string; last_name: string; phone?: string; applied_at?: Iso };
}

/** Temps réel « driver.flagged » (org:{id}) : appareil d'un compte banni */
export interface DriverFlaggedEvent {
  driver_id: Uuid;
  number: number;
  first_name: string;
  last_name: string;
  reason: "banned_device";
}

/** RPC ban_driver(p_driver_id, p_reason, p_category, p_report_to_platform, p_ban_vehicle) */
export interface BanDriverResult {
  ok: boolean;
  code: "BANNED" | "DRIVER_NOT_FOUND" | "REASON_REQUIRED" | "INVALID_CATEGORY" | "ALREADY_BANNED" | "DRIVER_ON_RIDE";
  message?: string;
  identities?: number;
  reassigned_rides?: number;
  report_id?: Uuid | null;
  user_id?: Uuid | null;
}

export interface FraudReport {
  id: Uuid;
  organization_id: Uuid;
  driver_id: Uuid | null;
  driver_label: string;
  category: BanCategory;
  reason: string;
  identities: { kind: IdentityKind; hash: string; hint: string | null }[];
  status: "open" | "platform_banned" | "dismissed" | "lifted";
  reported_by: Uuid | null;
  reviewed_by: Uuid | null;
  reviewed_at: Iso | null;
  review_note: string | null;
  created_at: Iso;
  updated_at: Iso;
}

export interface BannedIdentity {
  id: Uuid;
  scope: "org" | "platform";
  organization_id: Uuid | null;
  kind: IdentityKind;
  value_hash: string;
  hint: string | null;
  driver_id: Uuid | null;
  report_id: Uuid | null;
  reason: string | null;
  created_by: Uuid | null;
  created_at: Iso;
  lifted_at: Iso | null;
  lifted_by: Uuid | null;
  lift_reason: string | null;
}

export interface AdminCentraleRow {
  id: Uuid;
  name: string;
  slug: string;
  status: OrgStatus;
  platform_fee_percent: number;
  platform_fee_fixed_cents: number;
  join_enabled: boolean;
  join_auto_approve: boolean;
  drivers_active: number;
  applications_pending: number;
  drivers_banned: number;
  rides: number;
  volume_cents: number;
  commission_cents: number;
  platform_fee_cents: number;
  outstanding_cents: number;
  overdue_cents: number;
}

/** RPC admin_centrale_overview(p_from) (super admin) */
export interface AdminCentraleOverview {
  from: Iso;
  organizations: AdminCentraleRow[];
  totals: { centrales: number; rides: number; volume_cents: number; platform_fee_cents: number };
  reports_open: number;
  platform_bans: number;
}
