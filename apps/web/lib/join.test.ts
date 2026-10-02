import { beforeEach, describe, expect, it, vi } from "vitest";

// Lien d'inscription des chauffeurs (20260924006300), flotte comme centrale : vraie route GET /api/join/{code} et vraie
// logique applyWithJoinLink (lib/join.ts), Supabase service role simulé. Modèle renvoyé à l'application (absent →
// centrale), textes d'erreur selon le modèle (flotte : jamais « la centrale »), textes communs neutres.

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  rpc: {} as Record<string, { data: unknown; error: unknown }>,
  calls: [] as { fn: string; args: Row }[],
  deletedUsers: [] as string[],
  audits: [] as Row[],
  limitOk: true,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/request", () => ({ clientIp: async () => "203.0.113.7" }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: h.limitOk, remaining: 1, resetAt: 0, limit: 1 }),
  rateLimitAll: async () => ({ ok: h.limitOk, remaining: 1, resetAt: 0, limit: 1 }),
}));
vi.mock("@/lib/audit", () => ({ audit: async (entry: Row) => void h.audits.push(entry) }));
vi.mock("@/lib/legal", () => ({ LEGAL_VERSION: "test" }));
vi.mock("@/lib/driver-app-cors", async () => await import("./driver-app-cors"));
vi.mock("@/components/network/join-copy", async () => await import("../components/network/join-copy"));
vi.mock("@/lib/join", async () => await import("./join"));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    async rpc(fn: string, args: Row) {
      h.calls.push({ fn, args });
      return h.rpc[fn] ?? { data: null, error: { message: `rpc ${fn} non simulée` } };
    },
    from: () => ({ insert: () => Promise.resolve({ error: null }) }),
    auth: {
      admin: {
        createUser: async () => ({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } }, error: null }),
        deleteUser: async (id: string) => {
          h.deletedUsers.push(id);
          return { error: null };
        },
      },
    },
  }),
}));

const { GET } = await import("../app/api/join/[code]/route");
const { applyWithJoinLink } = await import("./join");
const { JOIN_ALREADY_REGISTERED, JOIN_LINK_INACTIVE } = await import("../components/network/join-copy");

const CODE = "0123456789abcdef";
const ORG = { id: "22222222-2222-4222-8222-222222222222", name: "Taxi Sud", logo_url: null, brand_color: null, city: "Nice", phone: null, email: null };

function joinInfo(model?: "fleet" | "centrale") {
  return { data: { ok: true, organization: ORG, auto_approve: false, ...(model ? { dispatch_model: model } : {}) }, error: null };
}

const getCard = async () => {
  const res = await GET(new Request(`https://app.rydar.test/api/join/${CODE}`), { params: Promise.resolve({ code: CODE }) });
  return { status: res.status, body: (await res.json()) as Row };
};

const VALID = {
  firstName: "Samir",
  lastName: "Candidat",
  phone: "06 12 34 56 78",
  email: "samir@test.dev",
  password: "motdepasse-solide",
  vehicle: { model: "Corolla", plate: "AB-123-CD", category: "standard", seats: 4 },
  acceptTerms: true,
} as const;

beforeEach(() => {
  h.rpc = {};
  h.calls = [];
  h.deletedUsers = [];
  h.audits = [];
  h.limitOk = true;
});

describe("GET /api/join/{code} : carte de l'organisation pour l'application", () => {
  it("renvoie le modèle : flotte, centrale, et centrale pour une réponse sans modèle (base d'avant 006300)", async () => {
    h.rpc.svc_join_info = joinInfo("fleet");
    expect(await getCard()).toEqual({
      status: 200,
      body: { ok: true, autoApprove: false, model: "fleet", organization: { name: "Taxi Sud", logoUrl: null, brandColor: null, city: "Nice", phone: null } },
    });
    h.rpc.svc_join_info = joinInfo("centrale");
    expect((await getCard()).body.model).toBe("centrale");
    h.rpc.svc_join_info = joinInfo();
    expect((await getCard()).body.model).toBe("centrale");
    expect(h.calls.at(-1)).toEqual({ fn: "svc_join_info", args: { p_code: CODE } });
  });

  it("lien inactif : 404 avec un texte valable pour une flotte comme pour une centrale ; trop de tentatives : 429", async () => {
    h.rpc.svc_join_info = { data: { ok: false, code: "JOIN_LINK_INVALID" }, error: null };
    expect(await getCard()).toEqual({ status: 404, body: { ok: false, error: JOIN_LINK_INACTIVE } });
    expect(JOIN_LINK_INACTIVE).toMatch(/centrale ou à la flotte/);
    h.limitOk = false;
    expect((await getCard()).status).toBe(429);
  });
});

