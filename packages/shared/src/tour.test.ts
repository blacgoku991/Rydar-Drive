// Visite guidée (docs/TUTORIEL.md § 4.4, § 11.1) : parcours, états et nombre d'étapes = contraintes de public.user_tours
// (migration 20260924007800, lue ici), parcours d'un membre (§ 5.1), schéma de l'écriture, lecture de la progression.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OrgRole } from "./domain";
import type { DispatchModel } from "./types";
import {
  TOUR_KEYS, TOUR_MAX_STEPS, TOUR_STATUSES, tourKeyFor, tourProgressSchema, tourSavedFrom, type TourKey,
} from "./tour";
import * as shared from "./index";

const MIGRATION = fileURLToPath(new URL("../../../supabase/migrations/20260924007800_guided_tour.sql", import.meta.url));
const sql = readFileSync(MIGRATION, "utf8");

/** Littéraux « 'x' » d'un extrait SQL, dans l'ordre. */
const literals = (text: string) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

describe("SQL (20260924007800_guided_tour) = @rydar/shared", () => {
  it("TOUR_KEYS = check (tour in (…)) ; TOUR_STATUSES = check (status in (…)) ; TOUR_MAX_STEPS - 1 = check (step between 0 and N)", () => {
    const tour = /check \(tour in \(([^)]*)\)\)/.exec(sql);
    const status = /check \(status in \(([^)]*)\)\)/.exec(sql);
    const step = /check \(step between 0 and (\d+)\)/.exec(sql);
    expect(tour && literals(tour[1]!)).toEqual([...TOUR_KEYS]);
    expect(status && literals(status[1]!)).toEqual([...TOUR_STATUSES]);
    expect(step && Number(step[1])).toBe(TOUR_MAX_STEPS - 1);
    expect(TOUR_MAX_STEPS).toBe(5);
    expect(new Set(TOUR_KEYS).size).toBe(TOUR_KEYS.length);
  });

  it("rattrapage des comptes existants : les 5 parcours, mis en pause, entre ses deux marqueurs", () => {
    const start = sql.indexOf("-- rattrapage : début");
    const end = sql.indexOf("-- rattrapage : fin");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = sql.slice(start, end);
    const values = /cross join \(values ([^;]*?)\) as t \(tour\)/.exec(block);
    expect(values && literals(values[1]!)).toEqual([...TOUR_KEYS]);
    expect(block).toContain("select u.id, t.tour, 'paused', 0");
    expect(block).toContain("on conflict (user_id, tour) do nothing;");
  });

  it("RPC appelée par le web : public.save_user_tour(p_tour text, p_status text, p_step integer)", () => {
    expect(sql).toContain("create or replace function public.save_user_tour(p_tour text, p_status text, p_step integer)");
    expect(sql).toContain("grant execute on function public.save_user_tour(text, text, integer) to authenticated;");
  });
});

describe("tourKeyFor (§ 5.1)", () => {
  const key = (privateFleet: boolean, model: DispatchModel | null | undefined, role: OrgRole) => tourKeyFor({ privateFleet, model, role });

  it("Flotte Privée → private_fleet, quels que soient le rôle et le modèle", () => {
    expect(key(true, "fleet", "owner")).toBe("private_fleet");
    expect(key(true, null, "owner")).toBe("private_fleet");
    expect(key(true, "centrale", "admin")).toBe("private_fleet");
  });

  it("dispatcher → dispatcher, en flotte comme en centrale", () => {
    expect(key(false, "fleet", "dispatcher")).toBe("dispatcher");
    expect(key(false, "centrale", "dispatcher")).toBe("dispatcher");
    expect(key(false, undefined, "dispatcher")).toBe("dispatcher");
  });

  it("propriétaire ou administrateur d'une centrale → centrale", () => {
    expect(key(false, "centrale", "owner")).toBe("centrale");
    expect(key(false, "centrale", "admin")).toBe("centrale");
  });

  it("propriétaire ou administrateur d'une flotte → fleet", () => {
    expect(key(false, "fleet", "owner")).toBe("fleet");
    expect(key(false, "fleet", "admin")).toBe("fleet");
  });

  it("modèle absent → fleet", () => {
    expect(key(false, null, "owner")).toBe("fleet");
    expect(key(false, undefined, "admin")).toBe("fleet");
  });

  it("chaque parcours est atteint : ceux des membres + super_admin (mise en page de /admin) = TOUR_KEYS", () => {
    const reached = new Set<TourKey>(["super_admin"]);
    for (const privateFleet of [true, false])
      for (const model of ["fleet", "centrale", null, undefined] as const)
        for (const role of ["owner", "admin", "dispatcher"] as const) reached.add(key(privateFleet, model, role));
    expect([...reached].sort()).toEqual([...TOUR_KEYS].sort());
  });
});

