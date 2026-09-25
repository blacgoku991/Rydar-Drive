"use client";
import {
  PAYMENT_METHOD_LABELS, PAYMENT_METHODS, VEHICLE_CATEGORIES, VEHICLE_CATEGORY_META, formatDistance, formatPrice,
  type OrgSettings, type VehicleCategory,
} from "@rydar/shared";
import { BellRing, Percent, Plane, Plus, Trash2, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { inviteMember, savePricingRule, updateDispatchSettings, updateMember, updateOrganization } from "@/app/dashboard/settings/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { Avatar, Switch } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

function useSave() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const save = (fn: () => Promise<{ ok: boolean; error?: string }>, msg = "Enregistré") =>
    start(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error ?? "Erreur");
      else {
        toast.success(msg);
        router.refresh();
      }
    });
  return { pending, save };
}

// ---------------------------------------------------------------- Organisation
export function OrganizationForm({ org, readOnly }: { org: any; readOnly: boolean }) {
  const { pending, save } = useSave();
  return (
    <Card>
      <CardHeader title="Identité de la centrale" description="Affichée dans l'application chauffeur, les factures et le mini-site." />
      <CardBody>
        <form
          action={(f) => {
            const g = (k: string) => String(f.get(k) ?? "");
            save(() => updateOrganization({ name: g("name"), legalName: g("legalName"), siret: g("siret"), email: g("email"), phone: g("phone"), address: g("address"), city: g("city"), postalCode: g("postalCode") }));
          }}
          className="grid gap-4 sm:grid-cols-2"
        >
          <Field label="Nom commercial"><Input name="name" defaultValue={org.name} disabled={readOnly} /></Field>
          <Field label="Raison sociale" optional><Input name="legalName" defaultValue={org.legal_name ?? ""} disabled={readOnly} /></Field>
          <Field label="SIRET" optional><Input name="siret" defaultValue={org.siret ?? ""} className="num" disabled={readOnly} /></Field>
          <Field label="E-mail" optional><Input name="email" defaultValue={org.email ?? ""} disabled={readOnly} /></Field>
          <Field label="Téléphone" optional><Input name="phone" defaultValue={org.phone ?? ""} disabled={readOnly} /></Field>
          <Field label="Adresse" optional><Input name="address" defaultValue={org.address ?? ""} disabled={readOnly} /></Field>
          <Field label="Ville" optional><Input name="city" defaultValue={org.city ?? ""} disabled={readOnly} /></Field>
          <Field label="Code postal" optional><Input name="postalCode" defaultValue={org.postal_code ?? ""} disabled={readOnly} /></Field>
          {!readOnly && (
            <div className="sm:col-span-2 flex justify-end">
              <Button type="submit" variant="primary" loading={pending}>Enregistrer</Button>
            </div>
          )}
        </form>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------- Dispatch
const REMINDERS = [
  { v: 1440, label: "24 h avant" },
  { v: 180, label: "3 h avant" },
  { v: 60, label: "1 h avant" },
  { v: 30, label: "30 min avant" },
];

function RadiiPreview({ radii }: { radii: number[] }) {
  const max = Math.max(...radii, 1);
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[260px]">
      {[...radii].reverse().map((r, i) => (
        <div
          key={`${r}-${i}`}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-brand/30"
          style={{ width: `${(r / max) * 100}%`, height: `${(r / max) * 100}%`, background: i === radii.length - 1 ? "radial-gradient(circle, rgb(200 240 60 / 0.12), transparent 70%)" : undefined }}
        >
          <span className="num absolute -top-2 left-1/2 -translate-x-1/2 rounded bg-ink-800 px-1 text-[10px] text-fg-muted">{formatDistance(r)}</span>
        </div>
      ))}
      <div className="absolute inset-0 animate-radar rounded-full" style={{ background: "conic-gradient(from 0deg, rgb(200 240 60 / 0.22), transparent 70deg)", maskImage: "radial-gradient(circle, black 69%, transparent 70.5%)", WebkitMaskImage: "radial-gradient(circle, black 69%, transparent 70.5%)" }} />
      <span className="absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand shadow-[0_0_20px_var(--color-brand)]" />
    </div>
  );
}

/** Réglages ajoutés par les migrations 002100 / 002200 / 002400 : valeurs par défaut si la ligne est ancienne. */
const SETTINGS_DEFAULTS = {
  flight_tracking_enabled: true,
  flight_pickup_buffer_minutes: 15,
  late_alert_tolerance_minutes: 5,
  stalled_alert_minutes: 4,
  driver_commission_percent: null,
} satisfies Partial<OrgSettings>;

/** Entrée numérique avec unité à droite (« min », « % »). */
function UnitInput({ unit, className, ...props }: React.ComponentProps<typeof Input> & { unit: string }) {
  return (
    <div className="relative">
      <Input
        inputMode="decimal"
        {...props}
        className={cn("num pr-12 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none", className)}
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12.5px] text-fg-subtle">{unit}</span>
    </div>
  );
}

