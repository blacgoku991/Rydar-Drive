// Visite guidée (docs/TUTORIEL.md § 8) : conditions de réussite des étapes, lues en base avec le client du navigateur
// (RLS de l'utilisateur : aucune lecture qu'il ne pourrait pas faire lui-même), en parallèle et seulement pour les clés
// du parcours. Comptages en `head` (aucune ligne transférée) ; une lecture en erreur laisse sa clé absente
// (« inconnue » : pas de « C'est fait. », le bouton principal reste celui de l'action). Rien n'est gardé ni envoyé
// ailleurs. Règles pures testées (tour-checks.test.ts) ; « Éditeur » et « Identité de votre entreprise » reprennent les
// règles existantes (« À traiter » du super admin, pastille « À compléter » des Réglages) : une seule source de vérité.
import { bookingOperatorGaps, type BookingOperatorIdentity } from "@rydar/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminLegalTodo } from "../admin/admin-todo";
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

/** Moyens de paiement des chauffeurs (organization_settings, « Commission & encaissement »). */
export type SettlementSettings = {
  settlement_methods?: readonly string[] | null;
  settlement_link?: string | null;
  settlement_iban?: string | null;
  settlement_instructions?: string | null;
};

/**
 * Commission réglable par les chauffeurs : un moyen proposé est utilisable — lien de paiement renseigné, virement avec
 * IBAN (ou consignes, réglages antérieurs), autre moyen décrit : même règle que la base
 * (private.settlement_methods_available, 20260924003800) —, ou espèces seules choisies. Réglage par défaut (« lien +
 * espèces » sans lien) ou ligne absente : non.
 */
export function settlementReady(s: SettlementSettings | null | undefined): boolean {
  const methods = s?.settlement_methods ?? [];
  const usable = methods.some((m) =>
    m === "link" ? !!s?.settlement_link : m === "transfer" ? !!(s?.settlement_iban || s?.settlement_instructions) : m === "other" ? !!s?.settlement_instructions : false,
  );
  return usable || (methods.length > 0 && methods.every((m) => m === "cash"));
}

/** Coordonnées de paiement de Rydar renseignées : IBAN ou lien de paiement (même règle que la carte BillingCard). */
export function billingConfigured(b: { iban?: string | null; payment_link?: string | null } | null | undefined): boolean {
  return !!(b?.iban || b?.payment_link);
}

/** Réponse d'une lecture (supabase-js) : seuls `count`, `data` et `error` servent. */
type Reply = { data?: unknown; error?: unknown; count?: number | null };

/** Nombre de lignes (comptage `head`) ; erreur ou nombre absent : inconnu. */
async function counted(query: PromiseLike<Reply>, min: number): Promise<boolean | undefined> {
  const { count, error } = await query;
  return error || typeof count !== "number" ? undefined : count >= min;
}

/** Ligne unique (maybeSingle) jugée par une règle ; erreur : inconnu ; aucune ligne : la règle reçoit null. */
async function judged<T>(query: PromiseLike<Reply>, rule: (row: T | null) => boolean): Promise<boolean | undefined> {
  const { data, error } = await query;
  return error ? undefined : rule((data ?? null) as T | null);
}

const HEAD = { count: "exact", head: true } as const;

type Reader = (db: SupabaseClient, scope: TourScope) => Promise<boolean | undefined> | undefined;