describe("tourProgressSchema", () => {
  it("accepte chaque parcours, chaque état et les étapes 0 à TOUR_MAX_STEPS - 1", () => {
    for (const tour of TOUR_KEYS)
      for (const status of TOUR_STATUSES)
        for (let step = 0; step < TOUR_MAX_STEPS; step++) {
          expect(tourProgressSchema.safeParse({ tour, status, step }).success, `${tour} ${status} ${step}`).toBe(true);
        }
  });

  it("refuse : parcours inconnu, état inconnu, étape −1, 5, 1,5, texte, non finie ; champ manquant", () => {
    const ok = { tour: "fleet", status: "active", step: 1 };
    for (const bad of [
      { ...ok, tour: "admin" },
      { ...ok, tour: "" },
      { ...ok, status: "done" },
      { ...ok, status: "ACTIVE" },
      { ...ok, step: -1 },
      { ...ok, step: 5 },
      { ...ok, step: 1.5 },
      { ...ok, step: "1" },
      { ...ok, step: Number.NaN },
      { ...ok, step: Number.POSITIVE_INFINITY },
      { tour: "fleet", status: "active" },
      { status: "active", step: 0 },
      { tour: "fleet", step: 0 },
      null,
    ]) {
      expect(tourProgressSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("une clé en plus (identifiant d'utilisateur) est retirée : seuls parcours, état et étape partent vers la RPC", () => {
    const parsed = tourProgressSchema.parse({ tour: "dispatcher", status: "completed", step: 4, user_id: "un-autre-compte" });
    expect(parsed).toEqual({ tour: "dispatcher", status: "completed", step: 4 });
  });
});

describe("tourSavedFrom", () => {
  const row = { status: "active", step: 2, shown_at: "2026-10-11T08:00:00+00:00" };

  it("erreur de lecture → undefined (même avec une ligne)", () => {
    expect(tourSavedFrom(null, { message: "permission denied" })).toBeUndefined();
    expect(tourSavedFrom(undefined, new Error("réseau"))).toBeUndefined();
    expect(tourSavedFrom(row, { code: "42P01" })).toBeUndefined();
  });

  it("aucune ligne → null (visite jamais vue)", () => {
    expect(tourSavedFrom(null, null)).toBeNull();
    expect(tourSavedFrom(undefined, undefined)).toBeNull();
  });

  it("ligne → état, étape et shown (shown_at posé)", () => {
    expect(tourSavedFrom(row, null)).toEqual({ status: "active", step: 2, shown: true });
    expect(tourSavedFrom({ status: "completed", step: 4, shown_at: row.shown_at }, null)).toEqual({ status: "completed", step: 4, shown: true });
  });

  it("compte mis en pause par la migration (shown_at nul) → shown faux", () => {
    expect(tourSavedFrom({ status: "paused", step: 0, shown_at: null }, null)).toEqual({ status: "paused", step: 0, shown: false });
  });

  it("état inconnu → undefined ; étape ramenée de 0 à TOUR_MAX_STEPS - 1 (0 si elle n'est pas entière)", () => {
    expect(tourSavedFrom({ ...row, status: "archived" }, null)).toBeUndefined();
    expect(tourSavedFrom({ ...row, step: 7 }, null)).toEqual({ status: "active", step: TOUR_MAX_STEPS - 1, shown: true });
    expect(tourSavedFrom({ ...row, step: -3 }, null)).toEqual({ status: "active", step: 0, shown: true });
    expect(tourSavedFrom({ ...row, step: 1.5 }, null)).toEqual({ status: "active", step: 0, shown: true });
  });
});

describe("@rydar/shared", () => {
  it("exporte la visite guidée (index.ts)", () => {
    expect(shared.TOUR_KEYS).toBe(TOUR_KEYS);
    expect(shared.TOUR_STATUSES).toBe(TOUR_STATUSES);
    expect(shared.TOUR_MAX_STEPS).toBe(TOUR_MAX_STEPS);
    expect(shared.tourKeyFor).toBe(tourKeyFor);
    expect(shared.tourProgressSchema).toBe(tourProgressSchema);
    expect(shared.tourSavedFrom).toBe(tourSavedFrom);
  });
});
