"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PRICING_HREF } from "./contact";
import { isCurrentPage, NAV_LINKS } from "./nav";

/** En-tête collant du site vitrine : pages, lien actif, et menu déroulant sur mobile. */
export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const desktopNavRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    // Le panneau se ferme (hidden) : le focus qui s'y trouvait ne doit pas retomber sur <body>. On retient s'il y
    // était, car en passant en grand écran le navigateur le retire du panneau masqué avant l'événement resize.
    const panel = panelRef.current;
    let focusInPanel = !!panel?.contains(document.activeElement);
    const onFocusIn = (e: FocusEvent) => {
      focusInPanel = !!panel?.contains(e.target as Node);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      if (focusInPanel) buttonRef.current?.focus();
    };
    const onResize = () => {
      if (window.innerWidth < 1024) return;
      setOpen(false);
      // Navigation complète affichée, bouton du menu masqué : le focus passe au premier lien de l'en-tête
      const active = document.activeElement;
      if (focusInPanel && (!active || active === document.body || panel?.contains(active))) {
        desktopNavRef.current?.querySelector("a")?.focus();
      }
    };
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // Écran bas (zoom 400 %, téléphone à l'horizontale) : en-tête dans le flux, pour laisser la place au contenu
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-ink-900/90 backdrop-blur-xl [@media(max-height:30rem)]:static">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link href="/" aria-label="Rydar Drive, accueil" aria-current={pathname === "/" ? "page" : undefined} className="shrink-0 rounded-lg">
          <Logo size={28} />
        </Link>
        <nav ref={desktopNavRef} aria-label="Navigation principale" className="hidden h-full items-center gap-7 text-[13.5px] text-fg-muted lg:flex">
          {NAV_LINKS.map((l) => {
            const current = isCurrentPage(pathname, l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "relative flex h-full items-center transition-colors hover:text-fg",
                  // Page affichée : texte clair et trait lime posé sur la bordure basse de l'en-tête
                  current && "text-fg after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-brand",
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href="/login">Se connecter</Link>
          </Button>
          <Button asChild variant="primary" size="sm" className="hidden min-[400px]:inline-flex">
            <Link href={PRICING_HREF}>Demander un tarif</Link>
          </Button>
          <button
            ref={buttonRef}
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={open ? "Fermer le menu" : "Ouvrir le menu"}
            onClick={() => setOpen((o) => !o)}
            className="grid size-10 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-white/[0.05] hover:text-fg lg:hidden"
          >
            {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
          </button>
        </div>
      </div>
      <div ref={panelRef} id={panelId} hidden={!open} className="border-t border-line bg-ink-900/95 lg:hidden">
        <nav aria-label="Menu" className="mx-auto flex max-w-6xl flex-col px-4 py-3 sm:px-6">
          {NAV_LINKS.map((l) => {
            const current = isCurrentPage(pathname, l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={current ? "page" : undefined}
                onClick={() => setOpen(false)}
                className={cn(
                  "flex h-12 items-center gap-3 rounded-lg px-2 text-[15px] transition-colors hover:bg-white/[0.04] hover:text-fg",
                  current ? "bg-white/[0.04] text-fg" : "text-fg-muted",
                )}
              >
                <span aria-hidden className={cn("h-4 w-0.5 rounded-full", current ? "bg-brand" : "bg-transparent")} />
                {l.label}
              </Link>
            );
          })}
          <div className="mt-3 grid gap-2 border-t border-line pt-4 pb-1 min-[400px]:grid-cols-2">
            <Button asChild variant="outline" size="lg">
              <Link href="/login" onClick={() => setOpen(false)}>
                Se connecter
              </Link>
            </Button>
            <Button asChild variant="primary" size="lg">
              <Link href={PRICING_HREF} onClick={() => setOpen(false)}>
                Demander un tarif
              </Link>
            </Button>
          </div>
        </nav>
      </div>
    </header>
  );
}
