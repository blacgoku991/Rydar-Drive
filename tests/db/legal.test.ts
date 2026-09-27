import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  as, createAuthUser, createDriver, createMember, createOrg, expectPgError, insertRideBypass, pool, sql, type Org,
} from "./helpers";

afterAll(async () => {
  await pool.end();
});

// -----------------------------------------------------------------------------
// Outils
// -----------------------------------------------------------------------------
async function superAdmin() {
  const id = await createAuthUser(`sa-${randomUUID().slice(0, 8)}@rydar.dev`, "Super Admin");
  await sql("update public.users set is_super_admin = true where id = $1", [id]);
  return id;
}

/** Appel en service role (routes serveur du super admin). */
const svc = async (fn: string, args: unknown[] = []) => {
  const params = args.map((_, i) => `$${i + 1}`).join(", ");
  const [row] = await as({ role: "service_role" }, (q) => q(`select public.${fn}(${params}) as r`, args));
  return row.r as Record<string, any>;
};

/** Acceptation par l'utilisateur connecté `sub`. */
const accept = async (sub: string, documents: unknown, version: unknown = "2026-09-27", org: string | null = null, source = "web") => {
  const [row] = await as({ sub }, (q) =>
    q("select public.accept_legal_documents($1::text[], $2::text, $3::uuid, $4::text) as r", [documents, version, org, source]),
  );
  return row.r as Record<string, any>;
};

const acceptances = (sub: string) =>
  as({ sub }, (q) => q<{ user_id: string; organization_id: string | null; document: string }>(
    "select user_id, organization_id, document from public.legal_acceptances",
  ));

/** Ménage périodique du worker (durées de conservation). */
const housekeeping = async () => (await sql("select private.housekeeping() as r"))[0].r as Record<string, any>;

const emailOf = async (userId: string) => (await sql("select email from public.users where id = $1", [userId]))[0].email as string;

/** Champs publics renvoyés par public_legal_info() (pages légales, sans connexion). */
const PUBLIC_KEYS = [
  "address", "company_name", "data_host", "email", "host_address", "host_name", "host_phone", "legal_form", "phone",
  "privacy_email", "publication_director", "registration", "share_capital", "updated_at", "vat_number",
];

const FULL_INFO = {
  company_name: "  Rydar   SAS ",
  legal_form: "SAS",
  share_capital: "1 000 €",
  address: "12 rue de la Paix, 75002 Paris",
  registration: "RCS Paris 912 345 678",
  vat_number: "FR12912345678",
  publication_director: "Camille Martin",
  email: "Contact@Rydar.Example",
  phone: "01 23 45 67 89",
  privacy_email: "",
  host_name: "Hetzner Online GmbH",
  host_address: "Industriestr. 25, 91710 Gunzenhausen, Allemagne",
  host_phone: "+49 9831 505-0",
  data_host: "Supabase (Union européenne)",
};

