"use client";
// Bandeau d'information cookies. Le site n'utilise que des cookies et un stockage local strictement nécessaires
// (session, centrale sélectionnée, préférences) : exemptés de consentement (CNIL, art. 82 loi Informatique et
// Libertés). Simple information, fermée une fois pour toutes (stockage local, jamais bloquant), qui ne masque jamais
// un contrôle :
//  - espaces connectés (tableau de bord, super admin) : dans la barre latérale, au-dessus du menu du compte
//    (placement « sidebar », rendu par les shells ; aussi dans le menu mobile) ;
//  - pages publiques (accueil, connexion, mini-site…) : flottant en bas, SOUS les dialogues et menus (z-40), avec une
//    réserve de même hauteur en fin de page pour que le bas de page puisse toujours défiler au-dessus du bandeau, et
//    une marge de défilement (scroll-padding-bottom) de même hauteur : un élément qui reçoit le focus au clavier
//    n'est jamais caché dessous (WCAG 2.2, 2.4.11).
import { Cookie, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { COOKIE_NOTICE_KEY as KEY } from "./cookie-notice-script";
/** Fermeture annoncée aux autres exemplaires de la page (barre latérale ET menu mobile). */
const CLOSED_EVENT = "rd:cookie-notice-closed";
/** Pages rendues dans un shell (barre latérale) : le bandeau y est placé par le shell, jamais flottant. */
const SHELL_PATHS = /^\/(dashboard|admin)(\/|$)/;

function useNotice() {
  // Rendu avec la page : déjà masqué avant la première peinture s'il a été fermé (COOKIE_NOTICE_SCRIPT), retiré ici
  const [show, setShow] = useState(true);
  useEffect(() => {
    const read = () => {
      try {
        setShow(window.localStorage.getItem(KEY) !== "1");
      } catch {
        setShow(false);
      }
    };
    read();
    const onClosed = () => setShow(false);
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) read();
    };
    window.addEventListener(CLOSED_EVENT, onClosed);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CLOSED_EVENT, onClosed);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const close = () => {
    setShow(false);
    document.documentElement.dataset.cookieNotice = "closed";
    try {
      window.localStorage.setItem(KEY, "1");
    } catch {
      // stockage indisponible : le bandeau reviendra, sans gêne
    }
    window.dispatchEvent(new Event(CLOSED_EVENT));
  };
  return [show, close] as const;
}

/** Emplacement effectif : null = rien ici (page d'un shell : le bandeau est dans sa barre latérale). */
export function cookieNoticeSlot(placement: "floating" | "sidebar", pathname: string): "floating" | "sidebar" | null {
  if (placement === "sidebar") return "sidebar";
  return SHELL_PATHS.test(pathname) ? null : "floating";
}

export function CookieNotice({ href, placement = "floating" }: { href: string; placement?: "floating" | "sidebar" }) {
  const [show, close] = useNotice();
  const slot = cookieNoticeSlot(placement, usePathname() ?? "");
  if (!show || !slot) return null;
  return slot === "sidebar" ? <SidebarNotice href={href} onClose={close} /> : <FloatingNotice href={href} onClose={close} />;
}

/**
 * Fermer le bandeau retire le bouton qui avait le focus : il passe au contenu principal (#contenu, sinon <main>), au
 * lieu de tomber sur <body> (la tabulation suivante sortait de la page, WCAG 2.4.3).
 */
function focusMainContent() {
  const main = document.getElementById("contenu") ?? document.querySelector("main");
  if (!main) return;
  if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
  main.focus({ preventScroll: true });
}

function CloseButton({ onClose, className }: { onClose: () => void; className: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        onClose();
        focusMainContent();
      }}
      className={cn("grid size-7 shrink-0 place-items-center rounded-md text-fg-subtle hover:bg-white/[0.06] hover:text-fg", className)}
      aria-label="Fermer l'information sur les cookies"
    >
      <X className="size-4" />
    </button>
  );
}

/** Barre latérale des espaces connectés : dans le flux, au-dessus du menu du compte (ne recouvre rien). */
export function SidebarNotice({ href, onClose }: { href: string; onClose: () => void }) {
  return (
    <div data-cookie-notice className="px-3 pb-3">
      <div
        role="region"
        aria-label="Information sur les cookies"
        className="flex items-start gap-1 rounded-xl border border-line bg-white/[0.02] py-2 pl-3 pr-1 text-[12px] leading-relaxed text-fg-muted"
      >
        <p className="min-w-0 flex-1 py-0.5">
          Cookies nécessaires uniquement (connexion, préférences) : aucune publicité ni mesure d&apos;audience.{" "}
          <a href={href} className="text-fg underline underline-offset-2">
            En savoir plus<span className="sr-only"> sur les cookies</span>
          </a>
        </p>
        <CloseButton onClose={onClose} className="-mt-0.5" />
      </div>
    </div>
  );
}

/** Pages publiques : flottant en bas, sous les dialogues et menus, avec une réserve de même hauteur en fin de page. */
export function FloatingNotice({ href, onClose }: { href: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setHeight(el.offsetHeight);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  // Focus au clavier jamais caché sous le bandeau : la page réserve sa hauteur quand elle fait défiler un élément
  useEffect(() => {
    if (!height) return;
    const root = document.documentElement;
    const previous = root.style.scrollPaddingBottom;
    root.style.scrollPaddingBottom = `${height + 24}px`;
    return () => {
      root.style.scrollPaddingBottom = previous;
    };
  }, [height]);
  return (
    <>
      {/* Réserve en fin de page (bandeau + marges) : le dernier contrôle de la page défile au-dessus du bandeau */}
      {/* Écran bas (zoom 400 %, téléphone à l'horizontale) : bandeau dans le flux, en fin de page, au lieu de couvrir
          une grande part de l'écran (WCAG 1.4.10) ; la réserve devient inutile */}
      <div aria-hidden="true" data-cookie-notice className="[@media(max-height:30rem)]:hidden" style={{ height: height ? height + 24 : 0 }} />
      <div
        ref={ref}
        data-cookie-notice
        role="region"
        aria-label="Information sur les cookies"
        className="fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-xl items-start gap-3 rounded-2xl border border-line-strong bg-ink-700/[0.97] p-3.5 text-[12.5px] leading-relaxed text-fg-muted shadow-float backdrop-blur-xl sm:inset-x-auto sm:left-4 sm:mx-0 [@media(max-height:30rem)]:static [@media(max-height:30rem)]:m-3"
      >
        <Cookie className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
        <p className="flex-1">
          Ce site n&apos;utilise que des cookies nécessaires à son fonctionnement (connexion, préférences). Aucun cookie publicitaire ni de mesure
          d&apos;audience.{" "}
          <a href={href} className="text-fg underline underline-offset-2">
            En savoir plus<span className="sr-only"> sur les cookies</span>
          </a>
        </p>
        <CloseButton onClose={onClose} className="-m-1.5" />
      </div>
    </>
  );
}
