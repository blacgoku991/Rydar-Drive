"use client";
// Bandeau d'information cookies. Le site n'utilise que des cookies et un stockage local strictement nécessaires
// (session, centrale sélectionnée, préférences) : exemptés de consentement (CNIL, art. 82 loi Informatique et
// Libertés). Simple information, fermée une fois pour toutes (stockage local, jamais bloquant).
import { Cookie, X } from "lucide-react";
import { useEffect, useState } from "react";

const KEY = "rd_cookie_notice";

export function CookieNotice({ href }: { href: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      setShow(window.localStorage.getItem(KEY) !== "1");
    } catch {
      setShow(false);
    }
  }, []);
  if (!show) return null;
  const close = () => {
    setShow(false);
    try {
      window.localStorage.setItem(KEY, "1");
    } catch {
      // stockage indisponible : le bandeau reviendra, sans gêne
    }
  };
  return (
    <div
      role="region"
      aria-label="Information sur les cookies"
      className="fixed inset-x-3 bottom-3 z-[60] mx-auto flex max-w-xl items-start gap-3 rounded-2xl border border-line-strong bg-ink-700/[0.97] p-3.5 text-[12.5px] leading-relaxed text-fg-muted shadow-float backdrop-blur-xl sm:inset-x-auto sm:left-4 sm:mx-0"
    >
      <Cookie className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
      <p className="flex-1">
        Ce site n&apos;utilise que des cookies nécessaires à son fonctionnement (connexion, préférences). Aucun cookie publicitaire ni de mesure
        d&apos;audience.{" "}
        <a href={href} className="text-fg underline underline-offset-2">
          En savoir plus
        </a>
      </p>
      <button type="button" onClick={close} className="-m-1 rounded-lg p-1 text-fg-subtle hover:bg-white/[0.06] hover:text-fg" aria-label="Fermer l'information sur les cookies">
        <X className="size-4" />
      </button>
    </div>
  );
}