// -----------------------------------------------------------------------------
// Identité légale de l'éditeur
// -----------------------------------------------------------------------------
describe("Identité légale de l'éditeur (platform_legal)", () => {
  it("public_legal_info est lisible sans connexion et ne renvoie que les champs publics", async () => {
    const [anon] = await as({ role: "anon" }, (q) => q("select public.public_legal_info() as r"));
    expect(Object.keys(anon.r).sort()).toEqual(PUBLIC_KEYS);
    const user = await createAuthUser(`lecteur-${randomUUID().slice(0, 8)}@test.dev`, "Lecteur");
    const [auth] = await as({ sub: user }, (q) => q("select public.public_legal_info() as r"));
    expect(Object.keys(auth.r).sort()).toEqual(PUBLIC_KEYS);
    expect(auth.r).not.toHaveProperty("updated_by");
    expect(auth.r).not.toHaveProperty("id");
  });

  it("la table n'est lisible directement que par le super admin", async () => {
    const e = await expectPgError(as({ role: "anon" }, (q) => q("select * from public.platform_legal")));
    expect(e.code).toBe("42501");
    const user = await createAuthUser(`curieux-${randomUUID().slice(0, 8)}@test.dev`, "Curieux");
    expect(await as({ sub: user }, (q) => q("select * from public.platform_legal"))).toHaveLength(0);
    const org = await createOrg("Légal lecture");
    expect(await as({ sub: org.ownerId }, (q) => q("select * from public.platform_legal"))).toHaveLength(0);
    const sa = await superAdmin();
    expect(await as({ sub: sa }, (q) => q("select id from public.platform_legal"))).toEqual([{ id: true }]);
    // Aucune écriture directe, même pour le super admin (tout passe par svc_platform_legal_update)
    const w = await expectPgError(as({ sub: sa }, (q) => q("update public.platform_legal set company_name = 'Pirate SAS'")));
    expect(w.code).toBe("42501");
  });

  it("svc_platform_legal_update : service role + super admin seulement", async () => {
    const sa = await superAdmin();
    for (const who of [{ sub: sa }, { role: "anon" as const }]) {
      const e = await expectPgError(
        as(who, (q) => q("select public.svc_platform_legal_update($1, $2::jsonb)", [sa, JSON.stringify(FULL_INFO)])),
      );
      expect(e.code).toBe("42501");
    }
    const user = await createAuthUser(`pas-admin-${randomUUID().slice(0, 8)}@test.dev`, "Pas admin");
    for (const actor of [user, null, randomUUID()]) {
      const e = await expectPgError(svc("svc_platform_legal_update", [actor, JSON.stringify(FULL_INFO)]));
      expect(e.code).toBe("42501");
    }
    const [row] = await sql("select company_name from public.platform_legal");
    expect(row.company_name).not.toBe("Rydar SAS");
  });

  it("enregistre des valeurs nettoyées, trace l'auteur et écrit le journal d'audit", async () => {
    const sa = await superAdmin();
    // Clés inconnues (ou réservées) ignorées : ni enregistrées ni journalisées
    const res = await svc("svc_platform_legal_update", [sa, JSON.stringify({ ...FULL_INFO, updated_by: randomUUID(), injected: "x" })]);
    expect(res).toMatchObject({ ok: true, code: "SAVED" });
    const [row] = await sql("select * from public.platform_legal");
    expect(row).toMatchObject({
      company_name: "Rydar SAS",
      email: "contact@rydar.example",
      privacy_email: null,
      host_name: "Hetzner Online GmbH",
      updated_by: sa,
    });
    const [info] = await as({ role: "anon" }, (q) => q("select public.public_legal_info() as r"));
    expect(info.r).toMatchObject({ company_name: "Rydar SAS", registration: "RCS Paris 912 345 678", privacy_email: null });
    const logs = await sql(
      "select actor_type, actor_user_id, organization_id, metadata from public.audit_logs where action = 'platform_legal.updated' and actor_user_id = $1",
      [sa],
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor_type: "super_admin", organization_id: null });
    // Journal = valeurs enregistrées (e-mail en minuscules), champs connus seulement
    expect(logs[0].metadata).toEqual(Object.fromEntries(Object.keys(FULL_INFO).map((k) => [k, row[k]])));

    // Champ vidé → non renseigné
    expect(await svc("svc_platform_legal_update", [sa, JSON.stringify({ ...FULL_INFO, phone: "   " })])).toMatchObject({ ok: true });
    expect((await sql("select phone from public.platform_legal"))[0].phone).toBeNull();
  });

  it("refuse un e-mail invalide, une longueur hors limites ou des données qui ne sont pas un objet", async () => {
    const sa = await superAdmin();
    await svc("svc_platform_legal_update", [sa, JSON.stringify(FULL_INFO)]);
    const before = await sql("select count(*)::int as n from public.audit_logs where action = 'platform_legal.updated'");
    for (const bad of [
      { ...FULL_INFO, email: "pas-un-email" },
      { ...FULL_INFO, privacy_email: "rgpd@exemple" },
      { ...FULL_INFO, email: "deux @espaces.fr" },
      { ...FULL_INFO, company_name: "X" },
      { ...FULL_INFO, vat_number: "F".repeat(41) },
    ]) {
      expect(await svc("svc_platform_legal_update", [sa, JSON.stringify(bad)]), JSON.stringify(bad)).toMatchObject({ ok: false, code: "INVALID" });
    }
    for (const notObject of ['"texte"', "[1, 2]", "42"]) {
      expect(await svc("svc_platform_legal_update", [sa, notObject]), notObject).toMatchObject({ ok: false, code: "INVALID" });
    }
    // Rien n'a changé, rien n'est journalisé
    const [row] = await sql("select company_name, email, vat_number from public.platform_legal");
    expect(row).toEqual({ company_name: "Rydar SAS", email: "contact@rydar.example", vat_number: "FR12912345678" });
    const after = await sql("select count(*)::int as n from public.audit_logs where action = 'platform_legal.updated'");
    expect(after[0].n).toBe(before[0].n);
  });
});

