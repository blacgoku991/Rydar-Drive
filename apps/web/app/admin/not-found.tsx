// Page introuvable de l'espace super admin (notFound() d'une page de /admin : client, compte de frais, demande de
// contact…) : rendue DANS la mise en page, la barre latérale reste en place. Sans <main> : la coquille le porte
// (AdminShell). La 404 neutre des adresses inconnues et des mini-sites reste app/not-found.tsx.
import { Compass, LayoutDashboard } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { NotFoundBack } from "../not-found-back";

export const metadata: Metadata = { title: "Page introuvable" };

export default function AdminNotFound() {
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
            <Link href="/admin" prefetch={false}>
              <LayoutDashboard aria-hidden /> Retour à la vue d&apos;ensemble
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
