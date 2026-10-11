"use client";
// Réglages › Tarifs (docs/REFONTE-PANELS.md § 5.6, lot R10) : UN formulaire, une fieldset par catégorie (légende = nom
// de la catégorie), libellés des champs inchangés (masqués à l'écran sur grand écran, sous une ligne d'en-têtes).
// Catégorie sans tarif : champs vides (exemples en placeholder) et « Utiliser des valeurs de départ » — plus aucun prix
// inventé affiché comme un tarif. « Enregistrer » envoie chaque ligne modifiée à savePricingRule (inchangée), l'une
// après l'autre : une erreur reste sous sa ligne sans empêcher les autres, la page est relue une fois à la fin.
// Flotte Privée : catégorie de son véhicule en tête, les autres repliées (réservations « à vérifier »).
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_META, formatPrice, type VehicleCategory } from "@rydar/shared";
import { useRouter } from "next/navigation";
import * as React from "react";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { savePricingRule } from "@/app/dashboard/settings/actions";
import { UnsavedGuard } from "@/components/settings/unsaved-guard";
import {
  PRICE_FIELDS, SERVER_FIELD, STARTER_ROW, changedCategories, dayExampleCents, nightRangeLabel, parseRow, rowChanged, rowFromRule,
  type PriceField, type PriceRow, type StoredRule,
} from "@/components/settings/pricing-rows";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { Field, Input, asFieldControl } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";
import { plural } from "@/lib/wording";

const NB = " ";

/** Colonnes : libellé du champ (inchangé, nom accessible), en-tête de colonne, unité, exemple de départ. */
const COLUMNS: Record<PriceField, { label: string; head: string; unit: string; placeholder: string }> = {
  base: { label: "Prise en charge € TTC", head: "Prise en charge", unit: "€", placeholder: "ex. : 10" },
  km: { label: "€ TTC / km", head: "Prix au km", unit: "€/km", placeholder: "ex. : 2" },
  min: { label: "€ TTC / min", head: "Prix à la minute", unit: "€/min", placeholder: "ex. : 0,5" },
  minimum: { label: "Minimum € TTC", head: "Course minimum", unit: "€", placeholder: "ex. : 30" },
  night: { label: "Nuit %", head: "Majoration de nuit", unit: "%", placeholder: "ex. : 15" },
};

const GRID = "md:grid md:grid-cols-[minmax(0,150px)_repeat(5,minmax(0,1fr))] md:gap-3";

/** Montant avec son unité dans le champ (« € », « €/km », « % ») ; unité annoncée en description. */
const AmountInput = asFieldControl(function AmountInput({ unit, className, ...props }: React.ComponentProps<typeof Input> & { unit: string }) {
  const unitId = React.useId();
  return (
    <div className="relative">
      <Input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        {...props}
        aria-describedby={[props["aria-describedby"], unitId].filter(Boolean).join(" ")}
        className={cn("num pr-14", className)}
      />
      <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12.5px] text-fg-muted">
        {unit}
      </span>
      <span id={unitId} className="sr-only">
        {unit === "%" ? "en pourcentage" : unit === "€/km" ? "en euros par kilomètre" : unit === "€/min" ? "en euros par minute" : "en euros"}
      </span>
    </div>
  );
});

type RowError = { fields: Partial<Record<PriceField, string>>; message?: string };
type State = { baseline: Record<VehicleCategory, PriceRow>; rows: Record<VehicleCategory, PriceRow> };

const rowsFrom = (rules: StoredRule[]) => {
  const byCat = new Map(rules.map((r) => [r.vehicle_category, r]));
  return Object.fromEntries(VEHICLE_CATEGORIES.map((c) => [c, rowFromRule(byCat.get(c))])) as Record<VehicleCategory, PriceRow>;
};