// -----------------------------------------------------------------------------
// Acceptation des documents
// -----------------------------------------------------------------------------
describe("Acceptation des documents légaux (accept_legal_documents)", () => {
  it("réservée à un utilisateur connecté", async () => {
    const anon = await expectPgError(
      as({ role: "anon" }, (q) => q("select public.accept_legal_documents(array['cgu'], '2026-09-27')")),
    );
    expect(anon.code).toBe("42501");
    const noUser = await expectPgError(
      as({ role: "authenticated" }, (q) => q("select public.accept_legal_documents(array['cgu'], '2026-09-27')")),
    );
    expect(noUser.code).toBe("42501");
  });

  it("CGU et confidentialité : tout utilisateur, sans centrale ; doublons ignorés, source non falsifiable", async () => {
    const org = await createOrg("Légal chauffeur");
    const d = await createDriver(org);
    expect(await accept(d.userId, ["cgu", "privacy", "cgu"], "2026-09-27", null, "app")).toMatchObject({ ok: true, code: "ACCEPTED" });
    const rows = await sql("select document, version, source, organization_id from public.legal_acceptances where user_id = $1 order by document", [d.userId]);
    expect(rows).toEqual([
      { document: "cgu", version: "2026-09-27", source: "app", organization_id: null },
      { document: "privacy", version: "2026-09-27", source: "app", organization_id: null },
    ]);
    // Idempotent : accepter à nouveau la même version n'ajoute rien et garde la première date
    const [first] = await sql("select accepted_at from public.legal_acceptances where user_id = $1 and document = 'cgu'", [d.userId]);
    expect(await accept(d.userId, ["cgu"], "2026-09-27", null, "web")).toMatchObject({ ok: true });
    const again = await sql("select accepted_at, source from public.legal_acceptances where user_id = $1 and document = 'cgu'", [d.userId]);
    expect(again).toEqual([{ accepted_at: first.accepted_at, source: "app" }]);
    // « join » et « admin » sont réservés au serveur : un appel client est enregistré « web »
    await accept(d.userId, ["cgu"], "2026-09-01", null, "join");
    const [last] = await sql("select source from public.legal_acceptances where user_id = $1 and version = '2026-09-01'", [d.userId]);
    expect(last.source).toBe("web");
  });

  it("CGV et accord de traitement : propriétaire ou administrateur de la centrale seulement", async () => {
    const org = await createOrg("Légal centrale");
    const admin = await createMember(org, "admin");
    const dispatcher = await createMember(org, "dispatcher");
    const other = await createOrg("Légal autre");

    expect(await accept(org.ownerId, ["cgv", "dpa", "cgu"], "2026-09-27", org.id)).toMatchObject({ ok: true });
    expect(await accept(admin, ["cgv", "dpa"], "2026-09-27", org.id)).toMatchObject({ ok: true });
    const owned = await sql("select document from public.legal_acceptances where user_id = $1 and organization_id = $2 order by document", [org.ownerId, org.id]);
    expect(owned.map((r) => r.document)).toEqual(["cgu", "cgv", "dpa"]);

    // Dispatcher, propriétaire d'une autre centrale, chauffeur : refusés
    const d = await createDriver(org);
    for (const who of [dispatcher, other.ownerId, d.userId]) {
      const e = await expectPgError(accept(who, ["cgv", "dpa"], "2026-09-27", org.id));
      expect(e.code).toBe("42501");
    }
    // CGV sans centrale
    expect(await accept(org.ownerId, ["cgv"], "2026-09-27", null)).toMatchObject({ ok: false, code: "ORG_REQUIRED" });
    // CGU au nom d'une centrale : membre de cette centrale seulement
    expect(await accept(dispatcher, ["cgu"], "2026-09-27", org.id)).toMatchObject({ ok: true });
    expect((await expectPgError(accept(other.ownerId, ["cgu"], "2026-09-27", org.id))).code).toBe("42501");
  });

  it("documents ou version invalides refusés", async () => {
    const org = await createOrg("Légal invalide");
    for (const [docs, version] of [
      [["cgu", "cookies"], "2026-09-27"],
      [[], "2026-09-27"],
      [null, "2026-09-27"],
      [["cgu", null], "2026-09-27"],
      [["cgu"], "   "],
      [["cgu"], null],
    ] as const) {
      expect(await accept(org.ownerId, docs, version), JSON.stringify([docs, version])).toMatchObject({ ok: false, code: "INVALID" });
    }
    const [c] = await sql("select count(*)::int as n from public.legal_acceptances where user_id = $1", [org.ownerId]);
    expect(c.n).toBe(0);
    // Version hors format AAAA-MM-JJ (20260924004300) : refusée, rien n'est enregistré
    expect(await accept(org.ownerId, ["cgu"], "v".repeat(60))).toMatchObject({ ok: false, code: "INVALID_VERSION" });
    const [after] = await sql("select count(*)::int as n from public.legal_acceptances where user_id = $1", [org.ownerId]);
    expect(after.n).toBe(0);
  });

  it("lecture : soi-même, propriétaire / administrateur de la centrale, super admin ; aucune écriture directe", async () => {
    const org: Org = await createOrg("Légal lecture RLS");
    const admin = await createMember(org, "admin");
    const dispatcher = await createMember(org, "dispatcher");
    const stranger = await createAuthUser(`inconnu-${randomUUID().slice(0, 8)}@test.dev`, "Inconnu");
    const d = await createDriver(org);
    await accept(org.ownerId, ["cgv", "dpa"], "2026-09-27", org.id);
    await accept(dispatcher, ["cgu"], "2026-09-27", org.id);
    await accept(d.userId, ["cgu", "privacy"], "2026-09-27");

    // Soi-même
    expect((await acceptances(d.userId)).map((r) => r.document).sort()).toEqual(["cgu", "privacy"]);
    expect((await acceptances(dispatcher)).map((r) => r.user_id)).toEqual([dispatcher]);
    // Administrateur : acceptations au nom de la centrale (pas celles du chauffeur, faites sans centrale)
    const seenByAdmin = await acceptances(admin);
    expect(seenByAdmin.every((r) => r.organization_id === org.id)).toBe(true);
    expect(seenByAdmin.map((r) => r.document).sort()).toEqual(["cgu", "cgv", "dpa"]);
    // Un autre utilisateur ne voit rien
    expect(await acceptances(stranger)).toHaveLength(0);
    // Super admin : tout
    const sa = await superAdmin();
    const all = await as({ sub: sa }, (q) => q("select user_id from public.legal_acceptances where user_id = any($1::uuid[])", [[org.ownerId, dispatcher, d.userId]]));
    expect(all).toHaveLength(5);

    // Écriture directe interdite (preuve non falsifiable)
    const ins = await expectPgError(
      as({ sub: org.ownerId }, (q) =>
        q("insert into public.legal_acceptances (user_id, organization_id, document, version) values ($1, $2, 'dpa', '2020-01-01')", [org.ownerId, org.id]),
      ),
    );
    expect(ins.code).toBe("42501");
    const del = await expectPgError(as({ sub: org.ownerId }, (q) => q("delete from public.legal_acceptances where user_id = $1", [org.ownerId])));
    expect(del.code).toBe("42501");
  });
});

