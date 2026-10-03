// Données simulées des RPC du réseau partagé (tests unitaires seulement ; formes du contrat packages/shared/src/network.ts).
import {
  networkTerms,
  type NetworkGivenItem, type NetworkReceivedItem, type NetworkTermsGiverInput, type OrgNetworkReadiness, type OrgNetworkRide, type PaymentMethod,
  type Settlement, type SettlementNetworkInfo, type SettlementStatus,
} from "@rydar/shared";

export const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const RIDE = "11111111-1111-4111-8111-111111111111";
export const EXEC = "22222222-2222-4222-8222-222222222222";
export const DRIVER = "33333333-3333-4333-8333-333333333333";
export const SETTLEMENT = "44444444-4444-4444-8444-444444444444";

export const CENTRALE_15_10: NetworkTermsGiverInput = {
  dispatch_model: "centrale",
  platform_fee_percent: 10,
  platform_fee_fixed_cents: 0,
  driver_commission_percent: 15,
  driver_commission_fixed_cents: 0,
};
export const FLEET_10: NetworkTermsGiverInput = { dispatch_model: "fleet", platform_fee_percent: 10, platform_fee_fixed_cents: 0 };

export function readiness(over: Partial<OrgNetworkReadiness> = {}): OrgNetworkReadiness {
  return {
    enabled: true,
    share_out: { active: false, missing: ["not_sharing"], warnings: [] },
    share_in: { active: false, missing: ["not_receiving"], warnings: [] },
    terms: { version: "2026-11-01", min_version: null, grace_until: null, accepted_version: null, accepted_at: null },
    approval: { status: "none", requested_at: null, approved_at: null, refused_reason: null },
    suspended_reason: null,
    ...over,
  };
}

type GivenOpts = {
  payment?: PaymentMethod;
  price?: number;
  giver?: NetworkTermsGiverInput;
  status?: NetworkGivenItem["ride"]["status"];
  settlement?: SettlementStatus | null;
  overdue?: boolean;
  onHold?: boolean;
  suspect?: NetworkGivenItem["execution"]["suspect_reasons"];
  validatedAt?: string | null;
  contested?: boolean;
  endedAt?: string | null;
  endReason?: NetworkGivenItem["execution"]["end_reason"];
  driverExcluded?: boolean;
  number?: number;
};

/** Course confiée (A) au chauffeur « Karim B. » de « Flotte B », termes calculés comme en base. */
export function givenItem(o: GivenOpts = {}): NetworkGivenItem {
  const r = networkTerms({ price_cents: o.price ?? 5000, payment_method: o.payment ?? "cash" }, o.giver ?? CENTRALE_15_10);
  if (!r.ok) throw new Error("fixture : course non partageable");
  const t = r.terms;
  const status = o.status ?? "COMPLETED";
  const endedAt = o.endedAt === undefined ? (status === "COMPLETED" ? "2026-09-20T10:00:00.000Z" : null) : o.endedAt;
  const number = o.number ?? 1783;
  const network: SettlementNetworkInfo = {
    execution_id: EXEC,
    counterparty: "driver",
    partner_name: "Flotte B",
    driver_label: "Karim B.",
    on_hold: !!o.onHold,
    hold_until: o.onHold ? "2026-09-23T10:00:00.000Z" : null,
    suspect_reasons: o.suspect ?? [],
    contested: !!o.contested,
    driver_disputed: false,
    driver_dispute_reason: null,
  };
  const settlementStatus = o.settlement === undefined ? (status === "COMPLETED" ? "due" : null) : o.settlement;
  const settlement: (Settlement & { network: SettlementNetworkInfo }) | null = settlementStatus
    ? {
        id: SETTLEMENT,
        ride_id: RIDE,
        driver_id: null,
        driver_label: "Karim B. · Flotte B",
        direction: t.direction,
        amount_cents: t.amount_cents,
        price_cents: t.price_cents,
        commission_cents: t.commission_cents,
        platform_fee_cents: t.platform_fee_cents,
        driver_payout_cents: t.driver_payout_cents,
        currency: "EUR",
        payment_method: t.payment_method,
        reference: `R${number}`,
        status: settlementStatus,
        overdue: !!o.overdue,
        blocking: false,
        due_at: "2026-09-22T10:00:00.000Z",
        declared_at: settlementStatus === "declared" ? "2026-09-21T10:00:00.000Z" : null,
        declared_method: settlementStatus === "declared" ? "transfer" : null,
        declared_note: null,
        settled_at: settlementStatus === "paid" ? "2026-09-21T12:00:00.000Z" : null,
        settled_method: settlementStatus === "paid" ? "transfer" : null,
        note: null,
        reminders_sent: 0,
        last_reminded_at: null,
        created_at: "2026-09-20T10:00:00.000Z",
        updated_at: "2026-09-20T10:00:00.000Z",
        network,
      }
    : null;
  return {
    ride: {
      id: RIDE,
      number,
      type: "instant",
      status,
      pickup_at: "2026-09-20T09:30:00.000Z",
      completed_at: status === "COMPLETED" ? endedAt : null,
      pickup_address: "12 rue de la Roquette, 75011 Paris",
      dropoff_address: "Aéroport d'Orly, 94390 Orly",
      customer_name: "Client A",
      currency: "EUR",
    },
    execution: {
      id: EXEC,
      accepted_at: "2026-09-20T09:00:00.000Z",
      ended_at: endedAt,
      end_reason: o.endReason === undefined ? (status === "COMPLETED" ? "completed" : null) : o.endReason,
      driver_label: "Karim B.",
      partner: { id: ORG_B, name: "Flotte B" },
      vehicle: { brand: "Peugeot", model: "508", color: "Noir", plate: "AB-123-CD", category: "standard", seats: 4 },
      terms: t,
      counterparty: "driver",
      suspect_reasons: o.suspect ?? [],
      on_hold: !!o.onHold,
      hold_until: o.onHold ? "2026-09-23T10:00:00.000Z" : null,
      contested_at: o.contested ? "2026-09-21T10:00:00.000Z" : null,
      contested_reason: o.contested ? "Course non effectuée" : null,
      driver_disputed_at: null,
      driver_dispute_reason: null,
      ...(o.validatedAt !== undefined ? { validated_at: o.validatedAt } : {}),
      ...(o.driverExcluded !== undefined ? { driver_excluded: o.driverExcluded } : {}),
    },
    settlement,
  };
}

