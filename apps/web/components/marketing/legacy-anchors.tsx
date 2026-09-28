"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { legacyAnchorTarget } from "./nav";

/**
 * Accueil : les anciens liens vers les sections de la page unique (/#services, /#tarifs, /#faq…) mènent aux pages
 * qui les ont reprises, sans ajouter d'entrée à l'historique. L'ancre n'est jamais envoyée au serveur : seul le
 * navigateur peut faire cette redirection.
 */
export function LegacyAnchorRedirect() {
  const router = useRouter();
  useEffect(() => {
    const follow = () => {
      const target = legacyAnchorTarget(window.location.hash);
      if (target) router.replace(target);
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [router]);
  return null;
}