describe("applyWithJoinLink : erreurs selon le modèle de l'organisation", () => {
  const identity = (r: Row) => ({ data: { banned: false, duplicate: null, ...r }, error: null });

  it("flotte : identité bannie → refus neutre au nom de la flotte, sans compte créé", async () => {
    h.rpc.svc_join_info = joinInfo("fleet");
    h.rpc.svc_identity_check = identity({ banned: true });
    expect(await applyWithJoinLink(CODE, VALID)).toEqual({ ok: false, error: "Inscription impossible. Contactez Taxi Sud." });
    expect(h.calls.map((c) => c.fn)).toEqual(["svc_join_info", "svc_identity_check"]);
    expect(h.audits[0]).toMatchObject({ action: "driver.join_refused", metadata: { reason: "identity_banned" } });
  });

  it("flotte : doublons « dans cette flotte » (contrôle préalable et refus de svc_driver_apply)", async () => {
    h.rpc.svc_join_info = joinInfo("fleet");
    h.rpc.svc_identity_check = identity({ duplicate: "phone" });
    const phone = await applyWithJoinLink(CODE, VALID);
    expect(phone).toEqual({
      ok: false,
      error: "Ce numéro est déjà inscrit dans cette flotte : connectez-vous à l'application avec votre compte.",
      fieldErrors: { phone: "Ce numéro est déjà inscrit dans cette flotte : connectez-vous à l'application avec votre compte." },
    });

    h.rpc.svc_identity_check = identity({});
    h.rpc.svc_driver_apply = { data: { ok: false, code: "PLATE_TAKEN" }, error: null };
    expect(await applyWithJoinLink(CODE, VALID)).toEqual({
      ok: false,
      error: "Cette plaque est déjà enregistrée dans cette flotte.",
      fieldErrors: { "vehicle.plate": "Cette plaque est déjà enregistrée dans cette flotte." },
    });
    // Compensation : pas de compte Auth orphelin
    expect(h.deletedUsers).toEqual(["11111111-1111-4111-8111-111111111111"]);

    h.rpc.svc_driver_apply = { data: { ok: false, code: "IDENTITY_BANNED" }, error: null };
    expect(await applyWithJoinLink(CODE, VALID)).toEqual({ ok: false, error: "Inscription impossible. Contactez Taxi Sud." });
    h.rpc.svc_driver_apply = { data: { ok: false, code: "ALREADY_REGISTERED" }, error: null };
    expect(await applyWithJoinLink(CODE, VALID)).toEqual({ ok: false, error: JOIN_ALREADY_REGISTERED });
  });

  it("centrale (ou réponse sans modèle) : textes historiques inchangés", async () => {
    for (const info of [joinInfo("centrale"), joinInfo()]) {
      h.rpc.svc_join_info = info;
      h.rpc.svc_identity_check = identity({ banned: true });
      expect(await applyWithJoinLink(CODE, VALID)).toEqual({ ok: false, error: "Inscription impossible. Contactez la centrale." });
      h.rpc.svc_identity_check = identity({ duplicate: "email" });
      expect(await applyWithJoinLink(CODE, VALID)).toMatchObject({ error: "Cette adresse e-mail est déjà inscrite dans cette centrale." });
    }
  });

  it("avant de connaître l'organisation : lien invalide et trop de tentatives sans mention « la centrale »", async () => {
    expect(await applyWithJoinLink("x", VALID)).toEqual({ ok: false, error: JOIN_LINK_INACTIVE });
    h.rpc.svc_join_info = { data: { ok: false, code: "JOIN_LINK_INVALID" }, error: null };
    expect(await applyWithJoinLink(CODE, VALID)).toEqual({ ok: false, error: JOIN_LINK_INACTIVE });
    h.limitOk = false;
    const limited = await applyWithJoinLink(CODE, VALID);
    expect(limited).toEqual({ ok: false, error: "Trop de tentatives. Réessayez dans quelques minutes." });
  });

  it("inscription acceptée dans une flotte : statut et nom renvoyés au candidat", async () => {
    h.rpc.svc_join_info = joinInfo("fleet");
    h.rpc.svc_identity_check = identity({});
    h.rpc.svc_driver_apply = { data: { ok: true, code: "APPROVED", driver_id: "d1", number: 12, organization: { name: "Taxi Sud" } }, error: null };
    expect(await applyWithJoinLink(CODE, VALID)).toEqual({ ok: true, status: "APPROVED", organizationName: "Taxi Sud", email: "samir@test.dev" });
    expect(h.calls.find((c) => c.fn === "svc_driver_apply")?.args).toMatchObject({ p_org: ORG.id, p_first_name: "Samir" });
  });
});
