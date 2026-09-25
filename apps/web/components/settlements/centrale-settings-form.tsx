"use client";
// Réglages « Commission & encaissement » (mode centrale, owner / admin) : commission automatique (% + fixe),
// délai de règlement, blocage des retardataires, plafonds, confirmation automatique, moyens et lien de paiement.
// Les frais plateforme sont fixés par Rydar (super admin) : lecture seule.
import {
  SETTLEMENT_LINK_EXAMPLES, centraleSettingsSchema, formatNumber, formatPrice, settlementPaymentLink, settlementRequestMessage,
  type SettlementMethod,
} from "@rydar/shared";
import { Check, ExternalLink, HandCoins, Lock, MessageCircle, Percent, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { updateCentraleSettings } from "@/app/dashboard/settings/actions";
import { METHOD_ICON, SplitBar, SplitLegend, methodLabel } from "@/components/settlements/settlement-ui";
import { centraleIssues } from "@/components/settlements/settings-schema";
import { centsToInput, eurosToCents } from "@/components/settlements/split-preview";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

export type CentraleSettingsRow = {
  driver_commission_percent: number | null;
  driver_commission_fixed_cents: number | null;
  settlement_grace_hours: number;
  settlement_credit_limit_cents: number | null;
  block_unpaid: boolean;
  new_driver_max_price_cents: number | null;
  trust_after_rides: number | null;
  settlement_methods: SettlementMethod[];
  settlement_link: string | null;
  settlement_instructions: string | null;
};

type FormState = {
  pct: string;
  fixed: string;
  grace: string;
  credit: string;
  newMax: string;
  trust: string;
  blockUnpaid: boolean;
  methods: SettlementMethod[];
  link: string;
  instructions: string;
};

const METHODS: SettlementMethod[] = ["link", "cash", "transfer"];
const SAMPLE_PRICE = 5900;
const SAMPLE_AMOUNT = 1900;
const SAMPLE_REF = "C1783";

const fromRow = (s: CentraleSettingsRow): FormState => ({
  pct: s.driver_commission_percent == null ? "" : String(s.driver_commission_percent).replace(".", ","),
  fixed: centsToInput(s.driver_commission_fixed_cents),
  grace: String(s.settlement_grace_hours ?? 24),
  credit: centsToInput(s.settlement_credit_limit_cents),
  newMax: centsToInput(s.new_driver_max_price_cents),
  trust: s.trust_after_rides == null ? "" : String(s.trust_after_rides),
  blockUnpaid: s.block_unpaid ?? true,
  methods: s.settlement_methods?.length ? s.settlement_methods : ["link", "cash"],
  link: s.settlement_link ?? "",
  instructions: s.settlement_instructions ?? "",
});

const num = (v: string) => (v.trim() === "" ? "" : Number(v.trim().replace(",", ".")));
const cents = (v: string) => {
  const c = eurosToCents(v);
  return c == null ? "" : c;
};

/** Entrée avec unité à droite (« % », « € », « h »). */
function UnitInput({ unit, className, ...props }: React.ComponentProps<typeof Input> & { unit: string }) {
  return (
    <div className="relative">
      <Input inputMode="decimal" {...props} className={cn("mono pr-10", className)} />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12.5px] text-fg-subtle">{unit}</span>
    </div>
  );
}

