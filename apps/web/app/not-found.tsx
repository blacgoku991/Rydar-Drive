// Page 404 : adresse inconnue ou notFound() (course, chauffeur, centrale, mini-site introuvables). Neutre, sans logo
// ni nom de plateforme : elle s'affiche aussi sur les mini-sites des centrales en marque blanche, où « Accueil » mène
// à l'accueil du mini-site consulté.
import { Compass, House } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { NotFoundBack } from "./not-found-back";

export const metadata: Metadata = { title: { absolute: "Page introuvable" } };

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6 py-10 text-center">
      <div className="w-full max-w-md">
        <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl border border-line-strong bg-ink-700 text-fg-muted [&_svg]:size-6">
          <Compass />
        </div>
        <p className="mono text-[12px] font-medium text-fg-muted">Erreur 404</p>
        <h1 className="mt-1.5 text-[22px] font-semibold tracking-tight text-fg">Page introuvable</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-fg-muted">
          Cette page n&apos;existe pas ou n&apos;est plus disponible : l&apos;adresse est peut-être incomplète, ou le contenu a
          été supprimé.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-2">
          <NotFoundBack />
          <Button asChild variant="primary">
            <Link href="/">
              <House /> Revenir à l&apos;accueil
            </Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
