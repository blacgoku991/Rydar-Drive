// Visite guidée de première connexion (docs/TUTORIEL.md, migration 20260924007800_guided_tour) : parcours, états et
// nombre d'étapes (contraintes de public.user_tours, comparées par tour.test.ts), schéma de l'écriture par
// save_user_tour, choix du parcours d'un membre et lecture de la progression par les mises en page du web. Web
// seulement : rien n'est importé par l'application chauffeur.
import { z } from "./zod";
import type { OrgRole } from "./domain";
import type { DispatchModel } from "./types";

/** Parcours (public.user_tours.tour), un par profil ; jamais affichés à l'écran (docs/TUTORIEL.md § 2). */
export const TOUR_KEYS = ["super_admin", "fleet", "centrale", "dispatcher", "private_fleet"] as const;
export type TourKey = (typeof TOUR_KEYS)[number];
/** active : visite en cours ; paused : fermée ou « Plus tard » ; completed : terminée (public.user_tours.status). */
export const TOUR_STATUSES = ["active", "paused", "completed"] as const;
export type TourStatus = (typeof TOUR_STATUSES)[number];
/** Étapes au plus par parcours (contrainte step between 0 and 4 de public.user_tours) */
export const TOUR_MAX_STEPS = 5;

/**
 * Progression envoyée à save_user_tour par l'action serveur du web (valeurs posées par le code, jamais saisies) :
 * parcours, état, étape de 0 à TOUR_MAX_STEPS - 1. Une clé en plus (un identifiant d'utilisateur, par exemple) est
 * retirée : la RPC écrit toujours pour l'utilisateur connecté.
 */
export const tourProgressSchema = z.object({
  tour: z.enum(TOUR_KEYS),
  status: z.enum(TOUR_STATUSES),
  step: z.number().int().min(0).max(TOUR_MAX_STEPS - 1),
});
export type TourProgress = z.output<typeof tourProgressSchema>;

/**
 * Parcours d'un membre dans son espace (docs/TUTORIEL.md § 5.1) : Flotte Privée d'abord, puis dispatcher (flotte ou
 * centrale), puis propriétaire ou administrateur selon le modèle (centrale ; flotte, ou modèle absent). Le parcours
 * « super_admin » est posé par la mise en page de /admin.
 */
export function tourKeyFor(i: { privateFleet: boolean; model: DispatchModel | null | undefined; role: OrgRole }): TourKey {
  if (i.privateFleet) return "private_fleet";
  if (i.role === "dispatcher") return "dispatcher";
  return i.model === "centrale" ? "centrale" : "fleet";
}

/** Ligne lue par une mise en page → progression : undefined = lecture impossible ; null = jamais vue. */
export type TourSaved = { status: TourStatus; step: number; shown: boolean };

const isTourStatus = (value: unknown): value is TourStatus => (TOUR_STATUSES as readonly unknown[]).includes(value);

/**
 * Ligne de public.user_tours lue par une mise en page (`status, step, shown_at`, `maybeSingle()`) → progression :
 * - `undefined` : lecture impossible (erreur, ou état inconnu : jamais d'ouverture d'office sur une ligne illisible) ;
 * - `null` : aucune ligne, visite jamais vue (ouverture d'office de l'accueil) ;
 * - sinon l'état, l'étape ramenée de 0 à TOUR_MAX_STEPS - 1 (0 si elle n'est pas entière) et `shown` (shown_at posé :
 *   visite déjà ouverte ; nul pour un compte mis en pause par la migration, à qui « Reprendre » montre l'accueil).
 */
export function tourSavedFrom(
  row: { status: string; step: number; shown_at: string | null } | null | undefined,
  error: unknown,
): TourSaved | null | undefined {
  if (error) return undefined;
  if (!row) return null;
  if (!isTourStatus(row.status)) return undefined;
  const step = Number.isInteger(row.step) ? Math.min(Math.max(row.step, 0), TOUR_MAX_STEPS - 1) : 0;
  return { status: row.status, step, shown: row.shown_at != null };
}
