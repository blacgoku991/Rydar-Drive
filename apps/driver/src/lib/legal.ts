// Conditions d'utilisation et politique de confidentialité de Rydar Drive, acceptées dans l'application par TOUS les
// chauffeurs, y compris ceux créés par une centrale (jamais passés par le formulaire d'inscription), pour la version
// en vigueur (LEGAL_VERSION de @rydar/shared, commune au web). Preuve côté serveur : public.legal_acceptances (compte,
// document, version, date, source « app »), écrite par accept_legal_documents (migration 20260924003900).
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LEGAL_VERSION, legalVersionAccepted, type RpcResult } from "@rydar/shared";
import { ApiError, rpc } from "./api";
import { supabase } from "./supabase";

/** Documents acceptés par le chauffeur : conditions d'utilisation et politique de confidentialité. */
export const DRIVER_LEGAL_DOCUMENTS = ["cgu", "privacy"] as const;

/**
 * accepted : version en vigueur (ou plus récente) acceptée pour chaque document ;
 * pending : acceptation à demander (updated : une version antérieure avait déjà été acceptée) ;
 * unsupported : serveur sans registre des acceptations (migration absente) : rien à demander.
 */
export type TermsStatus = { state: "accepted" } | { state: "pending"; updated: boolean } | { state: "unsupported" };

/** Table inconnue du serveur (PostgREST, Postgres) : serveur antérieur au registre des acceptations. */
const MISSING_TABLE = new Set(["PGRST205", "42P01"]);

/**
 * Acceptations du compte connecté, lues dans le registre (RLS : ses propres lignes, toutes centrales confondues).
 * Erreur (ApiError) : réseau ou serveur injoignable, à relire plus tard.
 */
export async function fetchTermsStatus(userId: string): Promise<TermsStatus> {
  // Filtre explicite sur le compte : un gérant qui conduit lit aussi, par la RLS, les lignes de sa centrale
  const { data, error } = await supabase
    .from("legal_acceptances")
    .select("document, version")
    .eq("user_id", userId)
    .in("document", [...DRIVER_LEGAL_DOCUMENTS]);
  if (error) {
    if (MISSING_TABLE.has(error.code)) return { state: "unsupported" };
    throw new ApiError("Connexion impossible. Réessayez.", null);
  }
  // Dernière version acceptée par document (inscription par lien, application, fil « Chauffeurs »)
  const latest = new Map<string, string>();
  for (const row of (data ?? []) as { document: string; version: string }[]) {
    const previous = latest.get(row.document);
    if (!previous || row.version > previous) latest.set(row.document, row.version);
  }
  if (DRIVER_LEGAL_DOCUMENTS.every((doc) => legalVersionAccepted(latest.get(doc)))) return { state: "accepted" };
  return { state: "pending", updated: [...latest.values()].some((v) => !legalVersionAccepted(v)) };
}

/**
 * « J'accepte » : les deux documents, version en vigueur (idempotent côté serveur : la première acceptation et sa
 * date sont gardées). Erreur : ApiError, code null pour le réseau ou un incident passager (isTransientError).
 */
export async function acceptTerms(): Promise<void> {
  const res = await rpc<RpcResult | null>("accept_legal_documents", {
    p_documents: [...DRIVER_LEGAL_DOCUMENTS],
    p_version: LEGAL_VERSION,
    p_org: null,
    p_source: "app",
  });
  if (!res?.ok) throw new ApiError(res?.message ?? "Acceptation impossible. Réessayez.", res?.code || "REFUSED");
}

/** Échec sans refus du serveur (réseau coupé, serveur injoignable, jeton à renouveler) : à renvoyer plus tard. */
export const isTransientError = (e: unknown) => !(e instanceof ApiError) || e.code == null;

// ---------------------------------------------------------------- acceptation hors connexion

const localKey = (userId: string) => `rydar.driver.legalAccepted.${userId}`;

/** « J'accepte » touché sans réseau : acceptation gardée sur le téléphone, envoyée dès que possible. */
export async function rememberLocalAcceptance(userId: string) {
  await AsyncStorage.setItem(localKey(userId), LEGAL_VERSION).catch(() => null);
}

/** Acceptation de la version en vigueur gardée sur le téléphone, pas encore reçue par le serveur. */
export async function hasLocalAcceptance(userId: string) {
  return legalVersionAccepted(await AsyncStorage.getItem(localKey(userId)).catch(() => null));
}

export async function forgetLocalAcceptance(userId: string) {
  await AsyncStorage.removeItem(localKey(userId)).catch(() => null);
}

// ---------------------------------------------------------------- état de la session

/** Compte dont l'acceptation de la version en vigueur est confirmée par le serveur dans cette session. */
let acceptedUserId: string | null = null;

export function markTermsAccepted(userId: string) {
  acceptedUserId = userId;
}

/**
 * CGU et politique acceptées (version en vigueur), d'après le registre lu ou « J'accepte » dans cette session. Les
 * règles du fil « Chauffeurs » (CGU § 8) le sont alors aussi, même avant la lecture de la messagerie.
 */
export function termsAcceptedFor(userId: string | null | undefined) {
  return !!userId && userId === acceptedUserId;
}
