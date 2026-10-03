// État du centre de commande (instantané + événements temps réel) : réducteur pur, testé sans navigateur.
import type { ChatMessage, FleetReportUpdate, OrgKpis, RideAlertBroadcast } from "@rydar/shared";
import type { LiveAlert, LiveDriver, LiveOffer, LiveReport, LiveRide, LiveSnapshot } from "@/lib/queries/live";

export type State = {
  drivers: Record<string, LiveDriver>;
  rides: Record<string, LiveRide>;
  offers: Record<string, LiveOffer>;
  alerts: Record<string, LiveAlert>;
  reports: Record<string, LiveReport>;
  kpis: OrgKpis | null;
  /** Réseau partagé : noms des organisations partenaires déjà lus (« Réseau · Flotte B ») */
  partners?: Record<string, string>;
};
export type Action =
  | { type: "snapshot"; snapshot: LiveSnapshot }
  | { type: "kpis"; kpis: OrgKpis }
  | { type: "locations"; payloads: any[] }
  | { type: "driver"; payload: any }
  | { type: "ride"; payload: any }
  | { type: "route"; id: string; polyline: string | null }
  | { type: "offer"; payload: any }
  | { type: "alert"; payload: RideAlertBroadcast }
  | { type: "report"; payload: ChatMessage }
  | { type: "report-update"; payload: FleetReportUpdate };

const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.id, x]));
const omit = <T,>(rec: Record<string, T>, id: string): Record<string, T> => {
  const next = { ...rec };
  delete next[id];
  return next;
};
const sameTrip = (a: LiveRide, b: LiveRide) =>
  a.pickup_lat === b.pickup_lat && a.pickup_lng === b.pickup_lng && a.dropoff_lat === b.dropoff_lat && a.dropoff_lng === b.dropoff_lng;
