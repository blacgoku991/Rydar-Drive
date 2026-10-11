"use server";
// Visite guidée (docs/TUTORIEL.md § 4.3) : enregistre la progression de l'utilisateur connecté (save_user_tour, RLS).
// Valeurs posées par le moteur (jamais saisies), contrôlées par le schéma partagé puis par la base ; la RPC écrit
// toujours pour l'utilisateur connecté (aucun identifiant reçu). Préférence d'interface : ni audit, ni revalidatePath
// (rien d'affiché par le serveur n'en dépend après le premier rendu). Emplacement neutre (aucune page) : sert aux deux
// espaces, comme app/login/actions.ts.
import { tourProgressSchema } from "@rydar/shared";
import { requireUser } from "@/lib/auth";
import { actionError } from "@/lib/errors";

export async function saveTourProgress(input: { tour: string; status: string; step: number }): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = tourProgressSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Visite guidée : étape inconnue." };
  const session = await requireUser();
  const { tour, status, step } = parsed.data;
  const { error } = await session.supabase.rpc("save_user_tour", { p_tour: tour, p_status: status, p_step: step });
  if (error) return { ok: false, error: actionError(error, "Progression de la visite non enregistrée.") };
  return { ok: true };
}
