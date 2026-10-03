"use client";
// Barre de filtres défilante (téléphone, ou filtre « Réseau partagé » en bout de barre) : le filtre actif
// (aria-current="page") est ramené dans la partie visible de la barre, sans faire défiler la page.
import { useEffect, useRef } from "react";

export function ActiveFilterIntoView({ activeKey }: { activeKey: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const bar = ref.current?.parentElement;
    const active = bar?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!bar || !active) return;
    const b = bar.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    if (a.right > b.right || a.left < b.left) bar.scrollLeft += a.left - b.left - 16;
  }, [activeKey]);
  return <span ref={ref} hidden />;
}
