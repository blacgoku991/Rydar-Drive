// Page introuvable de l'espace connecté (notFound() d'une page du tableau de bord : course, chauffeur, page refusée à la
// Flotte Privée…) : rendue DANS la mise en page, la barre latérale reste en place. Sans <main> : la coquille le porte
// (DashboardShell). La 404 neutre des adresses inconnues et des mini-sites reste app/not-found.tsx.
import { Compass, House } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { NotFoundBack } from "../not-found-back";

export const metadata: Metadata = { title: "Page introuvable" };

export default function DashboardNotFound() {
  return (
    <div className="grid min-h-[60dvh] place-items-center px-4 py-12 text-center sm:px-6">
      <div className="w-full max-w-md">
        <div aria-hidden className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl border border-line-strong bg-ink-700 text-fg-muted [&_svg]:size-6">
          <Compass />
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight text-fg">Page introuvable</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-fg-muted">Cette page n&apos;existe pas ou plus.</p>
        <div className="mt-7 flex flex-wrap justify-center gap-2">
          <NotFoundBack />
          <Button asChild variant="primary">
            <Link href="/dashboard" prefetch={false}>
              <House aria-hidden /> Retour au tableau de bord
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
