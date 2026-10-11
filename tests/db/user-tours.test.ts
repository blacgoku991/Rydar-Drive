// Visite guidée de première connexion (20260924007800_guided_tour, docs/TUTORIEL.md § 3, § 4.1, § 11.2) : table
// public.user_tours (RLS, chacun ne lit que ses lignes, aucune écriture directe, aucun droit pour anon ni le service
// role), RPC public.save_user_tour (security definer, search_path vide, écrit pour l'utilisateur connecté seulement),
// contraintes, cascade à la suppression du compte, rattrapage des comptes existants rejoué depuis ses marqueurs.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TOUR_KEYS, TOUR_MAX_STEPS, TOUR_STATUSES } from "../../packages/shared/src/tour";
import { as, createAuthUser, createDriver, createMember, createOrg, expectPgError, pool, sql, superAdmin } from "./helpers";

afterAll(async () => {
  await pool.end();
});

const MIGRATION = join(__dirname, "../../supabase/migrations/20260924007800_guided_tour.sql");
const SAVE = "public.save_user_tour(text, text, integer)";

type Saved = { tour: string; status: string; step: number; shown_at: string | null; completed_at: string | null };
type Row = { tour: string; status: string; step: number; shown_at: string | null; completed_at: string | null; updated_at: string };

const account = (label: string) => createAuthUser(`visite-${label}-${randomUUID().slice(0, 8)}@test.dev`, `Visite ${label}`);
/** save_user_tour appelée par l'utilisateur connecté `sub` (rôle authenticated). */
const save = (sub: string, tour: string | null, status: string | null, step: number | null) =>
  as({ sub }, async (q) => (await q(`select public.save_user_tour($1, $2, $3) as r`, [tour, status, step]))[0].r as Saved);
/** Lignes d'un compte (superutilisateur), dates en texte : comparaisons exactes, à la microseconde. */
const rowsOf = (userId: string) =>
  sql<Row>(
    `select tour, status, step, shown_at::text as shown_at, completed_at::text as completed_at, updated_at::text as updated_at
       from public.user_tours where user_id = $1 order by tour`,
    [userId],
  );
const rowOf = async (userId: string, tour: string) => (await rowsOf(userId)).find((r) => r.tour === tour);
/** b est postérieure à a (horodatages en texte). */
const isAfter = async (a: string, b: string) => (await sql(`select $2::timestamptz > $1::timestamptz as after`, [a, b]))[0].after as boolean;
/** Même instant (texte de la base et ISO du jsonb renvoyé par la RPC). */
const sameInstant = async (a: string | null, b: string | null) =>
  (await sql(`select $1::timestamptz is not distinct from $2::timestamptz as same`, [a, b]))[0].same as boolean;
