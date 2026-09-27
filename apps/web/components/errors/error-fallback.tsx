"use client";
import { RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import { unstable_isUnrecognizedActionError } from "next/navigation";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Contenu des frontières d'erreur (error.tsx, global-error.tsx). Neutre (pas de logo) : il s'affiche aussi sur les pages
 * en marque blanche des centrales (mini-site, lien d'inscription).
 * - « Réessayer » : `retry()` de Next (recharge le segment côté serveur, la mise en page autour est conservée) ;
 * - « Recharger la page » : rechargement complet, seul remède quand l'application a été mise à jour entre-temps.
 */
export function ErrorFallback({
  error,
  retry,
  fullScreen = false,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
  /** Page entière (erreur hors tableau de bord) ; sinon dans la zone de contenu, sous la barre latérale. */
  fullScreen?: boolean;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const outdated = unstable_isUnrecognizedActionError(error);
  const Title = fullScreen ? "h1" : "h2";
  return (
    <div role="alert" className={cn("grid place-items-center px-6 text-center", fullScreen ? "min-h-dvh py-10" : "min-h-[60dvh] py-16")}>
      <div className="w-full max-w-md">
        <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl border border-line-strong bg-ink-700 text-amber [&_svg]:size-6">
          {outdated ? <RefreshCw /> : <TriangleAlert />}
        </div>
        <Title className="text-[22px] font-semibold tracking-tight text-fg">
          {outdated ? "Nouvelle version disponible" : "Une erreur est survenue"}
        </Title>
        <p className="mt-3 text-[14px] leading-relaxed text-fg-muted">
          {outdated
            ? "L'application a été mise à jour pendant que cette page était ouverte : rechargez la page pour continuer."
            : "Cette page n'a pas pu s'afficher. Réessayez ; si le problème persiste, rechargez la page."}
        </p>
        {error.digest && <p className="mt-3 font-mono text-[11.5px] text-fg-subtle">Référence : {error.digest}</p>}
        <div className="mt-7 flex flex-wrap justify-center gap-2">
          {retry && !outdated && (
            <Button variant="primary" onClick={() => retry()}>
              <RotateCcw /> Réessayer
            </Button>
          )}
          <Button variant={retry && !outdated ? "secondary" : "primary"} onClick={() => window.location.reload()}>
            <RefreshCw /> Recharger la page
          </Button>
        </div>
      </div>
    </div>
  );
}
