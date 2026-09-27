import { describe, expect, it } from "vitest";
import { deliverWhatsApp, type ClaimedWhatsApp } from "./whatsapp";

const claimed = (over: Partial<ClaimedWhatsApp> = {}): ClaimedWhatsApp => ({
  id: "n1",
  organization_id: "o1",
  driver_id: "d1",
  type: "settlement_reminder",
  data: { sender: "org", to: "33612345678", params: ["Karim", "19 €", "NovaLink", "2 courses"] },
  attempts: 1,
  sender: "org",
  phone_number_id: "123456789012345",
  access_token: "EAAG-test-token-xxxxxxxxxxxx",
  template: "rappel_commission",
  language: "fr",
  ...over,
});

function recorder() {
  const calls: unknown[][] = [];
  return { calls, query: async (_sql: string, params?: unknown[]) => (calls.push(params ?? []), { rows: [] }) };
}

describe("worker — relances WhatsApp", () => {
  it("envoie le modèle avec les variables et termine en succès", async () => {
    const q = recorder();
    const sent: unknown[] = [];
    const res = await deliverWhatsApp(claimed(), {
      query: q.query,
      send: async (input) => (sent.push(input), { ok: true, messageId: "wamid.1" }),
    });
    expect(res.ok).toBe(true);
    expect(sent[0]).toMatchObject({ to: "33612345678", template: "rappel_commission", language: "fr", params: ["Karim", "19 €", "NovaLink", "2 courses"] });
    expect(q.calls[0]).toEqual(["n1", true, null, "wamid.1", false]);
  });

  it("erreur temporaire de Meta : reprise demandée", async () => {
    const q = recorder();
    await deliverWhatsApp(claimed(), {
      query: q.query,
      send: async () => ({ ok: false, status: 429, code: 130429, retryable: true, error: "Limite de débit atteinte (code 130429)" }),
    });
    expect(q.calls[0]).toEqual(["n1", false, "Limite de débit atteinte (code 130429)", null, true]);
  });

  it("expéditeur déconnecté : échec définitif sans appel à Meta (repli push côté SQL)", async () => {
    const q = recorder();
    let called = false;
    await deliverWhatsApp(claimed({ access_token: null }), { query: q.query, send: async () => ((called = true), { ok: true, messageId: null }) });
    expect(called).toBe(false);
    expect(q.calls[0]?.[1]).toBe(false);
    expect(q.calls[0]?.[4]).toBe(false);
  });

  it("mode essai (PUSH_DRY_RUN) : rien n'est envoyé", async () => {
    const q = recorder();
    let called = false;
    await deliverWhatsApp(claimed(), { query: q.query, dryRun: true, send: async () => ((called = true), { ok: true, messageId: null }) });
    expect(called).toBe(false);
    expect(q.calls[0]).toEqual(["n1", true, null, "dry-run", false]);
  });
});
