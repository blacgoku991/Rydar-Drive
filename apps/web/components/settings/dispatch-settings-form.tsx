"use client";
// Réglages › Dispatch (docs/REFONTE-PANELS.md § 5.6, lot R10) : l'essentiel visible (dispatch automatique, zones de
// recherche et relance, temps laissé pour accepter, rappels, paiement par défaut, surclassement), le reste dans
// « Réglages avancés » (seuil d'une course immédiate, recherche avant une course réservée, maximum par vague, âge de la
// position, suivi des vols, alertes de suivi), ouvert d'office en cas d'erreur. Libellés en français courant (les mêmes
// que SETTINGS_LABELS des messages du serveur). Enregistrement inchangé : updateDispatchSettings reçoit tous les
// réglages d'un coup (la commission d'une flotte reste donc ici).
import {
  DEFAULT_RETRY_RADII_M, PAYMENT_METHOD_LABELS, PAYMENT_METHODS, dispatchPlan, fieldErrors as zodFieldErrors, formatDistance, formatPrice, orgSettingsSchema,
  type OrgSettings,
} from "@rydar/shared";
import { Minus, Percent, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { updateDispatchSettings } from "@/app/dashboard/settings/actions";
import { UnsavedGuard } from "@/components/settings/unsaved-guard";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { Field, Input, NativeSelect, asFieldControl } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch-row";
import { runAction } from "@/lib/run-action";
import { cn } from "@/lib/utils";

const NB = " ";

const REMINDERS = [
  { v: 1440, label: `24${NB}h avant` },
  { v: 180, label: `3${NB}h avant` },
  { v: 60, label: `1${NB}h avant` },
  { v: 30, label: `30${NB}min avant` },
];

/** Réglages ajoutés par les migrations 002100 / 002200 / 002400 / 003200 : valeurs par défaut si la ligne est ancienne. */
const SETTINGS_DEFAULTS = {
  dispatch_retry_radii_m: [...DEFAULT_RETRY_RADII_M],
  flight_tracking_enabled: true,
  flight_pickup_buffer_minutes: 15,
  late_alert_tolerance_minutes: 5,
  stalled_alert_minutes: 4,
  driver_commission_percent: null,
} satisfies Partial<OrgSettings>;

/** Réglages numériques saisis : vide = « Indiquez un nombre » (jamais 0 en silence). */
const NUMERIC_KEYS = [
  "offer_timeout_seconds", "instant_threshold_minutes", "scheduled_dispatch_lead_minutes", "max_offers_per_wave", "location_max_age_seconds",
  "flight_pickup_buffer_minutes", "late_alert_tolerance_minutes", "stalled_alert_minutes",
] as const satisfies readonly (keyof OrgSettings)[];
const ADVANCED_KEYS = ["instant_threshold_minutes", "scheduled_dispatch_lead_minutes", "max_offers_per_wave", "location_max_age_seconds"];
const FLIGHT_KEYS = ["flight_tracking_enabled", "flight_pickup_buffer_minutes"];
const ALERT_KEYS = ["late_alert_tolerance_minutes", "stalled_alert_minutes"];

/** 90 → « 1 min 30 », 45 → « 45 s ». */
const formatWaveTime = (s: number) => (s < 60 ? `${s}${NB}s` : `${Math.floor(s / 60)}${NB}min${s % 60 ? `${NB}${String(s % 60).padStart(2, "0")}` : ""}`);

const num = (v: string) => (v.trim() === "" ? Number.NaN : Number(v.replace(",", ".")));
const shown = (n: number) => (Number.isNaN(n) ? "" : n);

/**
 * Nombre suivi de son unité écrite en clair à droite (« min avant le départ ») : unité reliée au champ en description
 * (lue après le libellé de Field, qui relie id, aide et erreur).
 */
const NumberUnit = asFieldControl(function NumberUnit({ unit, className, ...props }: React.ComponentProps<typeof Input> & { unit: string }) {
  const unitId = React.useId();
  return (
    <div className="flex items-center gap-2.5">
      <Input
        type="number"
        inputMode="numeric"
        {...props}
        aria-describedby={[props["aria-describedby"], unitId].filter(Boolean).join(" ")}
        className={cn("num w-28 shrink-0", className)}
      />
      <span id={unitId} className="min-w-0 text-[13px] text-fg-muted">
        {unit}
      </span>
    </div>
  );
});

/**
 * Zones successives (en km) : une case par zone, « Retirer la dernière … » / « Ajouter une … ». Premier passage : 1 à 8
 * zones ; relance : 0 à 4.
 */
function ZonesEditor({
  legend,
  hint,
  value,
  onChange,
  readOnly,
  min,
  max,
  noun,
  error,
  empty,
}: {
  legend: string;
  hint?: string;
  value: number[];
  onChange: (v: number[]) => void;
  readOnly: boolean;
  min: number;
  max: number;
  /** « vague » / « relance » */
  noun: string;
  error?: string;
  /** Texte quand la liste est vide (relance) */
  empty?: string;
}) {
  const id = React.useId();
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  return (
    <fieldset className="min-w-0" aria-describedby={[hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined}>
      <legend className="text-[13px] font-medium text-fg">{legend}</legend>
      {hint && (
        <p id={`${id}-hint`} className="mt-0.5 text-[12.5px] text-fg-muted">
          {hint}
        </p>
      )}
      {value.length ? (
        <ol className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-2">
          {value.map((m, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <Input
                type="number"
                step="0.5"
                min={0.5}
                inputMode="decimal"
                value={Number.isNaN(m) ? "" : m / 1000}
                disabled={readOnly}
                aria-label={`${Noun} ${i + 1}, distance en km`}
                aria-invalid={!!error || undefined}
                onChange={(e) => onChange(value.map((x, j) => (j === i ? (e.target.value.trim() === "" ? Number.NaN : Math.round(num(e.target.value) * 1000)) : x)))}
                className="num h-10 w-[4.5rem] text-center"
              />
              <span aria-hidden className="text-[12.5px] text-fg-muted">
                km
              </span>
              {i < value.length - 1 && (
                <span aria-hidden className="px-1 text-fg-subtle">
                  →
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : (
        empty && <p className="mt-2 text-[13px] text-fg-muted">{empty}</p>
      )}
      {!readOnly && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {value.length > min && (
            <Button type="button" variant="ghost" size="sm" className="max-sm:min-h-11" onClick={() => onChange(value.slice(0, -1))}>
              <Minus aria-hidden /> Retirer la dernière {noun}
            </Button>
          )}
          {value.length < max && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-sm:min-h-11"
              onClick={() => onChange([...value, Math.min(100_000, (Number.isNaN(value.at(-1) ?? 0) ? 0 : (value.at(-1) ?? 0)) + 4000)])}
            >
              <Plus aria-hidden /> Ajouter une {noun}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-red">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** Déroulé de la recherche : chaque vague, chaque relance, puis l'alerte si personne n'a accepté. */
function WavePlan({ radii, retry, timeout }: { radii: number[]; retry: number[]; timeout: number }) {
  const plan = dispatchPlan(radii, retry);
  const step = Number.isNaN(timeout) ? 0 : timeout;
  return (
    <ol className="space-y-1.5 text-[13px] text-fg-muted">
      {plan.waves.map((r, i) => (
        <li key={i} className={cn("flex justify-between gap-3", i === plan.first.length && "border-t border-line pt-1.5")}>
          <span>
            {i < plan.first.length ? `Vague ${i + 1}` : "Relance"} · {Number.isNaN(r) ? "—" : formatDistance(r)}
          </span>
          <span className="num shrink-0 text-fg-subtle">{i === 0 ? "tout de suite" : `après ${formatWaveTime(i * step)}`}</span>
        </li>
      ))}
      <li className="flex justify-between gap-3 border-t border-line pt-1.5 text-fg">
        <span>Personne n&apos;a accepté{NB}: alerte au tableau de bord</span>
        <span className="num shrink-0 text-fg-subtle">après {formatWaveTime(plan.waves.length * step)}</span>
      </li>
    </ol>
  );
}

/** Cercles des zones (grand écran) : décoratif, la liste WavePlan dit la même chose en texte. */
function RadiiPreview({ radii }: { radii: number[] }) {
  const clean = radii.filter((r) => !Number.isNaN(r));
  const max = Math.max(...clean, 1);
  return (
    <div aria-hidden className="relative mx-auto aspect-square w-full max-w-[260px]">
      {[...clean].reverse().map((r, i) => (
        <div
          key={`${r}-${i}`}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-brand/30"
          style={{
            width: `${(r / max) * 100}%`,
            height: `${(r / max) * 100}%`,
            background: i === clean.length - 1 ? "radial-gradient(circle, color-mix(in oklab, var(--color-brand) 12%, transparent), transparent 70%)" : undefined,
          }}
        >
          <span className="num absolute -top-2.5 left-1/2 -translate-x-1/2 rounded bg-ink-800 px-1 text-[12px] leading-4 text-fg-muted">{formatDistance(r)}</span>
        </div>
      ))}
      <div
        className="absolute inset-0 animate-radar rounded-full"
        style={{
          background: "conic-gradient(from 0deg, color-mix(in oklab, var(--color-brand) 22%, transparent), transparent 70deg)",
          maskImage: "radial-gradient(circle, black 69%, transparent 70.5%)",
          WebkitMaskImage: "radial-gradient(circle, black 69%, transparent 70.5%)",
        }}
      />
      <span className="absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand shadow-[0_0_20px_var(--color-brand)]" />
    </div>
  );
}

const SummaryHint = ({ children }: { children: React.ReactNode }) => <span className="text-[12.5px] font-normal text-fg-muted">{children}</span>;

export function DispatchSettingsForm({
  settings,
  readOnly,
  commissionNote,
}: {
  settings: OrgSettings;
  readOnly: boolean;
  /** Mode centrale : la commission se règle ailleurs (« Commission & encaissement ») — remplace la carte. */
  commissionNote?: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const initial = useMemo<OrgSettings>(() => ({ ...SETTINGS_DEFAULTS, ...settings }), [settings]);
  const [baseline, setBaseline] = useState<OrgSettings>(initial);
  const [s, setS] = useState<OrgSettings>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [commission, setCommission] = useState(initial.driver_commission_percent == null ? "" : String(initial.driver_commission_percent).replace(".", ","));
  const set = <K extends keyof OrgSettings>(k: K, v: OrgSettings[K]) => {
    setS((cur) => ({ ...cur, [k]: v }));
    setErrors((cur) => Object.fromEntries(Object.entries(cur).filter(([key]) => key !== k && !key.startsWith(`${String(k)}.`))));
  };
  /** Erreur d'un réglage (ou d'une de ses cases : « dispatch_radii_m.2 »). */
  const err = (k: string) => errors[k] ?? Object.entries(errors).find(([key]) => key.startsWith(`${k}.`))?.[1];
  const has = (keys: string[]) => keys.some((k) => !!err(k));
  const dirty = JSON.stringify(s) !== JSON.stringify(baseline);
  const pct = s.driver_commission_percent;
  const sample = 5000;

  /** Contrôle local (même schéma que le serveur) ; champ vidé : « Indiquez un nombre ». */
  const validate = () => {
    const parsed = orgSettingsSchema.safeParse(s);
    const out: Record<string, string> = parsed.success ? {} : zodFieldErrors(parsed.error);
    for (const k of NUMERIC_KEYS) if (Number.isNaN(s[k] as number)) out[k] = "Indiquez un nombre";
    if (s.dispatch_radii_m.some((r) => Number.isNaN(r))) out.dispatch_radii_m = "Indiquez la distance de chaque vague";
    if (s.dispatch_retry_radii_m.some((r) => Number.isNaN(r))) out.dispatch_retry_radii_m = "Indiquez la distance de chaque relance";
    return out;
  };

  const save = () => {
    const local = validate();
    if (Object.keys(local).length) {
      setErrors(local);
      toast.error("Vérifiez les réglages signalés.");
      return;
    }
    start(() =>
      runAction(async () => {
        const res = await updateDispatchSettings(s);
        if (!res.ok) {
          setErrors(res.fieldErrors ?? {});
          toast.error(res.error ?? "Enregistrement impossible.");
          return;
        }
        setErrors({});
        toast.success("Réglages enregistrés");
        setBaseline(s);
        router.refresh();
      }),
    );
  };
  const reset = () => {
    setS(baseline);
    setErrors({});
    setCommission(baseline.driver_commission_percent == null ? "" : String(baseline.driver_commission_percent).replace(".", ","));
  };

  const flightSummary = s.flight_tracking_enabled
    ? `Activé · marge de ${Number.isNaN(s.flight_pickup_buffer_minutes) ? "…" : s.flight_pickup_buffer_minutes}${NB}min`
    : "Désactivé";
  const alertSummary = `Retard au-delà de ${Number.isNaN(s.late_alert_tolerance_minutes) ? "…" : s.late_alert_tolerance_minutes}${NB}min · immobile ${
    Number.isNaN(s.stalled_alert_minutes) ? "…" : s.stalled_alert_minutes
  }${NB}min`;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-6">
        <Card>
          <CardHeader
            title="Recherche d'un chauffeur"
            description={`Les chauffeurs proches sont prévenus zone par zone, de plus en plus loin${NB}; le premier qui accepte prend la course.`}
          />
          <CardBody className="space-y-6">
            <SwitchRow
              title="Dispatch automatique"
              hintOn="Chaque nouvelle course est proposée aux chauffeurs proches, sans intervention."
              hintOff="Chaque course attend que vous l'attribuiez vous-même."
              checked={s.auto_dispatch}
              onCheckedChange={(v) => set("auto_dispatch", v)}
              disabled={readOnly}
            />

            <ZonesEditor
              legend="Zones de recherche successives"
              hint="Une vague par zone, de la plus proche à la plus large (distance autour du départ)."
              value={s.dispatch_radii_m}
              onChange={(v) => set("dispatch_radii_m", v)}
              readOnly={readOnly}
              min={1}
              max={8}
              noun="vague"
              error={err("dispatch_radii_m")}
            />

            <ZonesEditor
              legend="Relance si personne n'a accepté"
              hint="Les chauffeurs restés sans réponse sont de nouveau prévenus, zone par zone."
              value={s.dispatch_retry_radii_m}
              onChange={(v) => set("dispatch_retry_radii_m", v)}
              readOnly={readOnly}
              min={0}
              max={4}
              noun="relance"
              error={err("dispatch_retry_radii_m")}
              empty="Aucune relance : la recherche s'arrête après la dernière vague."
            />

            {/* Téléphone et tablette : déroulé sous les zones (grand écran : carte à droite) */}
            <div className="rounded-xl bg-white/[0.03] px-4 py-3 xl:hidden">
              <p className="mb-2 text-[12.5px] font-medium text-fg">Déroulé de la recherche</p>
              <WavePlan radii={s.dispatch_radii_m} retry={s.dispatch_retry_radii_m} timeout={s.offer_timeout_seconds} />
            </div>

            <Field
              label="Temps laissé aux chauffeurs pour accepter"
              hint={`Chaque vague dure ce temps, même sans chauffeur${NB}; ensuite, la suivante élargit la zone.`}
              error={err("offer_timeout_seconds")}
            >
              <NumberUnit
                unit="secondes"
                min={10}
                max={600}
                value={shown(s.offer_timeout_seconds)}
                disabled={readOnly}
                onChange={(e) => set("offer_timeout_seconds", num(e.target.value))}
              />
            </Field>

            <fieldset>
              <legend className="text-[13px] font-medium text-fg">Rappels au chauffeur avant une course planifiée</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {REMINDERS.map((r) => {
                  const on = s.reminder_offsets_minutes.includes(r.v);
                  return (
                    <button
                      key={r.v}
                      type="button"
                      disabled={readOnly}
                      aria-pressed={on}
                      onClick={() =>
                        set("reminder_offsets_minutes", on ? s.reminder_offsets_minutes.filter((x) => x !== r.v) : [...s.reminder_offsets_minutes, r.v].sort((a, b) => b - a))
                      }
                      className={cn(
                        "min-h-10 rounded-lg border px-3 text-[13px] transition-colors disabled:opacity-60 max-sm:min-h-11",
                        on ? "border-brand/50 bg-brand/[0.08] text-brand" : "border-line text-fg-muted hover:text-fg",
                      )}
                    >
                      {r.label}
                    </button>
                  );
                })}
              </div>
              {err("reminder_offsets_minutes") && <p className="mt-1.5 text-xs text-red">{err("reminder_offsets_minutes")}</p>}
            </fieldset>

            <Field label="Paiement par défaut" hint="Proposé à la saisie d'une course." error={err("default_payment_method")} className="sm:max-w-xs">
              <NativeSelect value={s.default_payment_method} disabled={readOnly} onChange={(e) => set("default_payment_method", e.target.value as never)}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </NativeSelect>
            </Field>

            <SwitchRow
              title="Surclassement autorisé"
              hintOn="Un véhicule Business peut prendre une course Berline."
              hintOff="Chaque course n'est proposée qu'aux véhicules de sa catégorie."
              checked={s.allow_category_upgrade}
              onCheckedChange={(v) => set("allow_category_upgrade", v)}
              disabled={readOnly}
            />

            <Disclosure
              title="Réglages avancés"
              hint={<SummaryHint>Seuils, vols, alertes</SummaryHint>}
              forceOpen={has([...ADVANCED_KEYS, ...FLIGHT_KEYS, ...ALERT_KEYS])}
              id="reglages-avances"
              className="rounded-xl border border-line px-4"
              contentClassName="space-y-5 pb-4 pt-1"
            >
              <div className="grid gap-4 md:grid-cols-2">
                <Field
                  label="Une course est immédiate si le départ est dans moins de"
                  hint="Au-delà, elle est planifiée : d'abord proposée à toute la flotte."
                  error={err("instant_threshold_minutes")}
                >
                  <NumberUnit
                    unit="min"
                    min={0}
                    max={720}
                    value={shown(s.instant_threshold_minutes)}
                    disabled={readOnly}
                    onChange={(e) => set("instant_threshold_minutes", num(e.target.value))}
                  />
                </Field>
                <Field
                  label="Course réservée à l'avance sans chauffeur : chercher un chauffeur proche"
                  hint="Puis la recherche zone par zone, comme pour une course immédiate."
                  error={err("scheduled_dispatch_lead_minutes")}
                >
                  <NumberUnit
                    unit="min avant le départ"
                    min={5}
                    max={1440}
                    value={shown(s.scheduled_dispatch_lead_minutes)}
                    disabled={readOnly}
                    onChange={(e) => set("scheduled_dispatch_lead_minutes", num(e.target.value))}
                  />
                </Field>
                <Field label="Chauffeurs prévenus au maximum à chaque vague" error={err("max_offers_per_wave")}>
                  <NumberUnit
                    unit="chauffeurs"
                    min={1}
                    max={500}
                    value={shown(s.max_offers_per_wave)}
                    disabled={readOnly}
                    onChange={(e) => set("max_offers_per_wave", num(e.target.value))}
                  />
                </Field>
                <Field
                  label="Ignorer un chauffeur dont la position date de plus de"
                  hint={`Moins de 2${NB}min compte pour 2${NB}min. Application fermée : le chauffeur passe hors ligne après 3${NB}min.`}
                  error={err("location_max_age_seconds")}
                >
                  <NumberUnit
                    unit="secondes"
                    min={30}
                    max={3600}
                    value={shown(s.location_max_age_seconds)}
                    disabled={readOnly}
                    onChange={(e) => set("location_max_age_seconds", num(e.target.value))}
                  />
                </Field>
              </div>

              <Disclosure
                title="Suivi des vols"
                hint={<SummaryHint>{flightSummary}</SummaryHint>}
                forceOpen={has(FLIGHT_KEYS)}
                className="border-t border-line"
                contentClassName="space-y-4 pb-2"
              >
                <p className="text-[12.5px] text-fg-muted">Courses au départ d&apos;un aéroport avec un numéro de vol : l&apos;heure de prise en charge suit l&apos;arrivée réelle.</p>
                <SwitchRow
                  title="Suivre les vols"
                  hint={`Retard, avance, atterrissage, annulation${NB}: vous et le chauffeur êtes prévenus.`}
                  checked={s.flight_tracking_enabled}
                  onCheckedChange={(v) => set("flight_tracking_enabled", v)}
                  disabled={readOnly}
                />
                <Field
                  label="Marge après l'atterrissage"
                  hint={`Appliquée si l'heure demandée précède l'atterrissage ou si l'horaire prévu est inconnu${NB}; sinon, la prise en charge suit le retard du vol.`}
                  error={err("flight_pickup_buffer_minutes")}
                >
                  <NumberUnit
                    unit="min"
                    min={0}
                    max={120}
                    value={shown(s.flight_pickup_buffer_minutes)}
                    disabled={readOnly || !s.flight_tracking_enabled}
                    onChange={(e) => set("flight_pickup_buffer_minutes", num(e.target.value))}
                  />
                </Field>
                <p className="rounded-xl bg-white/[0.03] px-3.5 py-3 text-[12.5px] leading-[19px] text-fg-muted">
                  <span className="font-medium text-fg">Exemple{NB}:</span> vol prévu à <span className="num text-fg">14:45</span>, client attendu à{" "}
                  <span className="num text-fg">15:00</span>. Le vol a <span className="num text-fg">35{NB}min</span> de retard : prise en charge décalée à{" "}
                  <span className="num font-semibold text-fg">15:35</span>, chauffeur prévenu.
                </p>
              </Disclosure>

              <Disclosure
                title="Alertes de suivi"
                hint={<SummaryHint>{alertSummary}</SummaryHint>}
                forceOpen={has(ALERT_KEYS)}
                className="border-t border-line"
                contentClassName="space-y-4 pb-2"
              >
                <p className="text-[12.5px] text-fg-muted">
                  Une alerte sonne au tableau de bord{NB}; vous décidez{NB}: relancer, réattribuer ou garder le chauffeur.
                </p>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field
                    label="Tolérance de retard"
                    hint={`Alerte si le chauffeur arrivera au départ avec plus de ${Number.isNaN(s.late_alert_tolerance_minutes) ? "…" : s.late_alert_tolerance_minutes}${NB}min de retard (urgente au-delà de 15${NB}min).`}
                    error={err("late_alert_tolerance_minutes")}
                  >
                    <NumberUnit
                      unit="min"
                      min={1}
                      max={60}
                      value={shown(s.late_alert_tolerance_minutes)}
                      disabled={readOnly}
                      onChange={(e) => set("late_alert_tolerance_minutes", num(e.target.value))}
                    />
                  </Field>
                  <Field label="Chauffeur immobile depuis" hint="En route, à plus de 800 m du départ, sans avancer (bouchons compris)." error={err("stalled_alert_minutes")}>
                    <NumberUnit
                      unit="min"
                      min={2}
                      max={30}
                      value={shown(s.stalled_alert_minutes)}
                      disabled={readOnly}
                      onChange={(e) => set("stalled_alert_minutes", num(e.target.value))}
                    />
                  </Field>
                </div>
                <p className="text-[12.5px] text-fg-muted">
                  <span className="font-medium text-fg">Aussi surveillés{NB}:</span> GPS muet pendant une course, chauffeur pas parti moins de 30{NB}min avant
                  une course planifiée.
                </p>
              </Disclosure>
            </Disclosure>
          </CardBody>
        </Card>

        {commissionNote ?? (
          <Card>
            <CardHeader
              icon={<Percent />}
              title="Commission chauffeur"
              description={`Votre part sur le prix de chaque course${NB}: l'application chauffeur affiche les gains nets.`}
            />
            <CardBody className="grid gap-5 sm:grid-cols-[220px_minmax(0,1fr)] sm:items-start">
              <Field label="Commission chauffeur (%)" hint="Vide = aucune commission." error={err("driver_commission_percent")}>
                <Input
                  type="text"
                  inputMode="decimal"
                  placeholder="Aucune"
                  value={commission}
                  disabled={readOnly}
                  className="num"
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^\d.,]/g, "").slice(0, 6);
                    setCommission(v);
                    set("driver_commission_percent", v.trim() === "" ? null : Math.round(num(v) * 100) / 100);
                  }}
                />
              </Field>
              <div className="rounded-xl bg-white/[0.03] px-4 py-3.5 sm:mt-[26px]">
                {pct == null || Number.isNaN(pct) ? (
                  <p className="text-[12.5px] text-fg-muted">Sans commission, le chauffeur voit le prix des courses (chiffre d&apos;affaires brut).</p>
                ) : (
                  <p className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-[13px] text-fg-muted">
                    <span>
                      Course à <span className="num text-fg">{formatPrice(sample)}</span>
                    </span>
                    <span>
                      Votre part <span className="num text-fg">{formatPrice(Math.round((sample * pct) / 100))}</span>
                    </span>
                    <span>
                      Net chauffeur <span className="num font-semibold text-fg">{formatPrice(sample - Math.round((sample * pct) / 100))}</span>
                    </span>
                  </p>
                )}
              </div>
            </CardBody>
          </Card>
        )}

        {!readOnly && (
          <div data-tour-avoid="" className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line-strong bg-ink-700/[0.97] px-4 py-3 shadow-float backdrop-blur-xl">
            <p className="flex items-center gap-2 text-[13px] text-fg-muted" aria-live="polite">
              <span aria-hidden className={cn("size-1.5 rounded-full", dirty ? "bg-amber" : "bg-green")} />
              {dirty ? "Modifications non enregistrées" : "Tout est enregistré"}
            </p>
            <div className="flex flex-wrap gap-2">
              {dirty && (
                <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={pending}>
                  Annuler les modifications
                </Button>
              )}
              <Button type="button" variant="primary" size="sm" loading={pending} disabled={!dirty} onClick={save}>
                Enregistrer
              </Button>
            </div>
          </div>
        )}
        {!readOnly && <UnsavedGuard dirty={dirty} />}
      </div>

      <Card className="hidden h-fit xl:block">
        <CardHeader title="Aperçu des vagues" description="Chaque cercle est une zone de recherche." />
        <CardBody className="space-y-4">
          <RadiiPreview radii={s.dispatch_radii_m} />
          <WavePlan radii={s.dispatch_radii_m} retry={s.dispatch_retry_radii_m} timeout={s.offer_timeout_seconds} />
        </CardBody>
      </Card>
    </div>
  );
}
