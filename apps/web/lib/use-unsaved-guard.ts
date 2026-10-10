"use client";
// Modifications non enregistrées (docs/REFONTE-PANELS.md § 5.6, lot R10) : un formulaire « sale » (Dispatch, Commission &
// encaissement, grille tarifaire, Organisation) ne se perd plus en changeant d'onglet ou de page. Fermer ou recharger
// l'onglet du navigateur : alerte native (beforeunload) ; clic sur un lien qui quitte la page (onglet des réglages,
// entrée du menu…) : confirmation (UnsavedGuard, components/settings/unsaved-guard.tsx), puis le même lien est suivi.
// La décision est une fonction pure (leavesPage, testée : use-unsaved-guard.test.ts) ; aucune donnée n'est mémorisée.
import { useCallback, useEffect, useRef, useState } from "react";

/** Clic sur un lien, réduit à ce qui décide s'il fait quitter la page. */
export type LeaveClick = {
  /** Adresse du lien, absolue ou relative à la page en cours */
  href: string;
  /** Attribut target du lien (« _blank » : nouvel onglet, la page reste) */
  target?: string | null;
  /** Lien de téléchargement : la page reste */
  download?: boolean;
  /** Bouton de la souris (0 : principal) */
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  /** Clic déjà annulé par un autre gestionnaire */
  defaultPrevented?: boolean;
};

/**
 * Ce clic fait-il quitter la page en cours (et perdre une saisie non enregistrée) ? Non : clic déjà annulé, autre
 * bouton que le principal, touche Ctrl / Cmd / Maj / Alt (nouvel onglet, nouvelle fenêtre, téléchargement), lien
 * vers un autre onglet du navigateur, téléchargement, mailto: / tel:, ancre de la même page. Oui : toute autre
 * adresse (autre onglet des réglages — seul le paramètre ?tab= change —, autre page, autre site).
 */
export function leavesPage(click: LeaveClick, current: string): boolean {
  if (click.defaultPrevented) return false;
  if ((click.button ?? 0) !== 0) return false;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  if (click.download) return false;
  const target = (click.target ?? "").trim().toLowerCase();
  if (target && target !== "_self") return false;
  let to: URL;
  let from: URL;
  try {
    from = new URL(current);
    to = new URL(click.href, from);
  } catch {
    return false;
  }
  if (to.protocol !== "http:" && to.protocol !== "https:") return false;
  // Même page, seule l'ancre change (#section) : rien n'est rechargé, rien n'est perdu
  return !(to.origin === from.origin && to.pathname === from.pathname && to.search === from.search);
}

/** Confirmation nécessaire : saisie non enregistrée ET clic qui quitte la page. */
export function shouldConfirmLeave(dirty: boolean, click: LeaveClick, current: string): boolean {
  return dirty && leavesPage(click, current);
}

/**
 * Tant que `dirty` : alerte du navigateur à la fermeture ou au rechargement de l'onglet, et clic sur un lien qui
 * quitte la page retenu (écouteur en phase de capture sur window : ni le lien, ni le routeur de Next ne le voient)
 * jusqu'à la réponse de la personne. `pendingHref` : adresse visée (fenêtre ouverte) ; `stay` : rester ; `leave` :
 * suivre le même lien (même élément, même navigation : client pour un lien de Next, page suivante sinon).
 */
export function useUnsavedGuard(dirty: boolean): { pendingHref: string | null; stay: () => void; leave: () => void } {
  const [pending, setPending] = useState<HTMLAnchorElement | null>(null);
  // Départ confirmé : ni alerte du navigateur, ni nouvelle confirmation pendant la navigation qui suit
  const allowed = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (allowed.current) return;
      e.preventDefault();
      // Navigateurs plus anciens : seule la présence d'une valeur compte (texte jamais affiché)
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (allowed.current) return;
      const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement)) return;
      const click: LeaveClick = {
        href: link.href,
        target: link.getAttribute("target"),
        download: link.hasAttribute("download"),
        button: e.button,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        defaultPrevented: e.defaultPrevented,
      };
      if (!leavesPage(click, window.location.href)) return;
      e.preventDefault();
      e.stopPropagation();
      setPending(link);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("click", onClick, true);
    };
  }, [dirty]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const stay = useCallback(() => setPending(null), []);
  const leave = useCallback(() => {
    const link = pending;
    setPending(null);
    if (!link) return;
    allowed.current = true;
    if (link.isConnected) link.click();
    else window.location.assign(link.href);
    // Navigation lancée : le garde reprend ensuite (page restée affichée, ex. navigation impossible)
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      allowed.current = false;
    }, 2000);
  }, [pending]);

  return { pendingHref: pending?.href ?? null, stay, leave };
}