function SwitchRow({ title, hint, checked, onChange, disabled }: { title: string; hint: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-xl border border-line bg-white/[0.02] px-4 py-3">
      <span>
        <span className="block text-[13.5px] font-medium">{title}</span>
        <span className="block text-[12px] text-fg-subtle">{hint}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </label>
  );
}

const num = (v: string) => (v.trim() === "" ? Number.NaN : Number(v.replace(",", ".")));

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
  const [commission, setCommission] = useState(initial.driver_commission_percent == null ? "" : String(initial.driver_commission_percent).replace(".", ","));
  const set = <K extends keyof OrgSettings>(k: K, v: OrgSettings[K]) => setS((cur) => ({ ...cur, [k]: v }));
  const radiiKm = s.dispatch_radii_m.map((m) => m / 1000);
  const dirty = JSON.stringify(s) !== JSON.stringify(baseline);
  const pct = s.driver_commission_percent;
  const sample = 5000;

  const save = () =>
    start(async () => {
      const res = await updateDispatchSettings(s);
      if (!res.ok) return void toast.error(res.error ?? "Erreur");
      toast.success("Réglages enregistrés");
      setBaseline(s);
      router.refresh();
    });
  const reset = () => {
    setS(baseline);
    setCommission(baseline.driver_commission_percent == null ? "" : String(baseline.driver_commission_percent).replace(".", ","));
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
      <div className="min-w-0 space-y-6">
      <Card>
        <CardHeader title="Moteur de dispatch" description="Recherche GPS par vagues successives — premier chauffeur qui accepte." />
        <CardBody className="space-y-7">
          <label className="flex items-center justify-between gap-4 rounded-xl border border-line bg-white/[0.02] px-4 py-3">
            <span>
              <span className="block text-[13.5px] font-medium">Dispatch automatique</span>
              <span className="block text-[12px] text-fg-subtle">Désactivé : chaque course attend une attribution manuelle.</span>
            </span>
            <Switch checked={s.auto_dispatch} onCheckedChange={(v) => set("auto_dispatch", v)} disabled={readOnly} />
          </label>

          <div>
            <p className="mb-2 text-[12.5px] font-medium text-fg-muted">Rayons de recherche (km), par vague</p>
            <div className="flex flex-wrap items-center gap-2">
              {radiiKm.map((km, i) => (
                <div key={i} className="flex items-center gap-1">
                  <Input
                    type="number"
                    step="0.5"
                    min={0.5}
                    value={km}
                    disabled={readOnly}
                    onChange={(e) => set("dispatch_radii_m", s.dispatch_radii_m.map((m, j) => (j === i ? Math.round(Number(e.target.value) * 1000) : m)))}
                    className="num h-9 w-20 text-center"
                  />
                  {!readOnly && s.dispatch_radii_m.length > 1 && (
                    <button type="button" onClick={() => set("dispatch_radii_m", s.dispatch_radii_m.filter((_, j) => j !== i))} className="text-fg-subtle hover:text-red" aria-label="Retirer">
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                  {i < radiiKm.length - 1 && <span className="px-1 text-fg-subtle">→</span>}
                </div>
              ))}
              {!readOnly && s.dispatch_radii_m.length < 8 && (
                <Button type="button" variant="outline" size="sm" onClick={() => set("dispatch_radii_m", [...s.dispatch_radii_m, Math.min(100000, (s.dispatch_radii_m.at(-1) ?? 0) + 4000)])}>
                  <Plus /> Vague
                </Button>
              )}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Délai de réponse par vague (s)" hint="Au-delà, la vague suivante élargit le rayon.">
              <Input type="number" min={10} max={600} value={s.offer_timeout_seconds} disabled={readOnly} onChange={(e) => set("offer_timeout_seconds", Number(e.target.value))} className="num" />
            </Field>
            <Field label="Durée maximale de recherche (min)" hint="Ensuite : statut « Sans chauffeur » et alerte.">
              <Input type="number" min={1} max={120} value={Math.round(s.max_search_seconds / 60)} disabled={readOnly} onChange={(e) => set("max_search_seconds", Number(e.target.value) * 60)} className="num" />
            </Field>
            <Field label="Course instantanée si départ dans moins de (min)">
              <Input type="number" min={0} max={720} value={s.instant_threshold_minutes} disabled={readOnly} onChange={(e) => set("instant_threshold_minutes", Number(e.target.value))} className="num" />
            </Field>
            <Field label="Planifiée non attribuée : recherche GPS à T- (min)">
              <Input type="number" min={5} max={1440} value={s.scheduled_dispatch_lead_minutes} disabled={readOnly} onChange={(e) => set("scheduled_dispatch_lead_minutes", Number(e.target.value))} className="num" />
            </Field>
            <Field label="Chauffeurs notifiés max. par vague">
              <Input type="number" min={1} max={500} value={s.max_offers_per_wave} disabled={readOnly} onChange={(e) => set("max_offers_per_wave", Number(e.target.value))} className="num" />
            </Field>
            <Field label="Position GPS considérée fraîche (s)">
              <Input type="number" min={30} max={3600} value={s.location_max_age_seconds} disabled={readOnly} onChange={(e) => set("location_max_age_seconds", Number(e.target.value))} className="num" />
            </Field>
          </div>

          <div>
            <p className="mb-2 text-[12.5px] font-medium text-fg-muted">Rappels chauffeur (courses planifiées)</p>
            <div className="flex flex-wrap gap-2">
              {REMINDERS.map((r) => {
                const on = s.reminder_offsets_minutes.includes(r.v);
                return (
                  <button
                    key={r.v}
                    type="button"
                    disabled={readOnly}
                    onClick={() => set("reminder_offsets_minutes", on ? s.reminder_offsets_minutes.filter((x) => x !== r.v) : [...s.reminder_offsets_minutes, r.v].sort((a, b) => b - a))}
                    className={cn("rounded-lg border px-3 py-1.5 text-[12.5px]", on ? "border-brand/50 bg-brand/[0.08] text-brand" : "border-line text-fg-muted")}
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-4 rounded-xl border border-line bg-white/[0.02] px-4 py-3">
              <span>
                <span className="block text-[13px] font-medium">Surclassement autorisé</span>
                <span className="block text-[12px] text-fg-subtle">Une Business peut prendre une course Berline.</span>
              </span>
              <Switch checked={s.allow_category_upgrade} onCheckedChange={(v) => set("allow_category_upgrade", v)} disabled={readOnly} />
            </label>
            <Field label="Paiement par défaut">
              <NativeSelect value={s.default_payment_method} disabled={readOnly} onChange={(e) => set("default_payment_method", e.target.value as never)}>
                {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
              </NativeSelect>
            </Field>
          </div>

        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            icon={<Plane />}
            title="Suivi des vols"
            description="Courses au départ d'un aéroport avec un numéro de vol : l'heure de prise en charge suit l'arrivée réelle."
          />
          <CardBody className="space-y-5">
            <SwitchRow
              title="Suivre les vols"
              hint="Retard, avance, atterrissage, annulation : la centrale et le chauffeur sont prévenus."
              checked={s.flight_tracking_enabled}
              onChange={(v) => set("flight_tracking_enabled", v)}
              disabled={readOnly}
            />
            <Field
              label="Marge après l'atterrissage"
              hint="Marge appliquée si l'heure demandée précède l'atterrissage ou si l'horaire prévu est inconnu ; sinon la prise en charge suit le retard du vol."
            >
              <UnitInput
                unit="min"
                type="number"
                min={0}
                max={120}
                value={Number.isNaN(s.flight_pickup_buffer_minutes) ? "" : s.flight_pickup_buffer_minutes}
                disabled={readOnly || !s.flight_tracking_enabled}
                onChange={(e) => set("flight_pickup_buffer_minutes", num(e.target.value))}
              />
            </Field>
            <div className="rounded-xl bg-white/[0.03] px-3.5 py-3 text-[12.5px] leading-[19px] text-fg-muted">
              <p className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-fg-subtle">Exemple</p>
              Vol prévu à <span className="num text-fg">14:45</span>, client attendu à <span className="num text-fg">15:00</span>. Le vol a{" "}
              <span className="num text-amber">35 min</span> de retard : prise en charge décalée à <span className="num font-semibold text-fg">15:35</span>, chauffeur prévenu.
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            icon={<BellRing />}
            title="Alertes de suivi"
            description="Son + alerte au dashboard ; la centrale décide : relancer, réattribuer ou garder le chauffeur."
          />
          <CardBody className="space-y-5">
            <Field
              label="Tolérance de retard"
              hint={`Alerte si le chauffeur arrivera au départ avec plus de ${Number.isNaN(s.late_alert_tolerance_minutes) ? "…" : s.late_alert_tolerance_minutes} min de retard (urgente au-delà de 15 min).`}
            >
              <UnitInput
                unit="min"
                type="number"
                min={1}
                max={60}
                value={Number.isNaN(s.late_alert_tolerance_minutes) ? "" : s.late_alert_tolerance_minutes}
                disabled={readOnly}
                onChange={(e) => set("late_alert_tolerance_minutes", num(e.target.value))}
              />
            </Field>
            <Field label="Chauffeur immobile depuis" hint="En route, à plus de 800 m du départ, sans avancer (bouchons compris).">
              <UnitInput
                unit="min"
                type="number"
                min={2}
                max={30}
                value={Number.isNaN(s.stalled_alert_minutes) ? "" : s.stalled_alert_minutes}
                disabled={readOnly}
                onChange={(e) => set("stalled_alert_minutes", num(e.target.value))}
              />
            </Field>
            <p className="rounded-xl bg-white/[0.03] px-3.5 py-3 text-[12.5px] leading-[19px] text-fg-muted">
              <span className="font-medium text-fg">Aussi surveillés :</span> GPS muet pendant une course, chauffeur pas parti moins de 30 min avant une planifiée.
            </p>
          </CardBody>
        </Card>
      </div>

      {commissionNote ?? (
      <Card>
        <CardHeader icon={<Percent />} title="Commission chauffeur" description="Part de la centrale sur le prix de chaque course : l'app chauffeur affiche les gains nets." />
        <CardBody className="grid gap-5 sm:grid-cols-[220px_1fr] sm:items-start">
          <Field label="Commission chauffeur (%)" hint="Vide = aucune commission.">
            <UnitInput
              unit="%"
              type="text"
              placeholder="Aucune"
              value={commission}
              disabled={readOnly}
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
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5 text-[12.5px] text-fg-muted">
                <span>
                  Course à <span className="num text-fg">{formatPrice(sample)}</span>
                </span>
                <span>
                  Centrale <span className="num text-fg">{formatPrice(Math.round((sample * pct) / 100))}</span>
                </span>
                <span>
                  Net chauffeur <span className="num text-[14px] font-semibold text-brand">{formatPrice(sample - Math.round((sample * pct) / 100))}</span>
                </span>
              </div>
            )}
          </div>
        </CardBody>
      </Card>
      )}

      {!readOnly && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line-strong bg-ink-700/[0.97] px-4 py-3 shadow-float backdrop-blur-xl">
          <p className="flex items-center gap-2 text-[12.5px] text-fg-muted">
            <span className={cn("size-1.5 rounded-full", dirty ? "bg-amber" : "bg-green")} />
            {dirty ? "Modifications non enregistrées" : "Tout est enregistré"}
          </p>
          <div className="flex gap-2">
            {dirty && (
              <Button variant="ghost" size="sm" onClick={reset} disabled={pending}>
                Annuler
              </Button>
            )}
            <Button variant="primary" size="sm" loading={pending} disabled={!dirty} onClick={save}>
              Enregistrer
            </Button>
          </div>
        </div>
      )}
      </div>

      <Card className="h-fit">
        <CardHeader title="Aperçu des vagues" description="Chaque cercle = une vague de notifications." />
        <CardBody className="space-y-4">
          <RadiiPreview radii={s.dispatch_radii_m} />
          <ol className="space-y-1.5 text-[12.5px] text-fg-muted">
            {s.dispatch_radii_m.map((r, i) => (
              <li key={i} className="flex justify-between">
                <span>Vague {i + 1} · rayon {formatDistance(r)}</span>
                <span className="num text-fg-subtle">T+{i * s.offer_timeout_seconds} s</span>
              </li>
            ))}
            <li className="flex justify-between border-t border-line pt-1.5">
              <span>Puis nouvelles tentatives</span>
              <span className="num text-fg-subtle">≤ {Math.round(s.max_search_seconds / 60)} min</span>
            </li>
          </ol>
        </CardBody>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- Tarifs
export function PricingEditor({ rules, readOnly }: { rules: any[]; readOnly: boolean }) {
  const { pending, save } = useSave();
  const byCat = new Map(rules.map((r) => [r.vehicle_category, r]));
  return (
    <Card>
      <CardHeader title="Grille tarifaire" description="Sert à suggérer le prix à la saisie et à l'estimation du mini-site. Le prix final reste modifiable." />
      <div className="divide-y divide-line">
        {VEHICLE_CATEGORIES.map((cat) => {
          const r = byCat.get(cat) ?? { base_fare_cents: 1000, per_km_cents: 200, per_minute_cents: 50, minimum_fare_cents: 3000, night_surcharge_percent: 15, fixed_fares: [] };
          return (
            <form
              key={cat}
              action={(f) => {
                const n = (k: string) => Math.round(Number(String(f.get(k) ?? "0").replace(",", ".")) * 100);
                save(() =>
                  savePricingRule({
                    vehicle_category: cat as VehicleCategory,
                    name: VEHICLE_CATEGORY_META[cat].label,
                    base_fare_cents: n("base"),
                    per_km_cents: n("km"),
                    per_minute_cents: n("min"),
                    minimum_fare_cents: n("minimum"),
                    night_surcharge_percent: Number(f.get("night") ?? 0),
                    fixed_fares: r.fixed_fares ?? [],
                  }),
                  `Tarif ${VEHICLE_CATEGORY_META[cat].label} enregistré`,
                );
              }}
              className="grid items-end gap-3 px-5 py-4 md:grid-cols-[150px_repeat(5,1fr)_auto]"
            >
              <div>
                <p className="text-[13.5px] font-semibold">{VEHICLE_CATEGORY_META[cat].label}</p>
                <p className="text-[11.5px] text-fg-subtle">{byCat.has(cat) ? `min. ${formatPrice(r.minimum_fare_cents)}` : "non configuré"}</p>
              </div>
              <Field label="Prise en charge €"><Input name="base" defaultValue={r.base_fare_cents / 100} className="num" disabled={readOnly} /></Field>
              <Field label="€ / km"><Input name="km" defaultValue={r.per_km_cents / 100} className="num" disabled={readOnly} /></Field>
              <Field label="€ / min"><Input name="min" defaultValue={r.per_minute_cents / 100} className="num" disabled={readOnly} /></Field>
              <Field label="Minimum €"><Input name="minimum" defaultValue={r.minimum_fare_cents / 100} className="num" disabled={readOnly} /></Field>
              <Field label="Nuit %"><Input name="night" defaultValue={r.night_surcharge_percent} className="num" disabled={readOnly} /></Field>
              {!readOnly && <Button type="submit" variant="secondary" loading={pending}>Enregistrer</Button>}
            </form>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- Équipe
export function TeamPanel({ members, isOwner, canInvite }: { members: any[]; isOwner: boolean; canInvite: boolean }) {
  const { pending, save } = useSave();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<"admin" | "dispatcher">("dispatcher");
  return (
    <Card>
      <CardHeader
        title="Équipe"
        description="Administrateurs (gestion complète) et dispatchers (courses et chauffeurs)."
        action={canInvite ? <Button variant="primary" size="sm" onClick={() => setOpen(true)}><UserPlus /> Ajouter</Button> : undefined}
      />
      <div className="divide-y divide-line">
        {members.map((m) => (
          <div key={m.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
            <Avatar name={m.user?.full_name ?? m.user?.email ?? "?"} size={34} />
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium">{m.user?.full_name ?? "—"}</p>
              <p className="text-[12px] text-fg-subtle">{m.user?.email}</p>
            </div>
            <Badge tone={m.role === "owner" ? "brand" : m.role === "admin" ? "blue" : "neutral"}>{m.role === "owner" ? "Propriétaire" : m.role === "admin" ? "Administrateur" : "Dispatcher"}</Badge>
            {m.status !== "active" && <Badge tone="red">Désactivé</Badge>}
            {isOwner && m.role !== "owner" && (
              <div className="flex gap-1">
                <Button variant="ghost" size="xs" onClick={() => save(() => updateMember(m.id, { role: m.role === "admin" ? "dispatcher" : "admin" }))}>
                  {m.role === "admin" ? "→ Dispatcher" : "→ Admin"}
                </Button>
                <Button variant="ghost" size="xs" onClick={() => save(() => updateMember(m.id, { status: m.status === "active" ? "disabled" : "active" }))}>
                  {m.status === "active" ? "Désactiver" : "Réactiver"}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Ajouter un membre" description="Sans mot de passe, une invitation est envoyée par e-mail.">
          <form
            action={(f) =>
              save(async () => {
                const res = await inviteMember({ fullName: String(f.get("name")), email: String(f.get("email")), role, password: String(f.get("password") ?? "") });
                if (res.ok) setOpen(false);
                return res;
              }, "Membre ajouté")
            }
            className="space-y-4"
          >
            <Field label="Nom complet"><Input name="name" required /></Field>
            <Field label="E-mail"><Input name="email" type="email" required /></Field>
            <div className="grid grid-cols-2 gap-2">
              {(["dispatcher", "admin"] as const).map((r) => (
                <button key={r} type="button" onClick={() => setRole(r)} className={cn("rounded-xl border p-3 text-left text-[13px]", role === r ? "border-brand/50 bg-brand/[0.06]" : "border-line")}>
                  <span className="block font-medium">{r === "admin" ? "Administrateur" : "Dispatcher"}</span>
                  <span className="block text-[11.5px] text-fg-subtle">{r === "admin" ? "Tout, y compris API et facturation" : "Courses, chauffeurs, carte"}</span>
                </button>
              ))}
            </div>
            <Field label="Mot de passe provisoire" optional hint="Laissez vide pour envoyer une invitation.">
              <Input name="password" type="text" className="num" />
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
              <Button type="submit" variant="primary" loading={pending}>Ajouter</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
