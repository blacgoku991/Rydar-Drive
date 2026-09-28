import { describe, expect, it } from "vitest";
import { type SettlementRow, withFlags } from "./settlement-flags";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const PAST = "2026-09-27T11:00:00Z";
const FUTURE = "2026-09-27T13:00:00Z";

function row(over: Partial<SettlementRow>): SettlementRow {
  return {
    id: "s1", ride_id: "r1", driver_id: "d1", driver_label: "Jean Dupont", direction: "driver_owes", amount_cents: 1900,
    price_cents: 5000, commission_cents: 1500, platform_fee_cents: 400, driver_payout_cents: 3100, currency: "EUR",
    payment_method: "cash", reference: "C1", status: "due", due_at: FUTURE, declared_at: null, declared_method: null,
    declared_note: null, disputed_at: null, settled_at: null, settled_method: null, note: null, reminders_sent: 0,
    last_reminded_at: null, created_at: PAST, updated_at: PAST,
    ...over,
  };
}

// Même règle que private.settlement_json / private.centrale_blocker « unpaid » (20260924004400)
describe("withFlags", () => {
  it("à régler, échéance à venir : ni en retard ni bloquant", () => {
    expect(withFlags(row({}), NOW)).toMatchObject({ overdue: false, blocking: false });
  });
  it("à régler, échéance passée : en retard et bloquant", () => {
    expect(withFlags(row({ due_at: PAST }), NOW)).toMatchObject({ overdue: true, blocking: true });
  });
  it("contesté : bloquant", () => {
    expect(withFlags(row({ status: "disputed", disputed_at: PAST }), NOW)).toMatchObject({ overdue: false, blocking: true });
  });
  it("redéclaré après un « Pas reçu » : reste bloquant", () => {
    expect(withFlags(row({ status: "declared", declared_at: PAST, disputed_at: PAST }), NOW).blocking).toBe(true);
    expect(withFlags(row({ status: "declared", declared_at: PAST }), NOW).blocking).toBe(false);
  });
  it("montant nul : jamais bloquant", () => {
    expect(withFlags(row({ amount_cents: 0, due_at: PAST }), NOW)).toMatchObject({ overdue: true, blocking: false });
    expect(withFlags(row({ amount_cents: 0, status: "disputed" }), NOW).blocking).toBe(false);
  });
  it("part due par la centrale : jamais bloquant", () => {
    expect(withFlags(row({ direction: "centrale_owes", status: "disputed", due_at: PAST }), NOW)).toMatchObject({ overdue: false, blocking: false });
  });
});
