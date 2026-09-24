"use client";
import { Building2, MapPin, Plane, TrainFront } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { fieldBase } from "@/components/ui/input";
import type { Place } from "@/lib/places";
import { cn } from "@/lib/utils";

export type PlaceValue = { address: string; lat: number | null; lng: number | null };

const KIND_ICON = { airport: Plane, station: TrainFront, poi: Building2, address: MapPin, city: MapPin };

export function AddressInput({
  value,
  onChange,
  placeholder,
  marker,
  invalid,
  autoFocus,
}: {
  value: PlaceValue;
  onChange: (v: PlaceValue) => void;
  placeholder: string;
  marker: "pickup" | "dropoff";
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState(value.address);
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const listId = useId();
  const abort = useRef<AbortController | null>(null);

  useEffect(() => setQuery(value.address), [value.address]);

  useEffect(() => {
    if (!open || query.trim().length < 2 || query === value.address) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      setLoading(true);
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`, { signal: ctrl.signal });
        const json = (await res.json()) as { results?: Place[] };
        setResults(json.results ?? []);
        setActive(0);
      } catch {
        /* requête annulée */
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [query, open, value.address]);

  function pick(p: Place) {
    onChange({ address: p.address, lat: p.lat, lng: p.lng });
    setQuery(p.address);
    setOpen(false);
  }

  return (
    <div className="relative">
      <span
        className={cn(
          "pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2",
          marker === "pickup" ? "size-2.5 rounded-full bg-brand shadow-[0_0_10px_var(--color-brand)]" : "size-2.5 rotate-45 rounded-[2px] bg-fg",
        )}
      />
      <input
        className={cn(fieldBase, "h-11 pl-9 pr-9")}
        placeholder={placeholder}
        value={query}
        autoFocus={autoFocus}
        aria-invalid={invalid}
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls={listId}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          onChange({ address: e.target.value, lat: null, lng: null });
        }}
        onKeyDown={(e) => {
          if (!results.length) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(results[active]!);
          }
        }}
      />
      <span className="absolute right-3 top-1/2 -translate-y-1/2">
        {loading ? (
          <span className="block size-3.5 animate-spin rounded-full border-2 border-fg-subtle border-r-transparent" />
        ) : value.lat != null ? (
          <span className="block size-1.5 rounded-full bg-green shadow-[0_0_8px_var(--color-green)]" title="Adresse géolocalisée" />
        ) : null}
      </span>
      {open && results.length > 0 && (
        <ul id={listId} role="listbox" className="absolute inset-x-0 top-[calc(100%+6px)] z-[70] overflow-hidden rounded-xl border border-line-strong bg-ink-700 p-1 shadow-float">
          {results.map((r, i) => {
            const Icon = KIND_ICON[r.kind] ?? MapPin;
            return (
              <li
                key={`${r.address}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(r);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn("flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2", i === active && "bg-white/[0.06]")}
              >
                <span className={cn("grid size-7 shrink-0 place-items-center rounded-md border border-line", r.kind === "airport" ? "text-cyan" : r.kind === "station" ? "text-violet" : "text-fg-muted")}>
                  <Icon className="size-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-fg">{r.label}</span>
                  {r.label !== r.address && <span className="block truncate text-[11.5px] text-fg-subtle">{r.address}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