/** Lecture de chaque clé (§ 8). Une clé qui a besoin d'une organisation, d'un compte ou d'une fiche absents : inconnue. */
const READERS: Record<CheckKey, Reader> = {
  // Super admin (RLS : super admin seul) : même règle que la ligne « Informations légales » de « À traiter »
  legal_editor: (db) =>
    judged<{ company_name: string | null; address: string | null; registration: string | null }>(
      db.from("platform_legal").select("company_name, address, registration").maybeSingle(),
      (editor) => adminLegalTodo({ error: null, editor, missingNotices: 0 })?.editorMissing === false,
    ),
  platform_billing: (db) => judged(db.from("platform_billing").select("iban, payment_link").maybeSingle(), billingConfigured),
  plans: (db) => counted(db.from("plans").select("id", HEAD).eq("is_active", true), 1),
  clients: (db) => counted(db.from("organizations").select("id", HEAD).neq("status", "archived"), 1),
  // Organisation de l'espace (RLS : membre ; organisations : colonnes accordées, 004300)
  org_identity: (db, { orgId }) =>
    orgId
      ? judged<BookingOperatorIdentity>(
          db.from("organizations").select("legal_name, siret, address, postal_code, city, vtc_registration").eq("id", orgId).maybeSingle(),
          (org) => bookingOperatorGaps(org).length === 0,
        )
      : undefined,
  pricing: (db, { orgId }) => (orgId ? counted(db.from("pricing_rules").select("id", HEAD).eq("organization_id", orgId).eq("is_active", true), 1) : undefined),
  drivers: (db, { orgId }) => (orgId ? counted(db.from("drivers").select("id", HEAD).eq("organization_id", orgId).is("deleted_at", null), 1) : undefined),
  join_link: (db, { orgId }) =>
    orgId
      ? judged<{ join_code: string | null; join_enabled: boolean | null }>(
          db.from("organizations").select("join_code, join_enabled").eq("id", orgId).maybeSingle(),
          (org) => !!org?.join_code && org.join_enabled === true,
        )
      : undefined,
  settlement: (db, { orgId }) =>
    orgId
      ? judged<SettlementSettings>(
          db
            .from("organization_settings")
            .select("settlement_methods, settlement_link, settlement_iban, settlement_instructions")
            .eq("organization_id", orgId)
            .maybeSingle(),
          settlementReady,
        )
      : undefined,
  first_ride: (db, { orgId }) => (orgId ? counted(db.from("rides").select("id", HEAD).eq("organization_id", orgId), 1) : undefined),
  // Le gérant et au moins une autre personne (invitation comprise)
  team: (db, { orgId }) => (orgId ? counted(db.from("organization_users").select("id", HEAD).eq("organization_id", orgId), 2) : undefined),
  // Courses créées par l'utilisateur (created_by posé par le déclencheur d'insertion, 000400)
  my_ride: (db, { orgId, userId }) =>
    orgId && userId ? counted(db.from("rides").select("id", HEAD).eq("organization_id", orgId).eq("created_by", userId), 1) : undefined,
  my_ride_assigned: (db, { orgId, userId }) =>
    orgId && userId
      ? counted(db.from("rides").select("id", HEAD).eq("organization_id", orgId).eq("created_by", userId).not("driver_id", "is", null), 1)
      : undefined,
  // Flotte Privée : réservation prise par le propriétaire (« Je la prends », « Confirmer », réservation par téléphone)
  fp_taken: (db, { orgId, driverId }) =>
    orgId && driverId ? counted(db.from("rides").select("id", HEAD).eq("organization_id", orgId).eq("driver_id", driverId), 1) : undefined,
};

/**
 * Lectures des conditions demandées (§ 8), en parallèle, une par clé (sans doublon). Ne lève jamais : une lecture en
 * erreur (ou impossible : organisation, compte ou fiche absents) laisse sa clé absente.
 */
export async function loadTourChecks(client: SupabaseClient, keys: readonly CheckKey[], scope: TourScope): Promise<TourChecks> {
  const wanted = [...new Set(keys)].filter((key): key is CheckKey => Object.hasOwn(READERS, key));
  const results = await Promise.all(
    wanted.map(async (key) => {
      try {
        return [key, await READERS[key](client, scope)] as const;
      } catch {
        return [key, undefined] as const;
      }
    }),
  );
  const checks: TourChecks = {};
  for (const [key, value] of results) if (typeof value === "boolean") checks[key] = value;
  return checks;
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