// -----------------------------------------------------------------------------
// Preuve d'acceptation : ajout seul
// -----------------------------------------------------------------------------
describe("Preuve d'acceptation : ajout seul, conservée après la suppression d'un compte", () => {
  it("compte supprimé : la preuve de la centrale reste avec l'e-mail du signataire, celle d'une personne devient anonyme", async () => {
    const org = await createOrg("Légal preuve");
    const ownerEmail = await emailOf(org.ownerId);
    const person = await createAuthUser(`perso-${randomUUID().slice(0, 8)}@test.dev`, "Personne");
    await accept(org.ownerId, ["cgv", "dpa", "cgu"], "2026-09-27", org.id);
    await accept(person, ["cgu", "privacy"], "2026-09-27", null, "app");
    // Signataire copié pour les documents de la centrale seulement
    expect(await sql("select document, accepted_by_email from public.legal_acceptances where organization_id = $1 order by document", [org.id])).toEqual([
      { document: "cgu", accepted_by_email: null },
      { document: "cgv", accepted_by_email: ownerEmail },
      { document: "dpa", accepted_by_email: ownerEmail },
    ]);
    const personal = (await sql("select id from public.legal_acceptances where user_id = $1", [person])).map((r) => r.id);
    expect(personal).toHaveLength(2);

    // Comptes supprimés (Auth → public.users) : les lignes restent, détachées du compte
    await sql("delete from auth.users where id = any($1::uuid[])", [[org.ownerId, person]]);
    expect(await sql("select user_id, document, version, accepted_by_email from public.legal_acceptances where organization_id = $1 order by document", [org.id])).toEqual([
      { user_id: null, document: "cgu", version: "2026-09-27", accepted_by_email: null },
      { user_id: null, document: "cgv", version: "2026-09-27", accepted_by_email: ownerEmail },
      { user_id: null, document: "dpa", version: "2026-09-27", accepted_by_email: ownerEmail },
    ]);
    // Bandeau du tableau de bord et /admin/legal : la centrale a toujours accepté la version en vigueur
    const [{ n }] = await sql(
      "select count(*)::int as n from public.legal_acceptances where organization_id = $1 and document = 'dpa' and version = '2026-09-27'",
      [org.id],
    );
    expect(n).toBe(1);
    // Acceptation personnelle : date, version et canal seulement, plus aucun lien avec la personne
    expect(await sql("select user_id, organization_id, accepted_by_email, source from public.legal_acceptances where id = any($1::uuid[])", [personal])).toEqual([
      { user_id: null, organization_id: null, accepted_by_email: null, source: "app" },
      { user_id: null, organization_id: null, accepted_by_email: null, source: "app" },
    ]);
  });

  it("ni modification ni suppression, même par le service role ou le propriétaire de la base ; une centrale qui a accepté ne se supprime plus", async () => {
    const org = await createOrg("Légal immuable");
    const other = await createAuthUser(`autre-${randomUUID().slice(0, 8)}@test.dev`, "Autre");
    await accept(org.ownerId, ["cgv", "dpa"], "2026-09-27", org.id);
    const [row] = await sql("select id from public.legal_acceptances where organization_id = $1 and document = 'dpa'", [org.id]);
    const service = (text: string, params: unknown[] = []) => as({ role: "service_role" }, (q) => q(text, params));

    const changes = [
      ["update public.legal_acceptances set version = '2020-01-01' where id = $1", [row.id]],
      ["update public.legal_acceptances set accepted_at = now() - interval '1 year' where id = $1", [row.id]],
      ["update public.legal_acceptances set accepted_by_email = 'pirate@test.dev' where id = $1", [row.id]],
      ["update public.legal_acceptances set organization_id = null where id = $1", [row.id]],
      ["update public.legal_acceptances set user_id = $2 where id = $1", [row.id, other]],
      ["delete from public.legal_acceptances where id = $1", [row.id]],
    ] as const;
    // Service role (routes serveur) : lecture et ajout seulement
    for (const [change, params] of changes) {
      expect((await expectPgError(service(change, [...params]))).code, change).toBe("42501");
    }
    expect((await expectPgError(service("truncate public.legal_acceptances"))).code).toBe("42501");
    // Propriétaire de la base (worker, console SQL) : arrêté par le déclencheur
    for (const [change, params] of changes) {
      const e = await expectPgError(sql(change, [...params]));
      expect(e.code, change).toBe("55000");
      expect(e.message, change).toMatch(/LEGAL_PROOF_IMMUTABLE/);
    }
    const [same] = await sql("select version, accepted_by_email from public.legal_acceptances where id = $1", [row.id]);
    expect(same).toEqual({ version: "2026-09-27", accepted_by_email: await emailOf(org.ownerId) });
    // La centrale s'archive, elle ne se supprime plus (sinon la preuve du contrat disparaîtrait avec elle)
    const drop = await expectPgError(sql("delete from public.organizations where id = $1", [org.id]));
    expect(drop.code).toBe("23503");

    // Insertion directe (service role, comme l'inscription par lien) : signataire lu sur le compte, doublon refusé
    const insert = "insert into public.legal_acceptances (user_id, organization_id, document, version, source, accepted_by_email) values ($1, $2, 'cgv', '2026-10-01', 'admin', 'pirate@test.dev')";
    await service(insert, [org.ownerId, org.id]);
    const [direct] = await sql("select accepted_by_email from public.legal_acceptances where organization_id = $1 and version = '2026-10-01'", [org.id]);
    expect(direct.accepted_by_email).toBe(await emailOf(org.ownerId));
    expect((await expectPgError(service(insert, [org.ownerId, org.id]))).code).toBe("23505");
  });

  it("appels simultanés (double clic, deux onglets) : une seule acceptation par document", async () => {
    const org = await createOrg("Légal simultané");
    const clients: PoolClient[] = [await pool.connect(), await pool.connect()];
    let results: Record<string, any>[] = [];
    try {
      for (const c of clients) {
        await c.query("begin");
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: org.ownerId, role: "authenticated" })]);
        await c.query("set local role authenticated");
      }
      const call = (c: PoolClient) =>
        c.query("select public.accept_legal_documents(array['cgv', 'dpa'], '2026-09-27', $1) as r", [org.id]).then((r) => r.rows[0].r);
      const first = await call(clients[0]);
      // La seconde transaction attend la première (index unique), puis n'ajoute rien
      const second = call(clients[1]);
      await clients[0].query("commit");
      results = [first, await second];
      await clients[1].query("commit");
    } finally {
      for (const c of clients) {
        await c.query("rollback").catch(() => undefined);
        c.release();
      }
    }
    expect(results).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
    const rows = await sql("select document from public.legal_acceptances where organization_id = $1 order by document", [org.id]);
    expect(rows.map((r) => r.document)).toEqual(["cgv", "dpa"]);
  });
});

