import { extractErrorCode, humanizeError } from "@rydar/shared";

type PgLikeError = { code?: string; message?: string; details?: string; hint?: string } | null | undefined;

/** Traduit une erreur PostgREST/PostgreSQL en statut HTTP + message FR. */
export function httpFromPgError(error: PgLikeError): { status: number; code: string; message: string } {
  const code = extractErrorCode(error?.message) ?? error?.code ?? "UNKNOWN";
  if (error?.code === "42501" || code.startsWith("FORBIDDEN")) return { status: 403, code: "FORBIDDEN", message: "Accès refusé." };
  if (error?.code === "PGRST116") return { status: 404, code: "NOT_FOUND", message: "Ressource introuvable." };
  if (code.startsWith("PLAN_")) return { status: 402, code, message: humanizeError(error?.message) };
  if (error?.code === "23505") return { status: 409, code: "CONFLICT", message: "Cette valeur existe déjà." };
  if (error?.code === "23514" || error?.code === "22023" || error?.code === "22P02")
    return { status: 422, code, message: humanizeError(error?.message, "Données invalides.") };
  return { status: 500, code: "INTERNAL", message: "Une erreur est survenue." };
}

export function actionError(error: PgLikeError, fallback = "Une erreur est survenue.") {
  const mapped = httpFromPgError(error);
  return mapped.status === 500 ? fallback : mapped.message;
}
