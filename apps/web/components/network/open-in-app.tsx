"use client";
// Page d'inscription ouverte sur un téléphone : l'application chauffeur fait l'inscription elle-même.
// Lien universel (https://…/rejoindre/{code}) : iOS ouvre l'app directement quand elle est installée ;
// ce bloc sert quand le lien a été ouvert dans le navigateur (tapé, copié, ou app absente).
import { ArrowUpRight, Smartphone } from "lucide-react";

export function OpenInApp({ code, appStoreUrl }: { code: string; appStoreUrl: string | null }) {
  return (
    <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-brand/30 bg-brand/[0.06] p-4 sm:flex-row sm:items-center lg:hidden">
      <span className="flex min-w-0 flex-1 items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand">
          <Smartphone className="size-5" />
        </span>
        <span className="min-w-0 text-[13px] leading-snug">
          <span className="block font-semibold">Inscrivez-vous dans l&apos;application</span>
          <span className="block text-fg-muted">Rydar Drive installée : vous êtes rattaché à la centrale en un geste.</span>
        </span>
      </span>
      <span className="flex shrink-0 gap-2">
        <a
          href={`rydardrive://rejoindre/${code}`}
          className="inline-flex h-10 items-center justify-center rounded-xl bg-brand px-4 text-[13.5px] font-semibold text-brand-fg"
        >
          Ouvrir l&apos;app
        </a>
        {appStoreUrl && (
          <a
            href={appStoreUrl}
            className="inline-flex h-10 items-center justify-center gap-1 rounded-xl border border-line-strong px-3 text-[13px] font-medium"
          >
            Installer <ArrowUpRight className="size-3.5" />
          </a>
        )}
      </span>
    </div>
  );
}