/** Deux transactions successives : now() différent, à coup sûr. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("Table public.user_tours : RLS et droits (§ 11.2, point 1)", () => {
  it("RLS active ; anon : aucun droit ; authenticated : SELECT seulement ; service_role : aucun droit", async () => {
    const [table] = await sql(`select relrowsecurity from pg_class where oid = 'public.user_tours'::regclass`);
    expect(table.relrowsecurity).toBe(true);

    const privileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
    const granted = async (role: string) => {
      const out: string[] = [];
      for (const p of privileges) {
        const [r] = await sql(`select has_table_privilege($1, 'public.user_tours', $2) as t`, [role, p]);
        if (r.t) out.push(p);
      }
      // Aucun droit par colonne non plus (INSERT, UPDATE, REFERENCES)
      for (const p of ["INSERT", "UPDATE", "REFERENCES"]) {
        const [r] = await sql(`select has_any_column_privilege($1, 'public.user_tours', $2) as c`, [role, p]);
        if (r.c) out.push(`${p} (colonne)`);
      }
      return out;
    };
    expect(await granted("anon")).toEqual([]);
    expect(await granted("authenticated")).toEqual(["SELECT"]);
    expect(await granted("service_role")).toEqual([]);

    // Une seule politique : lecture de ses lignes par l'utilisateur connecté
    const policies = await sql(
      `select policyname, cmd, roles::text[] as roles, qual from pg_policies where schemaname = 'public' and tablename = 'user_tours'`,
    );
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ policyname: "user_tours_select_own", cmd: "SELECT", roles: ["authenticated"] });
    expect(policies[0].qual).toMatch(/user_id = \(?\s*select auth\.uid\(\)/i);

    // Clé (user_id, tour) ; compte supprimé → lignes supprimées
    const [pk] = await sql(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c where c.conrelid = 'public.user_tours'::regclass and c.contype = 'p'`,
    );
    expect(pk.def).toBe("PRIMARY KEY (user_id, tour)");
    const [fk] = await sql(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c where c.conrelid = 'public.user_tours'::regclass and c.contype = 'f'`,
    );
    expect(fk.def).toBe("FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE");
  });

  it("service role : lecture et écriture directes refusées (42501)", async () => {
    const e1 = await expectPgError(as({ role: "service_role" }, (q) => q(`select * from public.user_tours`)));
    expect(e1.code).toBe("42501");
    const user = await account("svc");
    const e2 = await expectPgError(
      as({ role: "service_role" }, (q) => q(`insert into public.user_tours (user_id, tour) values ($1, 'fleet')`, [user])),
    );
    expect(e2.code).toBe("42501");
    expect(await rowsOf(user)).toEqual([]);
  });
});

describe("save_user_tour : cycle d'écriture (§ 11.2, point 2)", () => {
  it("crée active, 0, shown_at posé ; étape 3 (shown_at gardé, updated_at avance) ; pause ; fin (completed_at posé) ; de nouveau active, 0 (completed_at gardé)", async () => {
    const A = await account("cycle");

    // Première ouverture (accueil) : ligne créée
    const created = await save(A, "fleet", "active", 0);
    expect(created).toMatchObject({ tour: "fleet", status: "active", step: 0, completed_at: null });
    expect(created.shown_at).toEqual(expect.any(String));
    const first = (await rowOf(A, "fleet"))!;
    expect(first).toMatchObject({ status: "active", step: 0, completed_at: null });
    expect(first.shown_at).not.toBeNull();
    expect(await sameInstant(created.shown_at, first.shown_at)).toBe(true);
    expect(await sameInstant(first.updated_at, first.shown_at)).toBe(true);

    // Étape 3 : shown_at inchangé, updated_at avance
    await tick();
    const moved = await save(A, "fleet", "active", 3);
    expect(moved).toMatchObject({ tour: "fleet", status: "active", step: 3, completed_at: null });
    const second = (await rowOf(A, "fleet"))!;
    expect(second).toMatchObject({ status: "active", step: 3, shown_at: first.shown_at, completed_at: null });
    expect(await isAfter(first.updated_at, second.updated_at)).toBe(true);

    // « × » ou « Plus tard » : en pause, à la même étape
    await tick();
    expect(await save(A, "fleet", "paused", 3)).toMatchObject({ status: "paused", step: 3, completed_at: null });
    const paused = (await rowOf(A, "fleet"))!;
    expect(paused).toMatchObject({ status: "paused", step: 3, shown_at: first.shown_at, completed_at: null });
    expect(await isAfter(second.updated_at, paused.updated_at)).toBe(true);

    // « Terminer » : completed_at posé
    await tick();
    const finished = await save(A, "fleet", "completed", 4);
    expect(finished).toMatchObject({ status: "completed", step: 4 });
    expect(finished.completed_at).toEqual(expect.any(String));
    const done = (await rowOf(A, "fleet"))!;
    expect(done).toMatchObject({ status: "completed", step: 4, shown_at: first.shown_at });
    expect(done.completed_at).not.toBeNull();
    expect(await isAfter(paused.updated_at, done.completed_at!)).toBe(true);

    // « Revoir la visite » : de nouveau active, 0 ; première fin gardée
    await tick();
    expect(await save(A, "fleet", "active", 0)).toMatchObject({ status: "active", step: 0 });
    const replay = (await rowOf(A, "fleet"))!;
    expect(replay).toMatchObject({ status: "active", step: 0, shown_at: first.shown_at, completed_at: done.completed_at });
    expect(await isAfter(done.updated_at, replay.updated_at)).toBe(true);

    // Seconde fin : la première date de fin reste
    await tick();
    await save(A, "fleet", "completed", 4);
    expect(await rowOf(A, "fleet")).toMatchObject({ status: "completed", shown_at: first.shown_at, completed_at: done.completed_at });

    // Un parcours = une ligne, sans toucher aux autres
    expect((await rowsOf(A)).map((r) => r.tour)).toEqual(["fleet"]);
  });

  it("accepte chaque parcours, chaque état et chaque étape de @rydar/shared (TOUR_KEYS, TOUR_STATUSES, TOUR_MAX_STEPS)", async () => {
    const A = await account("valeurs");
    for (const tour of TOUR_KEYS) {
      for (const status of TOUR_STATUSES) {
        for (let step = 0; step < TOUR_MAX_STEPS; step++) {
          expect(await save(A, tour, status, step), `${tour} ${status} ${step}`).toMatchObject({ tour, status, step });
        }
      }
    }
    expect((await rowsOf(A)).map((r) => r.tour)).toEqual([...TOUR_KEYS].sort());
  });

  it("première écriture déjà terminée : shown_at et completed_at posés ensemble", async () => {
    const A = await account("fin-directe");
    const r = await save(A, "dispatcher", "completed", 4);
    expect(r.completed_at).toEqual(expect.any(String));
    expect(await sameInstant(r.shown_at, r.completed_at)).toBe(true);
  });
});

describe("Isolation entre comptes (§ 11.2, point 3)", () => {
  it("A ne lit que ses lignes, B que les siennes ; B ne peut pas écrire pour A (aucun paramètre d'utilisateur)", async () => {
    const A = await account("iso-a");
    const B = await account("iso-b");
    await save(A, "fleet", "active", 2);
    await save(A, "dispatcher", "paused", 1);
    await save(B, "fleet", "active", 0);
    const before = await rowOf(A, "fleet");

    const seenByA = await as({ sub: A }, (q) => q(`select * from public.user_tours order by tour`));
    expect(seenByA.map((r) => [r.user_id, r.tour])).toEqual([[A, "dispatcher"], [A, "fleet"]]);
    const seenByB = await as({ sub: B }, (q) => q(`select * from public.user_tours`));
    expect(seenByB.map((r) => [r.user_id, r.tour])).toEqual([[B, "fleet"]]);
    // Même en visant A explicitement
    expect(await as({ sub: B }, (q) => q(`select * from public.user_tours where user_id = $1`, [A]))).toEqual([]);

    // B écrit « fleet » : sa propre ligne seulement ; celle de A est intacte
    await tick();
    await save(B, "fleet", "completed", 4);
    expect(await rowOf(A, "fleet")).toEqual(before);
    expect(await rowOf(B, "fleet")).toMatchObject({ status: "completed", step: 4 });

    // La RPC ne reçoit jamais d'identifiant d'utilisateur : parcours, état, étape
    const [fn] = await sql(`select pg_get_function_identity_arguments($1::regprocedure) as args`, [SAVE]);
    expect(fn.args).toBe("p_tour text, p_status text, p_step integer");
  });
});

describe("Écritures directes et anon (§ 11.2, points 4 et 5)", () => {
  it("authenticated : insert, update, delete et truncate directs refusés (42501), ligne intacte", async () => {
    const A = await account("direct");
    await save(A, "centrale", "active", 1);
    const before = await rowOf(A, "centrale");
    for (const statement of [
      [`insert into public.user_tours (user_id, tour, status, step) values ($1, 'fleet', 'completed', 4)`, [A]],
      [`update public.user_tours set status = 'completed', step = 4 where user_id = $1`, [A]],
      [`update public.user_tours set user_id = gen_random_uuid() where user_id = $1`, [A]],
      [`delete from public.user_tours where user_id = $1`, [A]],
      [`truncate public.user_tours`, []],
    ] as const) {
      const e = await expectPgError(as({ sub: A }, (q) => q(statement[0], [...statement[1]])));
      expect(e.code, statement[0]).toBe("42501");
    }
    expect(await rowsOf(A)).toEqual([before]);
  });

  it("anon : lecture de la table et appel de la RPC refusés (42501), même avec un sub", async () => {
    const A = await account("anon");
    await save(A, "fleet", "active", 0);
    for (const who of [{ role: "anon" as const }, { role: "anon" as const, sub: A }]) {
      const read = await expectPgError(as(who, (q) => q(`select * from public.user_tours`)));
      expect(read.code).toBe("42501");
      const call = await expectPgError(as(who, (q) => q(`select public.save_user_tour('fleet', 'completed', 4)`)));
      expect(call.code).toBe("42501");
    }
    expect(await rowOf(A, "fleet")).toMatchObject({ status: "active", step: 0 });
  });
});

describe("Sans utilisateur et valeurs invalides (§ 11.2, points 6 et 7)", () => {
  it("authenticated sans sub (auth.uid() nul) → FORBIDDEN 42501 ; service role (aucun utilisateur) aussi", async () => {
    const before = (await sql(`select count(*)::int as n from public.user_tours`))[0].n as number;
    for (const role of ["authenticated", "service_role"] as const) {
      const e = await expectPgError(as({ role }, (q) => q(`select public.save_user_tour('fleet', 'active', 0)`)));
      expect(e.code, role).toBe("42501");
      expect(e.message, role).toMatch(/^FORBIDDEN/);
    }
    expect((await sql(`select count(*)::int as n from public.user_tours`))[0].n).toBe(before);
  });

  it("parcours inconnu, état inconnu, étape −1 ou 5 → 23514 ; valeur nulle → 23502 ; étape hors smallint → 22003 ; rien d'écrit", async () => {
    const A = await account("invalide");
    for (const [tour, status, step, code] of [
      ["admin", "active", 0, "23514"],
      ["", "active", 0, "23514"],
      ["fleet", "done", 0, "23514"],
      ["fleet", "ACTIVE", 0, "23514"],
      ["fleet", "active", -1, "23514"],
      ["fleet", "active", 5, "23514"],
      [null, "active", 0, "23502"],
      ["fleet", null, 0, "23502"],
      ["fleet", "active", null, "23502"],
      ["fleet", "active", 40_000, "22003"],
    ] as const) {
      const e = await expectPgError(save(A, tour, status, step));
      expect(e.code, `${tour} ${status} ${step}`).toBe(code);
    }
    expect(await rowsOf(A)).toEqual([]);

    // Ligne existante : une écriture invalide ne la modifie pas
    await save(A, "fleet", "active", 2);
    const before = await rowOf(A, "fleet");
    expect((await expectPgError(save(A, "fleet", "archived", 2))).code).toBe("23514");
    expect((await expectPgError(save(A, "fleet", "active", 5))).code).toBe("23514");
    expect((await expectPgError(save(A, "fleet", null, 2))).code).toBe("23502");
    expect(await rowsOf(A)).toEqual([before]);
  });
});

describe("Suppression du compte (§ 11.2, point 8)", () => {
  it("delete from auth.users → lignes effacées (cascade par public.users)", async () => {
    const C = await account("cascade");
    await save(C, "fleet", "completed", 4);
    await save(C, "dispatcher", "active", 1);
    expect(await rowsOf(C)).toHaveLength(2);
    await sql(`delete from auth.users where id = $1`, [C]);
    expect(await sql(`select 1 from public.users where id = $1`, [C])).toEqual([]);
    expect(await rowsOf(C)).toEqual([]);
  });

  it("la cascade ne demande aucun droit sur user_tours à qui supprime le compte (service role, sans droit sur la table)", async () => {
    const D = await account("cascade-svc");
    await save(D, "centrale", "paused", 2);
    const client = await pool.connect();
    try {
      await client.query("begin");
      // Le temps de la transaction (annulée) : le service role peut supprimer un compte Auth, comme l'API d'Auth
      await client.query("grant select, delete on auth.users to service_role");
      await client.query("set local role service_role");
      const denied = await client.query("select has_table_privilege('public.user_tours', 'DELETE') as d");
      expect(denied.rows[0].d).toBe(false);
      await client.query("delete from auth.users where id = $1", [D]);
      await client.query("reset role");
      const left = await client.query("select count(*)::int as n from public.user_tours where user_id = $1", [D]);
      expect(left.rows[0].n).toBe(0);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
    // Transaction annulée : compte, lignes et droits d'avant
    expect(await rowsOf(D)).toHaveLength(1);
    expect((await sql(`select has_table_privilege('service_role', 'auth.users', 'DELETE') as d`))[0].d).toBe(false);
  });
});

describe("Fonction save_user_tour (§ 11.2, point 9)", () => {
  it("security definer, search_path vide, jsonb ; EXECUTE : authenticated oui, anon et PUBLIC non", async () => {
    const fns = await sql(
      `select p.prosecdef, 'search_path=""' = any (p.proconfig) as empty_path, pg_get_function_result(p.oid) as result,
              pg_get_function_identity_arguments(p.oid) as args,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'save_user_tour'`,
    );
    expect(fns).toEqual([
      {
        prosecdef: true,
        empty_path: true,
        result: "jsonb",
        args: "p_tour text, p_status text, p_step integer",
        anon: false,
        auth: true,
        public_execute: false,
      },
    ]);
  });
});

describe("Rattrapage des comptes existants (§ 11.2, point 10)", () => {
  it("bloc « rattrapage » de la migration rejoué : super admin et membres → 5 parcours en pause, jamais ouverts ; autres comptes : rien ; ligne existante gardée", async () => {
    const text = readFileSync(MIGRATION, "utf8");
    const start = text.indexOf("-- rattrapage : début");
    const end = text.indexOf("-- rattrapage : fin");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = text.slice(start, end);
    expect(block).toContain("insert into public.user_tours");

    const sa = await superAdmin(); // sans adhésion
    const org = await createOrg(`Visite ${randomUUID().slice(0, 6)}`);
    const dispatcher = await createMember(org, "dispatcher");
    const invited = await account("invite");
    await sql(`insert into public.organization_users (organization_id, user_id, role, status) values ($1, $2, 'admin', 'invited')`, [org.id, invited]);
    const plain = await account("sans-role"); // ni super admin ni membre
    const driver = await createDriver(org); // compte chauffeur, sans adhésion
    // Compte qui a déjà fini une visite : sa ligne ne bouge pas
    const other = await createOrg(`Visite finie ${randomUUID().slice(0, 6)}`);
    await save(other.ownerId, "fleet", "active", 0);
    await save(other.ownerId, "fleet", "completed", 4);
    const finished = (await rowOf(other.ownerId, "fleet"))!;
    expect(finished.status).toBe("completed");

    await tick();
    await sql(block);

    const pausedNeverShown = (rows: Row[]) =>
      rows.map((r) => ({ tour: r.tour, status: r.status, step: r.step, shown_at: r.shown_at, completed_at: r.completed_at }));
    const fresh = [...TOUR_KEYS].sort().map((tour) => ({ tour, status: "paused", step: 0, shown_at: null, completed_at: null }));
    for (const [label, user] of [["super admin", sa], ["propriétaire", org.ownerId], ["dispatcher", dispatcher], ["invité", invited]] as const) {
      expect(pausedNeverShown(await rowsOf(user)), label).toEqual(fresh);
    }
    expect(await rowsOf(plain)).toEqual([]);
    expect(await rowsOf(driver.userId)).toEqual([]);
    const kept = await rowsOf(other.ownerId);
    expect(kept.find((r) => r.tour === "fleet")).toEqual(finished);
    expect(pausedNeverShown(kept.filter((r) => r.tour !== "fleet"))).toEqual(fresh.filter((r) => r.tour !== "fleet"));

    // Rejouable : rien de plus, rien de changé
    const count = async () => (await sql(`select count(*)::int as n from public.user_tours`))[0].n as number;
    const all = async () =>
      sql(`select user_id, tour, status, step, shown_at::text, completed_at::text, updated_at::text from public.user_tours order by user_id, tour`);
    const [n, snapshot] = [await count(), await all()];
    await sql(block);
    expect(await count()).toBe(n);
    expect(await all()).toEqual(snapshot);
  });
});
