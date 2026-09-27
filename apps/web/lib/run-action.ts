import { unstable_isUnrecognizedActionError, unstable_rethrow } from "next/navigation";
import { toast } from "sonner";

/** Action serveur introuvable : la page a été chargée avant un déploiement (identifiants d'actions changés). */
export const ACTION_OUTDATED_MESSAGE = "Nouvelle version disponible : rechargez la page.";
/** Toute autre exception (réseau coupé, erreur serveur inattendue) : rien ne dit que l'action a abouti. */
export const ACTION_FAILED_MESSAGE = "L'action n'a pas abouti : vérifiez votre connexion et réessayez.";

/** Message à afficher quand l'appel d'une action serveur LÈVE (réponse { ok: false } exclue : elle a son propre message). */
export function actionFailureMessage(error: unknown): string {
  return unstable_isUnrecognizedActionError(error) ? ACTION_OUTDATED_MESSAGE : ACTION_FAILED_MESSAGE;
}

/**
 * Exécute le corps d'une transition qui appelle des actions serveur sans laisser une exception remonter jusqu'à la
 * frontière d'erreur (page remplacée, saisie perdue) : l'échec est signalé par un toast (avec « Recharger » quand
 * l'application a été mise à jour) et la fonction renvoie `undefined`.
 * `redirect()` / `notFound()` d'une action restent gérés par Next (erreurs de navigation relancées).
 *
 *   start(() => runAction(async () => {
 *     const r = await monAction(x);
 *     if (r.ok) router.refresh(); else toast.error(r.error);
 *   }));
 *
 * `onError` remplace le toast (message d'erreur affiché dans un formulaire, par exemple).
 */
export async function runAction<T>(fn: () => Promise<T>, onError?: (message: string) => void): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    unstable_rethrow(error);
    const message = actionFailureMessage(error);
    console.error(error);
    if (onError) onError(message);
    else if (unstable_isUnrecognizedActionError(error))
      toast.error(message, { duration: Infinity, action: { label: "Recharger", onClick: () => window.location.reload() } });
    else toast.error(message);
    return undefined;
  }
}
