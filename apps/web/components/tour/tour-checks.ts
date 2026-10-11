// Visite guidée (docs/TUTORIEL.md § 8) : conditions de réussite des étapes, lues en base avec le client du navigateur
// (RLS de l'utilisateur), en parallèle et seulement pour les clés du parcours. Lot T2 : types et squelette — toutes les
// clés « inconnues » (aucune lecture : pas de « C'est fait. », le bouton principal reste celui de l'action) ; les
// lectures du § 8 et leurs règles pures arrivent au lot T3 (tour-checks.test.ts).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TourScope } from "./tour-model";

/** Clés des conditions de réussite (§ 8), une lecture chacune. */
export const CHECK_KEYS = [
  "legal_editor",
  "platform_billing",
  "plans",
  "clients",
  "org_identity",
  "pricing",
  "drivers",
  "join_link",
  "settlement",
  "first_ride",
  "team",
  "my_ride",
  "my_ride_assigned",
  "fp_taken",
] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];

/** Résultat des lectures : clé absente = inconnue (lecture en erreur, ou pas encore lue). */
export type TourChecks = Partial<Record<CheckKey, boolean>>;

/** Condition d'une étape : faite si l'une des clés est vraie (« drivers » ou « join_link », par exemple). */
export type StepCheck = { any: readonly CheckKey[] };

/**
 * Lectures des conditions demandées (§ 8). T2 : aucune lecture, tout inconnu ({}). Ne lève jamais : une lecture en
 * erreur laisse sa clé absente.
 */
export async function loadTourChecks(_client: SupabaseClient, _keys: readonly CheckKey[], _scope: TourScope): Promise<TourChecks> {
  return {};
}

/**
 * Étape faite ? `undefined` sans condition ou si toutes ses clés sont inconnues ; `true` si l'une est vraie ; sinon
 * `false` (§ 8).
 */
export function stepDone(check: StepCheck | null | undefined, checks: TourChecks): boolean | undefined {
  if (!check || check.any.length === 0) return undefined;
  const known = check.any.filter((key) => checks[key] !== undefined);
  if (known.length === 0) return undefined;
  return known.some((key) => checks[key] === true);
}
