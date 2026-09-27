// Session Supabase de l'appareil : clé de stockage et déconnexion garantie. Module sans dépendance native (testé
// sous Node : auth-session.test.ts) ; branché sur le client de l'application dans supabase.ts.
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Clé de la session dans le stockage : IDENTIQUE à la clé par défaut de supabase-js (`sb-<ref>-auth-token`), sinon
 * toutes les sessions enregistrées seraient perdues à la mise à jour de l'application (chauffeurs déconnectés).
 */
export function authStorageKey(supabaseUrl: string) {
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
}

/** Stockage de la session (trousseau chiffré sur mobile, localStorage sur le web). */
export type SessionStorage = { removeItem(key: string): unknown };

/**
 * Déconnexion de CET appareil, garantie même hors réseau avec un jeton expiré : supabase-js renvoie alors une erreur
 * SANS effacer la session (renouvellement impossible), sans SIGNED_OUT, et la rouvre au retour du réseau. Dans ce
 * cas, la session est effacée du stockage, puis un signOut local (plus rien à renouveler) émet SIGNED_OUT.
 * `scope` : portée de la première tentative (« global » : toutes les sessions du compte ; « local » : cet appareil).
 * true : plus aucune session sur l'appareil ; false : effacement impossible (stockage indisponible).
 */
export async function signOutDevice(
  auth: Pick<SupabaseClient["auth"], "signOut">,
  storage: SessionStorage | undefined,
  key: string,
  scope: "global" | "local" = "global",
): Promise<boolean> {
  const first = await auth.signOut({ scope }).catch((e: unknown) => ({ error: e }));
  if (!first.error) return true;
  try {
    await storage?.removeItem(key);
  } catch {
    /* vérifié par le signOut local : session encore lisible → erreur */
  }
  const local = await auth.signOut({ scope: "local" }).catch((e: unknown) => ({ error: e }));
  return !local.error;
}