// -----------------------------------------------------------------------------
// Inscription VTC de la centrale
// -----------------------------------------------------------------------------
describe("organizations.vtc_registration", () => {
  const setVtc = (sub: string, orgId: string, value: string) =>
    as({ sub }, (q) => q("update public.organizations set vtc_registration = $2 where id = $1 returning id", [orgId, value]));
  const current = async (orgId: string) => (await sql("select vtc_registration from public.organizations where id = $1", [orgId]))[0].vtc_registration;

  it("modifiable par le propriétaire et les administrateurs seulement", async () => {
    const org = await createOrg("Légal VTC");
    const admin = await createMember(org, "admin");
    const dispatcher = await createMember(org, "dispatcher");
    const other = await createOrg("Légal VTC autre");
    const d = await createDriver(org);

    expect(await setVtc(org.ownerId, org.id, "EVTC075200001")).toHaveLength(1);
    expect(await current(org.id)).toBe("EVTC075200001");
    expect(await setVtc(admin, org.id, "EVTC075200002")).toHaveLength(1);
    expect(await current(org.id)).toBe("EVTC075200002");

    // Dispatcher, autre centrale, chauffeur : aucune ligne modifiée
    for (const who of [dispatcher, other.ownerId, d.userId]) {
      expect(await setVtc(who, org.id, "EVTC-PIRATE")).toHaveLength(0);
    }
    expect(await current(org.id)).toBe("EVTC075200002");
    const anon = await expectPgError(
      as({ role: "anon" }, (q) => q("update public.organizations set vtc_registration = 'X' where id = $1", [org.id])),
    );
    expect(anon.code).toBe("42501");
  });

  it("longueur bornée, et les colonnes réservées au super admin restent protégées", async () => {
    const org = await createOrg("Légal VTC bornes");
    const long = await expectPgError(setVtc(org.ownerId, org.id, "E".repeat(121)));
    expect(long.code).toBe("23514");
    const reserved = await expectPgError(
      as({ sub: org.ownerId }, (q) => q("update public.organizations set dispatch_model = 'centrale' where id = $1", [org.id])),
    );
    expect(reserved.code).toBe("42501");
  });
});