/** Client à bord : le trajet est tracé sur la carte même sans sélection. */
export const ON_BOARD = new Set(["PASSENGER_ONBOARD", "IN_PROGRESS"]);

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "snapshot": {
      // Une course reçue en temps réel pendant la requête est plus récente que l'instantané : on la garde
      const rides = byId(action.snapshot.rides);
      for (const [id, ride] of Object.entries(rides)) {
        const cur = state.rides[id];
        if (cur && Date.parse(cur.updated_at) > Date.parse(ride.updated_at)) rides[id] = cur;
        // Tracé hors instantané (chargé à la sélection ou reçu en temps réel) : conservé tant que le trajet est le même
        else if (ride.route_polyline === undefined && cur && cur.route_polyline !== undefined && sameTrip(cur, ride)) rides[id] = { ...ride, route_polyline: cur.route_polyline };
      }
      return {
        drivers: byId(action.snapshot.drivers),
        rides,
        offers: byId(action.snapshot.offers),
        alerts: byId(action.snapshot.alerts ?? []),
        reports: byId(action.snapshot.reports ?? []),
        // Indicateurs indisponibles (lecture en échec) : on garde les derniers connus
        kpis: action.snapshot.kpis ?? state.kpis,
        ...(state.partners || action.snapshot.partners ? { partners: { ...state.partners, ...action.snapshot.partners } } : {}),
      };
    }
    case "kpis":
      return { ...state, kpis: action.kpis };
    case "locations": {
      // Lot de positions (au plus une par chauffeur) : une seule copie de la flotte, seuls les chauffeurs déplacés changent
      let drivers: Record<string, LiveDriver> | null = null;
      for (const p of action.payloads) {
        const d = (drivers ?? state.drivers)[p.driver_id];
        // Chauffeur en course partenaire : aucune position montrée (Q5 ; la base n'en diffuse pas)
        if (!d || d.network_giver) continue;
        // Position plus ancienne que celle connue (instantané relu entre-temps) : ignorée
        if (d.location && p.updated_at && Date.parse(p.updated_at) < Date.parse(d.location.updated_at)) continue;
        drivers ??= { ...state.drivers };
        drivers[d.id] = { ...d, location: { lat: p.lat, lng: p.lng, heading: p.heading, speed_mps: p.speed, updated_at: p.updated_at } };
      }
      return drivers ? { ...state, drivers } : state;
    }
    case "driver": {
      const p = action.payload;
      const d = state.drivers[p.id];
      if (!d) return state;
      // Réseau partagé (B) : course partenaire en cours → « En course partenaire ({A}) », position retirée (Q5)
      const partner = p.network === true;
      const next: LiveDriver = {
        ...d,
        presence: p.presence,
        status: p.status,
        current_ride_id: p.current_ride_id,
        network_giver: partner ? (p.network_giver ?? d.network_giver ?? null) : null,
        ...(partner ? { location: null } : {}),
      };
      return { ...state, drivers: { ...state.drivers, [d.id]: next } };
    }
    case "ride": {
      const p = { ...action.payload };
      const prev = state.rides[p.id];
      // Le tracé n'est diffusé qu'à la création / modification : sinon on garde l'existant (ou il reste à charger)
      if (p.route_polyline == null && (prev || p.op !== "insert")) delete p.route_polyline;
      // Réseau partagé (A) : chauffeur partenaire diffusé sans identifiant (driver_id null, network: true) ; son
      // organisation vient de l'instantané. Sans drapeau : chauffeur propre ou aucun, plus de partenaire.
      if (!("driver_org_id" in p)) {
        if (p.network === true) p.driver_org_id = prev?.driver_org_id ?? null;
        else if ("driver_id" in p) {
          p.network = false;
          p.driver_org_id = p.driver_id && prev && p.driver_id === prev.driver_id ? (prev.driver_org_id ?? null) : null;
        }
      }
      return { ...state, rides: { ...state.rides, [p.id]: { ...(prev ?? {}), ...p } as LiveRide } };
    }
    case "route": {
      const ride = state.rides[action.id];
      if (!ride || ride.route_polyline !== undefined) return state;
      return { ...state, rides: { ...state.rides, [ride.id]: { ...ride, route_polyline: action.polyline } } };
    }
    case "offer": {
      const p = action.payload;
      // Offre à un chauffeur partenaire (réseau partagé, `network: true`, sans chauffeur ni distance) : jamais gardée,
      // comme dans l'instantané (RLS) — compteur des partenaires dans le bloc réseau de la course.
      if (p?.network === true || !p?.driver_id) return state.offers[p?.id] ? { ...state, offers: omit(state.offers, p.id) } : state;
      const offers = { ...state.offers };
      if (p.status === "pending") offers[p.id] = { ...(offers[p.id] ?? {}), ...p };
      else delete offers[p.id];
      return { ...state, offers };
    }
    case "alert": {
      const a = action.payload;
      const alerts = { ...state.alerts };
      if (a.status === "resolved") delete alerts[a.id];
      else {
        const { op: _op, ...rest } = a;
        alerts[a.id] = { ...(alerts[a.id] ?? {}), ...rest } as LiveAlert;
      }
      return { ...state, alerts };
    }
    case "report": {
      const m = action.payload;
      if (!m.report_type || m.lat == null || m.lng == null || !m.expires_at) return state;
      return {
        ...state,
        reports: {
          ...state.reports,
          [m.id]: {
            id: m.id, report_type: m.report_type, body: m.body, lat: m.lat, lng: m.lng, expires_at: m.expires_at, confirmations: m.confirmations,
            dismissals: m.dismissals, author_name: m.author_name, author_type: m.author_type, author_driver_id: m.author_driver_id, created_at: m.created_at,
          },
        },
      };
    }
    case "report-update": {
      const u = action.payload;
      const prev = state.reports[u.id];
      if (!prev) return state;
      const reports = { ...state.reports };
      if (!u.active) delete reports[u.id];
      else reports[u.id] = { ...prev, expires_at: u.expires_at, confirmations: u.confirmations, dismissals: u.dismissals };
      return { ...state, reports };
    }
  }
}
