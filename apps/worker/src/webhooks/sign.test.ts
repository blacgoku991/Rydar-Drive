import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildWebhookBody, buildWebhookEvent, signWebhook, WEBHOOK_API_VERSION, webhookHeaders, type ClaimedWebhook } from "./sign";

const SECRET = "whsec_0123456789abcdef0123456789abcdef0123456789abcdef";
const APP = "https://rydar.example";

const ping: ClaimedWebhook = {
  id: "5b1e0c4a-0000-4000-8000-000000000001",
  organization_id: "org-1",
  endpoint_id: "ep-1",
  url: "https://hooks.example.com/rydar",
  secret: SECRET,
  event_type: "ping",
  event_status: null,
  previous_status: null,
  occurred_at: new Date("2026-10-02T10:13:20.000Z"),
  attempts: 0,
  ride: null,
};

/** Ligne construite en SQL par private.claim_webhook_deliveries (mêmes noms que PUBLIC_RIDE_SELECT + updated_at). */
const rideRow = {
  id: "8d0c0000-0000-4000-8000-000000000001",
  number: 1042,
  type: "scheduled",
  status: "DRIVER_EN_ROUTE",
  pickup_address: "Gare de Lyon, Paris",
  pickup_lat: 48.8443,
  pickup_lng: 2.3744,
  dropoff_address: "Aéroport CDG T2",
  dropoff_lat: 49.0097,
  dropoff_lng: 2.5479,
  pickup_at: "2026-10-03T08:30:00+00:00",
  passengers: 2,
  luggage: 1,
  vehicle_category: "berline",
  price_cents: 8900,
  currency: "EUR",
  payment_method: "card_onboard",
  flight_number: null,
  external_reference: "RP-AB12C",
  estimated_distance_m: 32100,
  estimated_duration_s: 2700,
  route_polyline: null,
  created_at: "2026-10-02T10:00:00+00:00",
  accepted_at: "2026-10-02T10:01:00+00:00",
  driver_arrived_at: null,
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  updated_at: "2026-10-02T10:05:00.123456+00:00",
  driver: { first_name: "Karim", vehicle: { brand: "Peugeot", model: "508", color: "Noir", plate: "AB-123-CD" } },
};

const accepted: ClaimedWebhook = {
  ...ping,
  id: "5b1e0c4a-0000-4000-8000-000000000002",
  event_type: "ride.accepted",
  event_status: "ACCEPTED",
  previous_status: "OFFERED",
  occurred_at: "2026-10-02T10:01:00.5+00:00",
  attempts: 2,
  ride: rideRow,
};

