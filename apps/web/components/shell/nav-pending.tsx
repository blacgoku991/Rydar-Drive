"use client";
// Retour visuel au clic dans le menu (docs/REFONTE-PANELS.md § 3.1) : les liens n'ont pas de préchargement
// (prefetch={false}), la page visée se rend côté serveur avant d'apparaître ; sans retour, un clic semblait ignoré.
//  - NavLinkPending : enfant de TAILLE FIXE de chaque lien de la barre latérale (useLinkStatus,
//    node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-link-status.md) : l'icône laisse la place à un
//    indicateur de chargement ; seule l'opacité change (aucun décalage), après 150 ms (navigation rapide : rien) ;
//  - NavProgress : tiroir mobile (fermé au clic, ses liens disparaissent) : fine barre sous la barre du haut, du clic
//    jusqu'au changement d'adresse (le shell la retire, 10 s au plus).
// Décoratifs (aria-hidden) : le changement de page est annoncé par le titre de la nouvelle page.
import { useLinkStatus } from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export function NavLinkPending({ children }: { children: React.ReactNode }) {
  const { pending } = useLinkStatus();
  return (
    <span className="relative grid size-4 shrink-0 place-items-center">
      <span className={cn("grid place-items-center transition-opacity", pending ? "opacity-0 delay-150" : "opacity-100")}>{children}</span>
      <span
        aria-hidden
        data-nav-pending={pending ? "" : undefined}
        className={cn(
          "absolute inset-0 rounded-full border-2 border-brand border-r-transparent transition-opacity",
          // Indicateur de chargement : ne tourne que pendant la navigation (jamais en boucle au repos)
          pending ? "animate-spin opacity-100 delay-150" : "opacity-0",
        )}
      />
    </span>
  );
}

/** Barre de progression du tiroir mobile : croît vite puis ralentit (transition, aucune animation en boucle). */
export function NavProgress({ active }: { active: boolean }) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    if (!active) {
      setGrown(false);
      return;
    }
    // Deux images : la barre est d'abord peinte vide, puis sa largeur suit la transition
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => setGrown(true));
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [active]);
  if (!active) return null;
  return (
    <span aria-hidden data-nav-progress="" className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden">
      <span
        className={cn(
          "block h-full origin-left bg-brand transition-transform duration-[8000ms] ease-out",
          grown ? "scale-x-90" : "scale-x-0",
        )}
      />
    </span>
  );
}