// -----------------------------------------------------------------------------
// Durées de conservation annoncées (/confidentialite § 9, /dpa § 11)
// -----------------------------------------------------------------------------
describe("Durées de conservation (private.housekeeping)", () => {
  it("signalements de la flotte recopiés dans le journal de la centrale : 180 jours", async () => {
    const org = await createOrg("Légal journal");
    const event = async (type: string, days: number) =>
      String((await sql(
        `insert into public.ride_events (organization_id, type, message, data, created_at)
         values ($1, $2, 'Contrôle signalé par Karim B. : rue de Rivoli', '{"lat": 48.86, "lng": 2.33}', now() - make_interval(days => $3))
         returning id`,
        [org.id, type, days],
      ))[0].id);
    const old = await event("fleet.report", 181);
    const cleared = await event("fleet.report_cleared", 200);
    const recent = await event("fleet.report", 10);
    const other = await event("driver.applied", 400);
    expect((await housekeeping()).fleet_events_purged).toBeGreaterThanOrEqual(2);
    const left = await sql("select id from public.ride_events where id = any($1::bigint[])", [[old, cleared, recent, other]]);
    expect(left.map((r) => String(r.id)).sort()).toEqual([recent, other].sort());
  });

  it("notifications : 90 jours après leur envoi prévu, quel que soit leur statut ; un rappel planifié reste", async () => {
    const org = await createOrg("Légal notifications");
    const notification = async (status: string, createdDaysAgo: number, scheduledDaysAgo: number) =>
      (await sql(
        `insert into public.notifications (organization_id, type, title, body, status, created_at, scheduled_for)
         values ($1, 'settlement_reminder', 'Commission à régler', 'Karim, 19 € de commission à régler', $2::public.notification_status,
                 now() - make_interval(days => $3), now() - make_interval(days => $4))
         returning id`,
        [org.id, status, createdDaysAgo, scheduledDaysAgo],
      ))[0].id as string;
    const purged = [
      await notification("sent", 91, 91),
      await notification("failed", 120, 120),
      await notification("cancelled", 100, 100),
      await notification("sending", 95, 95),
      // En file depuis plus de 90 jours après l'heure prévue : périmée
      await notification("queued", 200, 95),
    ];
    const kept = [
      await notification("failed", 10, 10),
      // Rappel de course planifiée : créé il y a 100 jours, envoi prévu dans 10 jours
      await notification("queued", 100, -10),
      // Créée il y a 100 jours, envoyée il y a 60 jours
      await notification("sent", 100, 60),
    ];
    expect((await housekeeping()).notifications_purged).toBeGreaterThanOrEqual(purged.length);
    const left = await sql("select id from public.notifications where id = any($1::uuid[])", [[...purged, ...kept]]);
    expect(left.map((r) => r.id).sort()).toEqual([...kept].sort());
  });

  it("journal d'audit : adresse IP et navigateur effacés au bout d'un an, l'action reste tracée", async () => {
    const org = await createOrg("Légal IP");
    const refused = async (daysAgo: number) =>
      String((await sql(
        `insert into public.audit_logs (organization_id, actor_type, action, entity_type, entity_id, severity, ip, user_agent, metadata, created_at)
         values ($1, 'system', 'driver.join_refused', 'organizations', $2, 'warning', '203.0.113.7', 'Mozilla/5.0 (iPhone)',
                 '{"reason": "identity_banned", "via": "join_link"}', now() - make_interval(days => $3))
         returning id`,
        [org.id, org.id, daysAgo],
      ))[0].id);
    const old = await refused(366);
    const recent = await refused(30);
    expect((await housekeeping()).audit_network_purged).toBeGreaterThanOrEqual(1);
    const rows = await sql("select id, ip, user_agent, action, metadata from public.audit_logs where id = any($1::bigint[]) order by created_at", [[old, recent]]);
    expect(rows).toEqual([
      { id: old, ip: null, user_agent: null, action: "driver.join_refused", metadata: { reason: "identity_banned", via: "join_link" } },
      { id: recent, ip: "203.0.113.7", user_agent: "Mozilla/5.0 (iPhone)", action: "driver.join_refused", metadata: { reason: "identity_banned", via: "join_link" } },
    ]);
  });

  it("courses : supprimées 10 ans après la fin de l'année de la prise en charge, avec leur journal", async () => {
    const org = await createOrg("Légal dix ans");
    const [{ limit }] = await sql("select date_trunc('year', now() - interval '10 years') as limit");
    const day = (offset: number) => new Date((limit as Date).getTime() + offset * 86_400_000);
    const expired = await insertRideBypass(org, { pickup_at: day(-1) });
    const cancelled = await insertRideBypass(org, { pickup_at: day(-40), status: "CANCELLED" });
    const kept = await insertRideBypass(org, { pickup_at: day(1) });
    await sql("insert into public.ride_events (organization_id, ride_id, type, message) values ($1, $2, 'ride.note', 'Client Historique à bord')", [org.id, expired]);
    expect((await housekeeping()).rides_purged).toBeGreaterThanOrEqual(2);
    const left = await sql("select id from public.rides where id = any($1::uuid[])", [[expired, cancelled, kept]]);
    expect(left.map((r) => r.id)).toEqual([kept]);
    expect(await sql("select id from public.ride_events where ride_id = $1", [expired])).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Bannissement pour fraude : 3 ans au plus
// -----------------------------------------------------------------------------
describe("Bannissement : empreintes et signalement effacés au bout de 3 ans (private.purge_expired_bans)", () => {
  /** Chauffeur aux identités uniques (téléphone, e-mail, appareil) : un bannissement ne touche que lui. */
  async function bannable(org: Org) {
    const phone = `06${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    const email = `banni-${randomUUID().slice(0, 8)}@test.dev`;
    const userId = await createAuthUser(email, "Karim Bensaid");
    const [d] = await sql(
      `insert into public.drivers (organization_id, user_id, first_name, last_name, phone, email, status, presence)
       values ($1, $2, 'Karim', 'Bensaid', $3, $4, 'active', 'offline') returning id`,
      [org.id, userId, phone, email],
    );
    await as({ sub: userId }, (q) => q("select public.driver_register_device($1, 'android')", [`install-${randomUUID().slice(0, 12)}`]));
    return { id: d.id as string, userId, phone, email };
  }
  const identityBanned = async (orgId: string, phone: string, email: string) =>
    (await as({ role: "service_role" }, (q) => q("select public.svc_identity_check($1, $2, $3) as r", [orgId, phone, email])))[0].r.banned as boolean;
  /** Tout ce qui concerne ce chauffeur date de 4 ans (bannissement, signalement, journal). */
  const fourYearsAgo = async (driverId: string) => {
    await sql("update public.banned_identities set created_at = now() - interval '4 years' where driver_id = $1", [driverId]);
    await sql("update public.fraud_reports set created_at = now() - interval '4 years' where driver_id = $1", [driverId]);
    await sql("update public.drivers set banned_at = now() - interval '4 years' where id = $1 and banned_at is not null", [driverId]);
    await sql("update public.audit_logs set created_at = now() - interval '4 years' where entity_type = 'drivers' and entity_id = $1", [driverId]);
  };

  it("même si le compte existe : empreintes, signalement et motif effacés ; la fiche reste suspendue ; un bannissement récent reste", async () => {
    const org = await createOrg("Légal bannissement");
    const old = await bannable(org);
    const lifted = await bannable(org);
    const recent = await bannable(org);
    const ban = async (d: { id: string }, reason: string, report: boolean) =>
      (await as({ sub: org.ownerId }, (q) => q("select public.ban_driver($1, $2, 'fraud', $3, false) as r", [d.id, reason, report])))[0].r;
    expect(await ban(old, "Faux paiements répétés", true)).toMatchObject({ ok: true, code: "BANNED" });
    expect(await ban(lifted, "Retards répétés", false)).toMatchObject({ ok: true });
    expect(await ban(recent, "Courses fictives", true)).toMatchObject({ ok: true });
    const [liftRes] = await as({ sub: org.ownerId }, (q) => q("select public.lift_driver_ban($1, 'Erreur de saisie') as r", [lifted.id]));
    expect(liftRes.r).toMatchObject({ ok: true, code: "LIFTED" });
    // Verrou du compte journalisé par le tableau de bord (lib/audit.ts : motif, adresse IP)
    await sql(
      `insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, ip, metadata)
       values ($1, 'user', $2, 'driver.account_locked', 'drivers', $3, 'critical', '203.0.113.9', '{"reason": "Faux paiements répétés"}')`,
      [org.id, org.ownerId, old.id],
    );
    expect(await identityBanned(org.id, old.phone, old.email)).toBe(true);
    await fourYearsAgo(old.id);
    await fourYearsAgo(lifted.id);

    const res = await housekeeping();
    expect(res.bans_purged).toMatchObject({ drivers: 1, reports: 1 });
    expect(res.bans_purged.identities).toBeGreaterThanOrEqual(6);

    // Plus d'empreinte ni de signalement (levées comprises) ; la fiche reste suspendue, sans bannissement
    for (const d of [old, lifted]) {
      expect(await sql("select id from public.banned_identities where driver_id = $1", [d.id])).toHaveLength(0);
      expect(await sql("select id from public.fraud_reports where driver_id = $1", [d.id])).toHaveLength(0);
    }
    const [fiche] = await sql(
      "select status, banned_at, banned_by, ban_reason, ban_scope, ban_report_id, suspended_reason from public.drivers where id = $1",
      [old.id],
    );
    expect(fiche).toEqual({
      status: "suspended", banned_at: null, banned_by: null, ban_reason: null, ban_scope: null, ban_report_id: null,
      suspended_reason: "Bannissement expiré (3 ans)",
    });
    expect(await identityBanned(org.id, old.phone, old.email)).toBe(false);

    // Journal d'audit : plus aucun motif ; les actions restent tracées, leur contenu caviardé
    for (const d of [old, lifted]) {
      const traces = await sql(
        "select action from public.audit_logs where entity_id = $1 and (metadata::text like '%Faux paiements%' or metadata::text like '%Retards%' or metadata::text like '%Erreur de saisie%')",
        [d.id],
      );
      expect(traces, d.id).toEqual([]);
    }
    const redacted = await sql(
      "select action, metadata from public.audit_logs where entity_type = 'drivers' and entity_id = any($1::text[]) and action like 'driver.%' order by action",
      [[old.id, lifted.id]],
    );
    expect(redacted.map((r) => r.action)).toEqual(["driver.account_locked", "driver.ban_lifted", "driver.banned", "driver.banned"]);
    expect(redacted.every((r) => r.metadata.redacted === true)).toBe(true);
    const changes = await sql(
      "select metadata from public.audit_logs where entity_type = 'drivers' and entity_id = any($1::text[]) and action = 'drivers.update'",
      [[old.id, lifted.id]],
    );
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) {
      expect(Object.keys(c.metadata.changes ?? {})).not.toContain("ban_reason");
    }
    // Le statut suspendu, lui, reste tracé
    expect(changes.some((c) => c.metadata.changes?.status?.to === "suspended")).toBe(true);

    // Bannissement de moins de 3 ans : intact
    const [kept] = await sql("select ban_reason, ban_scope from public.drivers where id = $1", [recent.id]);
    expect(kept).toEqual({ ban_reason: "Courses fictives", ban_scope: "org" });
    expect(await sql("select id from public.fraud_reports where driver_id = $1", [recent.id])).toHaveLength(1);
    expect(await identityBanned(org.id, recent.phone, recent.email)).toBe(true);
    // Rien de plus à effacer
    expect((await housekeeping()).bans_purged).toEqual({ identities: 0, reports: 0, drivers: 0, audit: 0 });
  });

  it("un échec de la purge des bannissements n'empêche pas le reste du ménage ; elle est retentée ensuite", async () => {
    const org = await createOrg("Légal purge en échec");
    const d = await bannable(org);
    const [ban] = await as({ sub: org.ownerId }, (q) => q("select public.ban_driver($1, 'Motif ancien', 'fraud', false, false) as r", [d.id]));
    expect(ban.r).toMatchObject({ ok: true });
    await fourYearsAgo(d.id);
    const [event] = await sql(
      `insert into public.ride_events (organization_id, type, message, created_at)
       values ($1, 'fleet.report', 'Bouchon signalé', now() - interval '200 days') returning id`,
      [org.id],
    );
    await sql(`create function public.test_block_ban_purge() returns trigger language plpgsql as $$
               begin raise exception 'purge bloquée (test)'; end; $$`);
    await sql("create trigger test_block_ban_purge before delete on public.banned_identities for each row execute function public.test_block_ban_purge()");
    try {
      const res = await housekeeping();
      expect(res.errors).toEqual({ bans: expect.stringMatching(/purge bloquée/) });
      expect(res.bans_purged).toBeNull();
      // Rien de la purge en échec n'est appliqué ; le reste du ménage, si
      expect((await sql("select banned_at from public.drivers where id = $1", [d.id]))[0].banned_at).not.toBeNull();
      expect(await sql("select id from public.ride_events where id = $1", [event.id])).toHaveLength(0);
    } finally {
      await sql("drop trigger test_block_ban_purge on public.banned_identities");
      await sql("drop function public.test_block_ban_purge()");
    }
    const again = await housekeeping();
    expect(again).not.toHaveProperty("errors");
    expect(again.bans_purged.drivers).toBeGreaterThanOrEqual(1);
    expect((await sql("select banned_at from public.drivers where id = $1", [d.id]))[0].banned_at).toBeNull();
  });

  it("purge réservée au système", async () => {
    const org = await createOrg("Légal purge droits");
    for (const who of [{ sub: org.ownerId }, { role: "service_role" as const }, { role: "anon" as const }]) {
      const e = await expectPgError(as(who, (q) => q("select private.purge_expired_bans()")));
      expect(e.code).toBe("42501");
    }
  });
});