export function CentraleSettingsForm({
  settings,
  platformFee,
  orgName,
  currency = "EUR",
  readOnly,
}: {
  settings: CentraleSettingsRow;
  platformFee: { percent: number; fixed_cents: number };
  orgName: string;
  currency?: string;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const initial = useMemo(() => fromRow(settings), [settings]);
  const [baseline, setBaseline] = useState(initial);
  const [f, setF] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setF((cur) => ({ ...cur, [k]: v }));
    setErrors(({ [k]: _drop, ...rest }) => rest);
  };
  const dirty = JSON.stringify(f) !== JSON.stringify(baseline);

  const input = {
    commissionPercent: num(f.pct),
    commissionFixedCents: cents(f.fixed),
    graceHours: f.grace.trim() === "" ? Number.NaN : Number(f.grace),
    creditLimitCents: cents(f.credit),
    blockUnpaid: f.blockUnpaid,
    newDriverMaxPriceCents: cents(f.newMax),
    trustAfterRides: num(f.trust),
    methods: f.methods,
    link: f.link.trim(),
    instructions: f.instructions,
  };

  // Exemple de répartition (même calcul que la base : frais plateforme puis commission, plafonnés au prix)
  const example = useMemo(() => {
    const pct = typeof input.commissionPercent === "number" && Number.isFinite(input.commissionPercent) ? input.commissionPercent : 0;
    const fixed = typeof input.commissionFixedCents === "number" && Number.isFinite(input.commissionFixedCents) ? input.commissionFixedCents : 0;
    const platform = Math.min(SAMPLE_PRICE, Math.round((SAMPLE_PRICE * platformFee.percent) / 100) + platformFee.fixed_cents);
    const commission = Math.min(SAMPLE_PRICE - platform, Math.round((SAMPLE_PRICE * pct) / 100) + fixed);
    return { price: SAMPLE_PRICE, platform, commission, driver: SAMPLE_PRICE - platform - commission, pct, fixed };
  }, [input.commissionPercent, input.commissionFixedCents, platformFee.percent, platformFee.fixed_cents]);

  const linkPreview = f.link.trim() && /^https:\/\/\S+$/.test(f.link.trim()) ? settlementPaymentLink(f.link.trim(), SAMPLE_AMOUNT, SAMPLE_REF) : null;
  const message = settlementRequestMessage({
    firstName: "Karim",
    organizationName: orgName,
    amountCents: SAMPLE_AMOUNT,
    currency,
    rideNumbers: [1783],
    link: f.methods.includes("link") ? linkPreview : null,
    reference: SAMPLE_REF,
    instructions: f.instructions.trim() || null,
  });
  const feeLabel = [
    platformFee.percent ? `${formatNumber(platformFee.percent, platformFee.percent % 1 ? 1 : 0)} %` : null,
    platformFee.fixed_cents ? formatPrice(platformFee.fixed_cents, currency) : null,
  ].filter(Boolean).join(" + ");

  const save = () => {
    const parsed = centraleSettingsSchema.safeParse(input);
    if (!parsed.success) {
      const issues = centraleIssues(parsed.error);
      setErrors(issues);
      toast.error(Object.values(issues)[0] ?? "Vérifiez les réglages.");
      return;
    }
    start(async () => {
      const res = await updateCentraleSettings(input);
      if (!res.ok) return void toast.error(res.error);
      toast.success("Réglages d'encaissement enregistrés");
      setBaseline(f);
      router.refresh();
    });
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-6">
        {/* ---------------------------------------------------------------- commission */}
        <Card>
          <CardHeader icon={<Percent />} title="Commission de la centrale" description="Calculée sur le prix de chaque course ; modifiable course par course à la création." />
          <CardBody className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Pourcentage du prix" hint="Vide = aucun pourcentage." error={errors.commissionPercent}>
                <UnitInput unit="%" aria-label="Commission : pourcentage du prix" value={f.pct} placeholder="0" disabled={readOnly} onChange={(e) => set("pct", e.target.value.replace(/[^\d.,]/g, "").slice(0, 6))} aria-invalid={!!errors.commissionPercent} />
              </Field>
              <Field label="Montant fixe par course" hint="S'ajoute au pourcentage." error={errors.commissionFixedCents}>
                <UnitInput unit="€" aria-label="Commission : montant fixe par course" value={f.fixed} placeholder="0" disabled={readOnly} onChange={(e) => set("fixed", e.target.value.replace(/[^\d.,]/g, "").slice(0, 9))} aria-invalid={!!errors.commissionFixedCents} />
              </Field>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-white/[0.02] px-4 py-3">
              <span className="flex items-center gap-2.5">
                <Lock className="size-4 text-fg-subtle" />
                <span>
                  <span className="block text-[13px] font-medium">Frais plateforme</span>
                  <span className="block text-[12px] text-fg-subtle">Fixés par Rydar, déduits avant votre commission.</span>
                </span>
              </span>
              <span className="mono shrink-0 text-[14px] font-semibold text-violet">{feeLabel || "Aucun"}</span>
            </div>
            <div className="rounded-xl bg-white/[0.03] px-4 py-3.5">
              <p className="mb-2 text-[11.5px] font-medium uppercase tracking-wide text-fg-subtle">Exemple · course à {formatPrice(SAMPLE_PRICE, currency)}</p>
              <SplitBar split={example} />
              <SplitLegend split={example} currency={currency} className="mt-2" />
              <p className="mt-2 text-[12px] text-fg-subtle">
                Le chauffeur voit « Vous gagnez <span className="mono text-brand">{formatPrice(example.driver, currency)}</span> » dans l&apos;offre. Payée en espèces, il vous doit{" "}
                <span className="mono text-fg-muted">{formatPrice(example.commission + example.platform, currency)}</span> ; payée en ligne, vous lui versez sa part.
              </p>
            </div>
          </CardBody>
        </Card>

        {/* ---------------------------------------------------------------- encaissement */}
        <Card>
          <CardHeader icon={<HandCoins />} title="Encaissement" description="Comment et quand les chauffeurs vous règlent la commission." />
          <CardBody className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-[220px_1fr] sm:items-start">
              <Field label="Délai de règlement" error={errors.graceHours}>
                <UnitInput unit="h" aria-label="Délai de règlement en heures" value={f.grace} disabled={readOnly} onChange={(e) => set("grace", e.target.value.replace(/\D/g, "").slice(0, 3))} aria-invalid={!!errors.graceHours} />
              </Field>
              <p className="rounded-xl bg-white/[0.03] px-3.5 py-2.5 text-[12.5px] leading-[19px] text-fg-muted sm:mt-[26px]">
                {Number(f.grace) === 0
                  ? "0 h : la commission est à régler dès la fin de la course."
                  : `La commission devient « en retard » ${f.grace || "…"} h après la fin de la course${f.blockUnpaid ? " ; le chauffeur ne reçoit alors plus d'offres." : "."}`}
              </p>
            </div>

            <div>
              <p className="mb-2 text-[12.5px] font-medium text-fg-muted">Moyens acceptés</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {METHODS.map((m) => {
                  const Icon = METHOD_ICON[m];
                  const on = f.methods.includes(m);
                  return (
                    <button
                      key={m}
                      type="button"
                      disabled={readOnly}
                      aria-pressed={on}
                      onClick={() => set("methods", on ? f.methods.filter((x) => x !== m) : METHODS.filter((x) => x === m || f.methods.includes(x)))}
                      className={cn(
                        "flex h-11 items-center gap-2.5 rounded-xl border px-3.5 text-left text-[13px] font-medium transition-colors disabled:opacity-60",
                        on ? "border-brand/50 bg-brand/[0.07] text-fg" : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
                      )}
                    >
                      <Icon className={cn("size-4", on ? "text-brand" : "text-fg-subtle")} />
                      <span className="flex-1">{methodLabel(m)}</span>
                      {on && <Check className="size-4 text-brand" />}
                    </button>
                  );
                })}
              </div>
              {errors.methods && <p className="mt-1.5 text-xs text-red">{errors.methods}</p>}
            </div>

            <div className="space-y-2">
              <Field
                label="Lien de paiement"
                optional={!f.methods.includes("link")}
                error={errors.link}
                hint={
                  <>
                    Variables : <code className="mono text-fg-muted">{"{montant}"}</code> (19.00), <code className="mono text-fg-muted">{"{montant_centimes}"}</code> (1900),{" "}
                    <code className="mono text-fg-muted">{"{reference}"}</code> (C1783) — remplacées pour chaque règlement.
                  </>
                }
              >
                <Input
                  value={f.link}
                  disabled={readOnly}
                  onChange={(e) => set("link", e.target.value)}
                  placeholder="https://revolut.me/votre-identifiant/{montant}"
                  aria-label="Lien de paiement"
                  className="mono text-[13px]"
                  aria-invalid={!!errors.link}
                  spellCheck={false}
                />
              </Field>
              {!readOnly && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[12px] text-fg-subtle">Exemples :</span>
                  {SETTLEMENT_LINK_EXAMPLES.map((x) => (
                    <button
                      key={x.label}
                      type="button"
                      onClick={() => set("link", x.value)}
                      title={x.value}
                      className="rounded-full border border-line px-2.5 py-1 text-[12px] text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
                    >
                      {x.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="rounded-xl border border-line bg-white/[0.02] px-3.5 py-3">
                <p className="text-[11.5px] font-medium uppercase tracking-wide text-fg-subtle">Aperçu pour {formatPrice(SAMPLE_AMOUNT, currency)} · réf. {SAMPLE_REF}</p>
                {linkPreview ? (
                  <a href={linkPreview} target="_blank" rel="noopener noreferrer" className="mono mt-1 flex min-w-0 items-center gap-1.5 text-[12.5px] text-blue hover:underline">
                    <span className="truncate">{linkPreview}</span>
                    <ExternalLink className="size-3.5 shrink-0" />
                  </a>
                ) : (
                  <p className="mt-1 text-[12.5px] text-fg-subtle">{f.link.trim() ? "Lien invalide : il doit commencer par https://" : "Aucun lien : les chauffeurs règlent en espèces ou par virement."}</p>
                )}
                {linkPreview && !/\{montant(_centimes)?\}/.test(f.link) && (
                  <p className="mt-1.5 text-[12px] text-amber">Sans {"{montant}"}, le chauffeur devra saisir le montant lui-même.</p>
                )}
              </div>
            </div>

            <Field label="Instructions au chauffeur" optional hint="Affichées avec le montant à régler (application et message WhatsApp)." error={errors.instructions}>
              <Textarea
                value={f.instructions}
                disabled={readOnly}
                maxLength={500}
                onChange={(e) => set("instructions", e.target.value)}
                placeholder="Ex. indiquez la référence (C1783) dans le commentaire du paiement."
                aria-label="Instructions au chauffeur"
                className="min-h-[72px]"
              />
            </Field>
          </CardBody>
        </Card>

        {/* ---------------------------------------------------------------- règles */}
        <Card>
          <CardHeader icon={<ShieldCheck />} title="Blocages & confiance" description="Qui reçoit les courses : les règles sont appliquées automatiquement par le dispatch." />
          <CardBody className="space-y-5">
            <label className="flex items-center justify-between gap-4 rounded-xl border border-line bg-white/[0.02] px-4 py-3">
              <span>
                <span className="block text-[13.5px] font-medium">Bloquer automatiquement les retardataires</span>
                <span className="block text-[12px] text-fg-subtle">Commission en retard ou contestée : plus aucune offre ni acceptation jusqu&apos;au règlement.</span>
              </span>
              <Switch checked={f.blockUnpaid} onCheckedChange={(v) => set("blockUnpaid", v)} disabled={readOnly} aria-label="Bloquer automatiquement les retardataires" />
            </label>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Plafond d'encours" hint="Au-delà, plus d'offres. Vide = aucun." error={errors.creditLimitCents}>
                <UnitInput unit="€" aria-label="Plafond d'encours" value={f.credit} placeholder="Aucun" disabled={readOnly} onChange={(e) => set("credit", e.target.value.replace(/[^\d.,]/g, "").slice(0, 9))} aria-invalid={!!errors.creditLimitCents} />
              </Field>
              <Field label="Prix max. des nouveaux" hint="Courses plus chères : confirmés seulement." error={errors.newDriverMaxPriceCents}>
                <UnitInput unit="€" aria-label="Prix maximum des nouveaux chauffeurs" value={f.newMax} placeholder="Aucun" disabled={readOnly} onChange={(e) => set("newMax", e.target.value.replace(/[^\d.,]/g, "").slice(0, 9))} aria-invalid={!!errors.newDriverMaxPriceCents} />
              </Field>
              <Field label="Confirmé après" hint="Courses réglées, sans impayé. Vide = manuel." error={errors.trustAfterRides}>
                <UnitInput unit="courses" aria-label="Confirmation automatique après N courses réglées" value={f.trust} placeholder="Manuel" disabled={readOnly} onChange={(e) => set("trust", e.target.value.replace(/\D/g, "").slice(0, 4))} className="pr-20" aria-invalid={!!errors.trustAfterRides} />
              </Field>
            </div>
          </CardBody>
        </Card>

        {!readOnly && (
          <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line-strong bg-ink-700/[0.97] px-4 py-3 shadow-float backdrop-blur-xl">
            <p className="flex items-center gap-2 text-[12.5px] text-fg-muted">
              <span className={cn("size-1.5 rounded-full", dirty ? "bg-amber" : "bg-green")} />
              {dirty ? "Modifications non enregistrées" : "Tout est enregistré"}
            </p>
            <div className="flex gap-2">
              {dirty && (
                <Button variant="ghost" size="sm" onClick={() => (setF(baseline), setErrors({}))} disabled={pending}>
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

      {/* ---------------------------------------------------------------- aperçu du message */}
      <Card className="h-fit xl:sticky xl:top-6">
        <CardHeader icon={<MessageCircle />} title="Réclamation WhatsApp" description="Message prérempli envoyé depuis Encaissements (exemple)." />
        <CardBody>
          <div className="rounded-2xl rounded-tl-md bg-[#0f2a1d] px-3.5 py-3 text-[12.5px] leading-[19px] text-[#d9fbe6] shadow-[inset_0_0_0_1px_rgb(79_213_143/0.18)]">
            <p className="whitespace-pre-wrap break-words">{message}</p>
          </div>
          <p className="mt-3 text-[12px] text-fg-subtle">
            Le lien porte le montant et la référence : le paiement se rapproche en un coup d&apos;œil, puis « Reçu » solde la commission.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
