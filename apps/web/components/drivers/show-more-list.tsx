"use client";
// Liste de cartes du téléphone (MobileList) limitée aux `initial` premières lignes, puis un bouton « Afficher les N … »
// qui montre tout et disparaît (le focus passe à la première ligne ajoutée). Sur grand écran, le tableau voisin affiche
// toujours tout : ce composant ne sert qu'au rendu sous 768 px. Aucun état mémorisé.
import * as React from "react";
import { Button } from "@/components/ui/button";
import { MobileList } from "@/components/ui/table";

export function ShowMoreList({ initial, moreLabel, children }: { initial: number; moreLabel: string; children: React.ReactNode }) {
  const [all, setAll] = React.useState(false);
  const wrap = React.useRef<HTMLDivElement>(null);
  const items = React.Children.toArray(children);
  const hidden = items.length - initial;

  React.useEffect(() => {
    if (!all) return;
    wrap.current?.querySelector("ul")?.children[initial]?.querySelector<HTMLElement>("a, button")?.focus({ preventScroll: true });
  }, [all, initial]);

  return (
    <div ref={wrap} className="md:hidden">
      <MobileList>{all || hidden <= 0 ? items : items.slice(0, initial)}</MobileList>
      {!all && hidden > 0 && (
        <div className="border-t border-line/70 px-4 py-3">
          <Button type="button" variant="secondary" className="h-11 w-full" onClick={() => setAll(true)}>
            {moreLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