export function PricingEditor({
  rules,
  readOnly,
  privateFleet = false,
  vehicleCategory = null,
  timezone = "Europe/Paris",
}: {
  rules: StoredRule[];
  readOnly: boolean;
  /** Flotte Privée : la grille calcule aussi le prix affiché par le site du client (devis de l'API v1) */
  privateFleet?: boolean;
  /** Flotte Privée : catégorie du véhicule du chauffeur (en tête) */
  vehicleCategory?: VehicleCategory | null;
  timezone?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const byCat = useMemo(() => new Map(rules.map((r) => [r.vehicle_category, r])), [rules]);
  const fromServer = useMemo(() => rowsFrom(rules), [rules]);
  const [state, setState] = useState<State>(() => ({ baseline: fromServer, rows: fromServer }));
  const [errors, setErrors] = useState<Partial<Record<VehicleCategory, RowError>>>({});

  // Page relue (après un enregistrement) : les lignes non modifiées reprennent la valeur enregistrée ; une ligne
  // encore modifiée (erreur) garde la saisie
  useEffect(() => {
    setState((cur) => {
      const baseline = { ...cur.baseline };
      const rows = { ...cur.rows };
      for (const c of VEHICLE_CATEGORIES) {
        if (!rowChanged(cur.baseline[c], cur.rows[c])) {
          baseline[c] = fromServer[c];
          rows[c] = fromServer[c];
        }
      }
      return { baseline, rows };
    });
  }, [fromServer]);

  const vehicleFirst = privateFleet && vehicleCategory && VEHICLE_CATEGORIES.includes(vehicleCategory);
  const order: VehicleCategory[] = vehicleFirst ? [vehicleCategory, ...VEHICLE_CATEGORIES.filter((c) => c !== vehicleCategory)] : [...VEHICLE_CATEGORIES];
  const changed = changedCategories(order, state.baseline, state.rows);
  const dirty = changed.length > 0;

  // Heures de la majoration de nuit : une seule phrase si toutes les catégories ont les mêmes
  const nightRanges = new Set(order.map((c) => nightRangeLabel(byCat.get(c))));
  const commonNight = nightRanges.size === 1 ? [...nightRanges][0]! : null;

  const setField = (cat: VehicleCategory, f: PriceField, value: string) => {
    setState((cur) => ({ ...cur, rows: { ...cur.rows, [cat]: { ...cur.rows[cat], [f]: value } } }));
    setErrors((cur) => {
      const e = cur[cat];
      if (!e) return cur;
      const fields = { ...e.fields };
      delete fields[f];
      return { ...cur, [cat]: { fields, message: undefined } };
    });
  };
  const fillStarter = (cat: VehicleCategory) => setState((cur) => ({ ...cur, rows: { ...cur.rows, [cat]: { ...STARTER_ROW } } }));
  const reset = () => {
    setState((cur) => ({ ...cur, rows: { ...cur.baseline } }));
    setErrors({});
  };

  const save = () =>
    start(() =>
      runAction(async () => {
        const cats = changedCategories(order, state.baseline, state.rows);
        if (!cats.length) return;
        const next: Partial<Record<VehicleCategory, RowError>> = {};
        const saved: VehicleCategory[] = [];
        for (const cat of cats) {
          const row = state.rows[cat];
          const parsed = parseRow(row);
          if (!parsed.ok) {
            next[cat] = { fields: parsed.errors, message: "Ligne non enregistrée : vérifiez les valeurs signalées." };
            continue;
          }
          const res = await savePricingRule({
            vehicle_category: cat,
            name: VEHICLE_CATEGORY_META[cat].label,
            ...parsed.value,
            fixed_fares: byCat.get(cat)?.fixed_fares ?? [],
          });
          if (!res.ok) {
            const fields: Partial<Record<PriceField, string>> = {};
            for (const [k, m] of Object.entries(res.fieldErrors ?? {})) {
              const f = SERVER_FIELD[k.split(".")[0]!];
              if (f && !fields[f]) fields[f] = m;
            }
            next[cat] = { fields, message: res.error };
            continue;
          }
          saved.push(cat);
        }
        if (saved.length) {
          // Lignes enregistrées : leur saisie devient la valeur de référence (la relecture de la page la confirme)
          setState((cur) => {
            const baseline = { ...cur.baseline };
            for (const c of saved) baseline[c] = cur.rows[c];
            return { ...cur, baseline };
          });
        }
        setErrors(next);
        const failed = Object.keys(next).length;
        if (saved.length && !failed) toast.success(saved.length === 1 ? `Tarif ${VEHICLE_CATEGORY_META[saved[0]!].label} enregistré` : `${plural(saved.length, "tarif enregistré", "tarifs enregistrés")}`);
        else if (saved.length) toast.error(`${plural(saved.length, "tarif enregistré", "tarifs enregistrés")}, ${plural(failed, "ligne à corriger", "lignes à corriger")}.`);
        else toast.error(failed > 1 ? "Aucun tarif enregistré : corrigez les lignes signalées." : "Tarif non enregistré : corrigez la ligne signalée.");
        if (saved.length) router.refresh();
      }),
    );

  const renderRow = (cat: VehicleCategory) => {
    const rule = byCat.get(cat);
    const row = state.rows[cat];
    const e = errors[cat];
    const modified = rowChanged(state.baseline[cat], row);
    const empty = !PRICE_FIELDS.some((f) => row[f].trim());
    const example = dayExampleCents(row, cat, timezone);
    const statusId = `tarif-${cat}-etat`;
    return (
      <fieldset key={cat} className={cn("min-w-0 px-5 py-4", GRID)} aria-describedby={statusId}>
        <legend className="sr-only">{VEHICLE_CATEGORY_META[cat].label}</legend>
        <div className="mb-3 md:mb-0 md:pt-2">
          <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-fg">
            {/* Nom déjà donné par la légende (nom du groupe) : non relu ici */}
            <span aria-hidden>{VEHICLE_CATEGORY_META[cat].label}</span>
            {cat === vehicleCategory && privateFleet && <Badge tone="neutral">Votre véhicule</Badge>}
          </p>
          <p id={statusId} className={cn("mt-0.5 text-[12.5px]", modified ? "text-amber" : "text-fg-muted")}>
            {modified
              ? "Modifié, pas encore enregistré"
              : rule
                ? `Minimum ${formatPrice(rule.minimum_fare_cents)}`
                : privateFleet
                  ? "Aucun tarif : votre site n'affiche pas de prix pour cette catégorie."
                  : "Aucun tarif : aucun prix proposé."}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 md:contents">
          {PRICE_FIELDS.map((f) => (
            <Field
              key={f}
              label={<span className="md:sr-only">{COLUMNS[f].label}</span>}
              error={e?.fields[f]}
              className={cn("md:gap-0", f === "night" && "col-span-2 sm:col-span-1")}
            >
              <AmountInput
                name={`${cat}-${f}`}
                unit={COLUMNS[f].unit}
                value={row[f]}
                placeholder={rule ? undefined : COLUMNS[f].placeholder}
                disabled={readOnly}
                onChange={(ev) => setField(cat, f, ev.target.value.replace(/[^\d.,\s]/g, "").slice(0, 9))}
              />
            </Field>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-fg-muted md:col-span-5 md:col-start-2 md:mt-0">
          {example !== null && (
            <span>
              Ex. 20{NB}km, 30{NB}min, de jour{NB}: <span className="num font-medium text-fg">{formatPrice(example)}</span>
            </span>
          )}
          {!commonNight && <span>Nuit{NB}: majoration {nightRangeLabel(rule)}.</span>}
          {!readOnly && empty && (
            <Button type="button" variant="outline" size="sm" className="max-sm:min-h-11" onClick={() => fillStarter(cat)}>
              Utiliser des valeurs de départ
            </Button>
          )}
          {e?.message && (
            <span role="alert" className="text-red">
              {e.message}
            </span>
          )}
        </div>
      </fieldset>
    );
  };

  const head = (
    <div aria-hidden className={cn("hidden border-b border-line px-5 py-2 text-[12px] font-medium text-fg-subtle", GRID)}>
      <span>Catégorie</span>
      {PRICE_FIELDS.map((f) => (
        <span key={f}>
          {COLUMNS[f].head} ({COLUMNS[f].unit})
        </span>
      ))}
    </div>
  );

  const main = vehicleFirst ? order.slice(0, 1) : order;
  const others = vehicleFirst ? order.slice(1) : [];
  const othersOpen = others.some((c) => !!errors[c]);

  return (
    <form onSubmit={submitWith(() => save())} noValidate className="space-y-6">
      <Card>
        {/* Montants TTC : le mini-site affiche ce prix aux particuliers comme « Prix TTC » (C. conso. L112-1) */}
        <CardHeader
          title="Grille tarifaire"
          description={
            <>
              {privateFleet
                ? "Montants toutes taxes comprises (prix payé par le client). Sert au prix affiché par votre site et suggéré à la saisie ; le prix final reste modifiable."
                : "Montants toutes taxes comprises (prix payé par le client). Sert au prix suggéré à la saisie et au prix affiché sur le mini-site ; le prix final reste modifiable."}
              {commonNight && (
                <>
                  {" "}
                  Majoration de nuit {commonNight}.
                </>
              )}
            </>
          }
        />
        {head}
        <div className="divide-y divide-line">{main.map(renderRow)}</div>
        {others.length > 0 && (
          <Disclosure
            title="Autres catégories (réservations à vérifier)"
            hint={<span className="text-[12.5px] font-normal text-fg-muted">{plural(others.length, "catégorie")}</span>}
            forceOpen={othersOpen}
            className="border-t border-line"
            summaryClassName="px-5"
          >
            <p className="px-5 pb-2 text-[12.5px] text-fg-muted">
              Une réservation dans une autre catégorie que votre véhicule vous est proposée «{NB}à vérifier{NB}».
            </p>
            {head}
            <div className="divide-y divide-line border-t border-line md:border-t-0">{others.map(renderRow)}</div>
          </Disclosure>
        )}
      </Card>
      {!readOnly && (
        <>
          <div data-tour-avoid="" className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line-strong bg-ink-700/[0.97] px-4 py-3 shadow-float backdrop-blur-xl">
            <p className="flex items-center gap-2 text-[13px] text-fg-muted" aria-live="polite">
              <span aria-hidden className={cn("size-1.5 rounded-full", dirty ? "bg-amber" : "bg-green")} />
              {dirty ? `Modifications non enregistrées · ${plural(changed.length, "ligne")}` : "Tout est enregistré"}
            </p>
            <div className="flex flex-wrap gap-2">
              {dirty && (
                <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={pending}>
                  Annuler les modifications
                </Button>
              )}
              <Button type="submit" variant="primary" size="sm" loading={pending} disabled={!dirty}>
                Enregistrer
              </Button>
            </div>
          </div>
          <UnsavedGuard dirty={dirty} />
        </>
      )}
    </form>
  );
}

