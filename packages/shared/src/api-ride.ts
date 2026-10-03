// Représentation publique d'une course (API v1 et webhooks sortants) : même objet pour GET /api/v1/rides/{id}
// (apps/web/lib/api/v1.ts, ligne lue avec PUBLIC_RIDE_SELECT) et pour « data.ride » des webhooks (apps/worker,
// ligne construite en SQL par private.claim_webhook_deliveries avec les mêmes noms de colonnes). Fonction pure, sans
// dépendance : aucun champ interne (client, notes, commissions, identifiant du chauffeur) n'en sort.
// « driver » (les deux côtés) : public.ride_public_driver (20260924007000) — chauffeur de l'organisation : prénom et
// véhicule ; chauffeur partenaire du réseau partagé : prénom, véhicule figé à l'acceptation et exploitant (« operator »,
// raison sociale de son organisation), null 24 h après la fin de sa course.

export type PublicRideVehicle = { model: string; color: unknown; plate: unknown };

export type PublicRide = {
  id: unknown;
  number: unknown;
  type: unknown;
  status: unknown;
  pickup: { address: unknown; lat: unknown; lng: unknown };
  dropoff: { address: unknown; lat: unknown; lng: unknown };
  pickup_at: unknown;
  passengers: unknown;
  luggage: unknown;
  vehicle_category: unknown;
  price_cents: unknown;
  currency: unknown;
  payment_method: unknown;
  flight_number: unknown;
  external_reference: unknown;
  route: { distance_m: unknown; duration_s: unknown; polyline: unknown } | null;
  /** operator : seulement pour un chauffeur partenaire (réseau partagé) — exploitant qui exécute la course. */
  driver: { first_name: unknown; vehicle: PublicRideVehicle | null; operator?: { name: unknown } } | null;
  timestamps: {
    created_at: unknown;
    accepted_at: unknown;
    driver_arrived_at: unknown;
    started_at: unknown;
    completed_at: unknown;
    cancelled_at: unknown;
  };
  links: { self: string };
};

/** Relation PostgREST : objet, tableau d'un élément (selon la jointure) ou null. */
const one = (v: any) => (Array.isArray(v) ? v[0] : v);

/**
 * Représentation publique d'une course (aucun champ interne). `r` : ligne de rides avec les colonnes de
 * PUBLIC_RIDE_SELECT et « driver » = { first_name, vehicle: { brand, model, color, plate } | null, operator?: { name } }
 * | null (public.ride_public_driver).
 * `appUrl` : URL publique du site, sans « / » final (lien « self »).
 */
export function publicRide(r: any, appUrl: string): PublicRide {
  const d = one(r.driver);
  const v = d ? one(d.vehicle) : null;
  return {
    id: r.id,
    number: r.number,
    type: r.type,
    status: r.status,
    pickup: { address: r.pickup_address, lat: r.pickup_lat, lng: r.pickup_lng },
    dropoff: { address: r.dropoff_address, lat: r.dropoff_lat, lng: r.dropoff_lng },
    pickup_at: r.pickup_at,
    passengers: r.passengers,
    luggage: r.luggage,
    vehicle_category: r.vehicle_category,
    price_cents: r.price_cents,
    currency: r.currency,
    payment_method: r.payment_method,
    flight_number: r.flight_number,
    external_reference: r.external_reference,
    route: r.estimated_distance_m != null ? { distance_m: r.estimated_distance_m, duration_s: r.estimated_duration_s, polyline: r.route_polyline ?? null } : null,
    driver: d
      ? {
          first_name: d.first_name,
          vehicle: v ? { model: `${v.brand ?? ""} ${v.model}`.trim(), color: v.color, plate: v.plate } : null,
          // Réseau partagé : exploitant d'un chauffeur partenaire (clé absente pour un chauffeur de l'organisation)
          ...(one(d.operator) ? { operator: { name: one(d.operator).name ?? null } } : {}),
        }
      : null,
    timestamps: {
      created_at: r.created_at,
      accepted_at: r.accepted_at ?? null,
      driver_arrived_at: r.driver_arrived_at ?? null,
      started_at: r.started_at ?? null,
      completed_at: r.completed_at ?? null,
      cancelled_at: r.cancelled_at ?? null,
    },
    links: { self: `${appUrl}/api/v1/rides/${r.id}` },
  };
}