describe("webhooks — corps de l'événement", () => {
  it("ping : { id, type, created_at, api_version, data: {} }, JSON compact", () => {
    expect(buildWebhookBody(ping, APP)).toBe(
      '{"id":"5b1e0c4a-0000-4000-8000-000000000001","type":"ping","created_at":"2026-10-02T10:13:20.000Z","api_version":"2026-10-01","data":{}}',
    );
    expect(WEBHOOK_API_VERSION).toBe("2026-10-01");
  });

  it("événement de course : data.ride = publicRide (état à l'envoi) + updated_at, transition dans data.status / previous_status", () => {
    const event = buildWebhookEvent(accepted, APP);
    expect(Object.keys(event)).toEqual(["id", "type", "created_at", "api_version", "data"]);
    expect(event).toMatchObject({
      id: accepted.id,
      type: "ride.accepted",
      created_at: "2026-10-02T10:01:00.500Z",
      api_version: "2026-10-01",
      data: { status: "ACCEPTED", previous_status: "OFFERED" },
    });
    const data = event.data as { ride: Record<string, any> };
    // Course dans son état ACTUEL (déjà en route), pas celui de l'événement
    expect(data.ride.status).toBe("DRIVER_EN_ROUTE");
    expect(data.ride).toMatchObject({
      id: rideRow.id,
      number: 1042,
      external_reference: "RP-AB12C",
      pickup: { address: "Gare de Lyon, Paris", lat: 48.8443, lng: 2.3744 },
      route: { distance_m: 32100, duration_s: 2700, polyline: null },
      driver: { first_name: "Karim", vehicle: { model: "Peugeot 508", color: "Noir", plate: "AB-123-CD" } },
      links: { self: `${APP}/api/v1/rides/${rideRow.id}` },
      updated_at: "2026-10-02T10:05:00.123456+00:00",
    });
    expect(Object.keys(data.ride).at(-1)).toBe("updated_at");
    expect(JSON.parse(buildWebhookBody(accepted, APP))).toEqual(JSON.parse(JSON.stringify(event)));
  });

  it("course supprimée depuis : data.ride null, la transition reste ; updated_at absent → null", () => {
    expect(buildWebhookEvent({ ...accepted, ride: null }, APP).data).toEqual({ ride: null, status: "ACCEPTED", previous_status: "OFFERED" });
    const created = buildWebhookEvent({ ...accepted, event_type: "ride.created", previous_status: null, ride: { ...rideRow, updated_at: undefined } }, APP);
    expect((created.data as any).previous_status).toBeNull();
    expect((created.data as any).ride.updated_at).toBeNull();
  });

  it("aucun secret, aucun champ interne dans le corps", () => {
    const body = buildWebhookBody({ ...accepted, ride: { ...rideRow, customer_phone: "+33600000000", driver_id: "d1" } }, APP);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("customer_phone");
    expect(body).not.toContain("driver_id");
    expect(body).not.toContain("org-1");
  });
});

describe("webhooks — signature", () => {
  it("vecteur connu : v1=HMAC-SHA256(secret, « horodatage.corps »), hexadécimal minuscule", () => {
    const body = buildWebhookBody(ping, APP);
    expect(signWebhook(SECRET, 1759400000, body)).toBe("v1=21d667de120d641624ff81315d7beeff791feb8cbd24a8e65ae1a184469a863a");
    expect(signWebhook(SECRET, "1759400000", body)).toBe(signWebhook(SECRET, 1759400000, body));
    // Un octet de plus dans le corps ou un autre horodatage : signature différente
    expect(signWebhook(SECRET, 1759400001, body)).not.toBe(signWebhook(SECRET, 1759400000, body));
    expect(signWebhook(SECRET, 1759400000, `${body} `)).not.toBe(signWebhook(SECRET, 1759400000, body));
  });

  it("caractères non ASCII signés en UTF-8 (corps tel qu'envoyé)", () => {
    const body = buildWebhookBody(accepted, APP);
    expect(body).toContain("Aéroport");
    const expected = createHmac("sha256", SECRET).update(Buffer.from(`1759400000.${body}`, "utf8")).digest("hex");
    expect(signWebhook(SECRET, 1759400000, body)).toBe(`v1=${expected}`);
  });

  it("en-têtes : horodatage de CET essai (secondes), signature vérifiable par le destinataire", () => {
    const body = buildWebhookBody(accepted, APP);
    const h = webhookHeaders(accepted, body, 1759400000_999);
    expect(h).toEqual({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(body)),
      "User-Agent": "RydarDrive-Webhooks/1.0",
      "X-Rydar-Event": "ride.accepted",
      "X-Rydar-Delivery": accepted.id,
      "X-Rydar-Timestamp": "1759400000",
      "X-Rydar-Signature": expect.stringMatching(/^v1=[0-9a-f]{64}$/),
    });
    // Vérification côté destinataire (comme docs/API.md) : temps constant
    const mac = createHmac("sha256", SECRET).update(`${h["X-Rydar-Timestamp"]}.${body}`).digest();
    expect(timingSafeEqual(mac, Buffer.from(h["X-Rydar-Signature"]!.slice(3), "hex"))).toBe(true);
    expect(JSON.stringify(h)).not.toContain(SECRET);
  });
});
