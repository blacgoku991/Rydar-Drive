import { Search, X } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Adresse de la page sans la recherche (`q`), les autres paramètres conservés (filtre, onglet…). */
export function searchClearHref(action: string, params: Record<string, string | number | null | undefined> = {}, name = "q"): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === name || value === null || value === undefined || value === "") continue;
    qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `${action}?${query}` : action;
}

/**
 * Recherche d'une liste (docs/REFONTE-PANELS.md § 3.11) : formulaire GET vers l'adresse de la page (jamais une action
 * serveur ; l'adresse se partage et revient avec « Précédent »), champ `type="search"` `name="q"`, bouton
 * « Rechercher », lien « Effacer » quand une recherche est en cours ; les autres paramètres de la page (`params` :
 * filtre, onglet…) sont conservés en champs cachés. La page de résultats revient toujours à la première page.
 */
export function SearchField({
  action,
  defaultValue,
  label,
  placeholder,
  params = {},
  name = "q",
  className,
}: {
  /** Adresse de la page (« /dashboard/rides ») */
  action: string;
  defaultValue?: string | null;
  /** Nom accessible du champ (« Rechercher une course ») */
  label: string;
  /** Exemple (« ex. : nom, téléphone, plaque ») */
  placeholder?: string;
  /** Autres paramètres conservés (ni la page ni la recherche) */
  params?: Record<string, string | number | null | undefined>;
  name?: string;
  className?: string;
}) {
  const kept = Object.entries(params).filter(([key, value]) => key !== name && key !== "page" && value !== null && value !== undefined && value !== "");
  const current = (defaultValue ?? "").trim();
  return (
    <form role="search" action={action} method="get" className={cn("flex w-full max-w-md flex-wrap items-center gap-2", className)}>
      {kept.map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={String(value)} />
      ))}
      <div className="relative min-w-[min(100%,12rem)] flex-1">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
        <input
          type="search"
          name={name}
          defaultValue={current}
          placeholder={placeholder}
          aria-label={label}
          title={label}
          enterKeyHint="search"
          autoComplete="off"
          className="h-10 w-full rounded-lg border border-line-field bg-ink-850 pl-9 pr-3 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-brand/60 focus-visible:ring-2 focus-visible:ring-brand/40"
        />
      </div>
      <Button type="submit" variant="secondary" className="h-10">
        Rechercher
      </Button>
      {current && (
        <Link
          href={searchClearHref(action, Object.fromEntries(kept), name)}
          prefetch={false}
          aria-label="Effacer la recherche"
          className="inline-flex h-10 items-center gap-1 rounded-lg px-2 text-[13px] text-fg-muted hover:text-fg"
        >
          <X aria-hidden className="size-3.5" /> Effacer
        </Link>
      )}
    </form>
  );
}