/** La même course vue par l'organisation du chauffeur (B) : communes seulement, jamais le client. */
export function receivedFromGiven(g: NetworkGivenItem, giverName = "Taxi A"): NetworkReceivedItem {
  const t = g.execution.terms;
  return {
    execution_id: g.execution.id,
    reference: g.settlement?.reference ?? `R${g.ride.number}`,
    accepted_at: g.execution.accepted_at,
    ended_at: g.execution.ended_at,
    end_reason: g.execution.end_reason,
    ride: { type: g.ride.type, status: g.ride.status, pickup_at: g.ride.pickup_at, completed_at: g.ride.completed_at, pickup_area: "75011 Paris", dropoff_area: "Orly" },
    driver: { id: DRIVER, number: 12, first_name: "Karim", last_name: "Benali" },
    vehicle: g.execution.vehicle,
    giver: { id: ORG_A, name: giverName, phone: "+33612345678" },
    money: {
      price_cents: t.price_cents,
      currency: "EUR",
      payment_method: t.payment_method,
      driver_part_cents: t.driver_payout_cents,
      direction: t.direction,
      amount_cents: t.amount_cents,
    },
    settlement: g.settlement
      ? { status: g.settlement.status, overdue: g.settlement.overdue, due_at: g.settlement.due_at, on_hold: g.execution.on_hold, driver_disputed: false }
      : null,
    to_check: g.execution.suspect_reasons.length > 0,
    contested: !!g.execution.contested_at,
  };
}

/** Bloc « Réseau partagé » de la fiche course (org_network_ride) de la course confiée `g`. */
export function orgNetworkRide(
  g: NetworkGivenItem = givenItem(),
  over: Partial<Omit<OrgNetworkRide, "execution">> & { execution?: Partial<NonNullable<OrgNetworkRide["execution"]>> | null } = {},
): OrgNetworkRide {
  const { execution: execOver, ...rest } = over;
  const execution: OrgNetworkRide["execution"] =
    execOver === null
      ? null
      : {
          ...g.execution,
          checks: {
            vtc_card_number: "VTC-075-123456",
            vtc_card_expires_on: "2027-03-31",
            insurance_expires_on: "2026-12-31",
            vehicle_registration_expires_on: null,
            driving_license_expires_on: "2030-01-01",
            verified_at: "2026-09-01T08:00:00.000Z",
          },
          driver_phone: "+33612345678",
          driver_phone_until: "2026-09-22T10:00:00.000Z",
          client_data: { reads: 0, first_read_at: null, last_read_at: null },
          ...execOver,
        };
  return {
    ride_id: g.ride.id,
    share: {
      status: g.ride.status === "COMPLETED" ? "completed" : "accepted",
      cycle: 1,
      stage: "instant",
      opened_at: "2026-09-20T08:55:00.000Z",
      partners_offered: 3,
      closed_at: null,
      closed_reason: null,
    },
    execution,
    operator: {
      organization_id: ORG_B,
      name: "Flotte B",
      legal_name: "Flotte B SAS",
      siret: "12345678900012",
      vtc_registration: "EVTC075190001",
      phone: "+33144556677",
      email: "contact@flotte-b.fr",
      dispatch_model: "fleet",
      driver_operator_registration: null,
    },
    previous: [],
    settlement: g.settlement,
    can: { remove: false, close: false, validate: false, contest: true, exclude_driver: true, exclude_partner: true },
    ...rest,
  };
}
