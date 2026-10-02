import type { OrgSettlementItem } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import { carrySelection, compactOpen, lateNow, openRank, sortOpen } from "./settlement-list";

const NOW = Date.parse("2026-10-02T12:00:00Z");

function item(id: string, extra: Partial<OrgSettlementItem>): OrgSettlementItem {
  return {
    id, ride_id: `ride-${id}`, driver_id: "d1", driver_label: "Karim Test (#12)", direction: "driver_owes", amount_cents: 1200, price_cents: 5000,
    commission_cents: 1000, platform_fee_cents: 200, driver_payout_cents: 3800, currency: "EUR", payment_method: "cash", reference: `C${id}`,
    status: "due", overdue: false, blocking: false, due_at: "2026-10-03T12:00:00Z", declared_at: null, declared_method: null, declared_note: null,
    settled_at: null, settled_method: null, note: null, reminders_sent: 0, last_reminded_at: null, created_at: "2026-10-01T12:00:00Z",
    updated_at: "2026-10-01T12:00:00Z",
    ride: { number: Number(id), pickup: "A", dropoff: "B", completed_at: null, customer_name: "Client" },
    driver: null,
    ...extra,
  } as OrgSettlementItem;
}

describe("liste « À traiter »", () => {
  it("rang : déclaré, contesté, en retard, à encaisser, à verser", () => {
    const declared = item("1", { status: "declared" });
    const disputed = item("2", { status: "disputed" });
    const late = item("3", { due_at: "2026-10-02T11:00:00Z" });
    const due = item("4", {});
    const toPay = item("5", { direction: "centrale_owes" });
    expect([declared, disputed, late, due, toPay].map((s) => openRank(s, NOW))).toEqual([0, 1, 2, 3, 4]);
    expect(lateNow(late, NOW)).toBe(true);
    expect(lateNow(due, NOW)).toBe(false);
    expect(lateNow(item("6", { direction: "centrale_owes", due_at: "2026-10-01T00:00:00Z" }), NOW)).toBe(false);
  });

  it("tri : rang puis plus récent d'abord ; la page affichée garde les plus urgents", () => {
    const list = [
      item("1", { created_at: "2026-10-01T10:00:00Z" }),
      item("2", { status: "declared", created_at: "2026-09-20T10:00:00Z" }),
      item("3", { created_at: "2026-10-01T11:00:00Z" }),
    ];
    expect(sortOpen(list, NOW).map((s) => s.id)).toEqual(["2", "3", "1"]);
    expect(sortOpen(list, NOW).slice(0, 1).map((s) => s.id)).toEqual(["2"]);
  });

  it("version compacte : numéro de course, sinon celui de la référence", () => {
    const s = compactOpen(item("1783", {}));
    expect(s).toEqual({ id: "1783", driver_id: "d1", direction: "driver_owes", status: "due", due_at: "2026-10-03T12:00:00Z", amount_cents: 1200, reference: "C1783", ride_number: 1783 });
    expect(compactOpen(item("9", { ride: undefined as never, reference: "C42" })).ride_number).toBe(42);
    expect(compactOpen(item("9", { ride: undefined as never, reference: "X" })).ride_number).toBeNull();
  });

  it("sélection relue : ligne sortie de la page gardée si toujours ouverte et inchangée, retirée sinon", () => {
    const a = item("1", {});
    const b = item("2", { status: "declared" });
    const c = item("3", {});
    const d = item("4", {});
    const selected = new Map([a, b, c, d].map((s) => [s.id, s]));
    const freshA = item("1", { status: "paid" });
    const index = new Map(
      [
        compactOpen(b),
        compactOpen(item("3", { status: "disputed" })),
        compactOpen(item("4", { due_at: "2026-10-04T12:00:00Z" })),
      ].map((s) => [s.id, s]),
    );
    const next = carrySelection(selected, [freshA], index);
    // 1 affichée mais réglée : retirée ; 2 hors page, inchangée : gardée telle quelle ; 3 statut changé : retirée ;
    // 4 hors page, échéance déplacée : gardée avec la nouvelle échéance
    expect([...next.keys()]).toEqual(["2", "4"]);
    expect(next.get("2")).toBe(b);
    expect(next.get("4")?.due_at).toBe("2026-10-04T12:00:00Z");
  });

  it("sélection relue : même Map si rien ne change, version fraîche d'une ligne affichée", () => {
    const a = item("1", {});
    const selected = new Map([[a.id, a]]);
    expect(carrySelection(selected, [a], new Map())).toBe(selected);
    const fresh = item("1", { reminders_sent: 2 });
    expect(carrySelection(selected, [fresh], new Map()).get("1")).toBe(fresh);
    const empty = new Map<string, ReturnType<typeof item>>();
    expect(carrySelection(empty, [a], new Map())).toBe(empty);
  });
});
