import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Contrôle du compte chauffeur après ouverture d'une session Supabase par l'application chauffeur :
 * connexion (/api/auth/driver-login) ou code « mot de passe oublié » (/api/auth/driver-password-reset/confirm).
 * Même ordre de priorité que public.driver_account_state() : banni › centrale suspendue › candidature › statut.
 */

/** Refus (403) : code stable lu par l'application + message FR prêt à afficher. */
export type DriverLoginDenied = "BANNED" | "REJECTED" | "INACTIVE" | "ORGANIZATION_SUSPENDED" | "NOT_DRIVER";
/** Accès accepté : chauffeur actif, ou candidat inscrit par lien en attente de validation (écran d'attente + documents). */
export type DriverLoginState = "active" | "pending";

export const DRIVER_DENIED: Record<DriverLoginDenied, string> = {
  BANNED: "Accès refusé : ce compte a été banni par la centrale.",
  REJECTED: "Votre candidature n'a pas été retenue.",
  INACTIVE: "Compte chauffeur inactif : contactez votre centrale.",
  ORGANIZATION_SUSPENDED: "Votre centrale est suspendue sur Rydar Drive : connexion impossible pour le moment.",
  NOT_DRIVER: "Ce compte n'est pas un compte chauffeur.",
};

/**
 * Fenêtre et clé du compteur « essais de mot de passe par adresse » (anti brute force) : UN seul compteur pour la
 * connexion (/api/auth/driver-login) et la suppression du compte (/api/driver/delete-account), sinon chaque route
 * ajouterait son propre budget d'essais.
 */
export const DRIVER_LOGIN_WINDOW = 15 * 60;
export const driverLoginEmailKey = (email: string) => `dlogin:email:${email}`;
/**
 * Compteur strict par couple (adresse, IP) : un tiers qui connaît l'adresse d'un chauffeur ne bloque plus sa connexion
 * depuis une autre IP ; le compteur par adresse (driverLoginEmailKey) garde un plafond global plus haut.
 */
export const driverLoginPairKey = (email: string, ip: string) => `dloginip:${ip}:${email}`;

/** Compte Auth banni (bannissement plateforme / centrale répercuté sur Supabase Auth). */
export function isAuthBanned(error: { message?: string; code?: string } | null) {
  if (!error) return false;
  return error.code === "user_banned" || /banned/i.test(error.message ?? "");
}

export type DriverAccountCheck =
  | { ok: true; state: DriverLoginState }
  | { ok: false; status: 403; code: DriverLoginDenied; error: string }
  | { ok: false; status: 503; code: "UNAVAILABLE"; error: string };

type DriverRow = {
  id: string;
  status: string;
  application_status: string | null;
  banned_at: string | null;
  /** Compte supprimé par le chauffeur (fiche anonyme conservée pour la comptabilité) */
  deleted_at: string | null;
  organization: { status: string } | { status: string }[] | null;
};

/**
 * État du compte chauffeur d'après sa fiche (client service role), sans toucher à aucune session : accepté, ou refus.
 * Sert aussi quand Supabase Auth refuse la connexion d'un compte banni : le vrai motif (inactif, centrale suspendue…)
 * est donné une fois le mot de passe vérifié.
 */
export async function driverAccountDecision(userId: string): Promise<DriverAccountCheck> {
  const deny = (code: DriverLoginDenied): DriverAccountCheck => ({ ok: false, status: 403, code, error: DRIVER_DENIED[code] });
  const { data: row, error: rowError } = await createAdminClient()
    .from("drivers")
    .select("id, status, application_status, banned_at, deleted_at, organization:organizations(status)")
    .eq("user_id", userId)
    .maybeSingle();
  if (rowError) return { ok: false, status: 503, code: "UNAVAILABLE", error: "Connexion impossible pour le moment. Réessayez." };
  const driver = row as DriverRow | null;
  if (!driver) return deny("NOT_DRIVER");
  // Fiche supprimée (en principe déjà détachée du compte) : jamais d'accès, même « en attente »
  if (driver.deleted_at) return deny("INACTIVE");
  const org = Array.isArray(driver.organization) ? driver.organization[0] : driver.organization;

  if (driver.banned_at) return deny("BANNED");
  if (org?.status !== "active") return deny("ORGANIZATION_SUSPENDED");
  if (driver.application_status === "pending" && (driver.status === "inactive" || driver.status === "active")) return { ok: true, state: "pending" };
  if (driver.application_status === "rejected") return deny("REJECTED");
  if (driver.status === "active") return { ok: true, state: "active" };
  return deny("INACTIVE");
}

/**
 * Fiche chauffeur de l'utilisateur → état accepté, ou refus.
 * En cas de refus ou d'erreur, la session ouverte sur `auth` (client anonyme sans persistance) est révoquée — ELLE
 * SEULE (scope « local ») : les sessions du tableau de bord d'un gérant qui s'est trompé d'application restent ouvertes.
 */
export async function checkDriverAccount(auth: SupabaseClient, userId: string): Promise<DriverAccountCheck> {
  const decision = await driverAccountDecision(userId);
  if (!decision.ok) await auth.auth.signOut({ scope: "local" }).catch(() => undefined);
  return decision;
}
