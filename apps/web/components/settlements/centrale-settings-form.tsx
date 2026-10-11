"use client";
// Réglages « Commission & encaissement » (mode centrale, owner / admin), docs/REFONTE-PANELS.md § 5.6 (lot R10) : dans
// l'ordre logique — votre commission (% + fixe), l'encaissement (délai, moyens et lien de paiement, message du bouton
// « Réclamer » replié), les relances (carte passée par `reminders`, enregistrée à chaque choix), puis les blocages et
// la confiance (blocage des retardataires, dette maximale, prix maximum d'un nouveau chauffeur, confirmation
// automatique). Les frais Rydar sont fixés par Rydar (super admin) : lecture seule. Enregistrement inchangé
// (updateCentraleSettings, même charge) ; une saisie non enregistrée n'est plus perdue en changeant d'onglet.
import {
  centralePlatformFee, centraleSettingsSchema, formatIban, formatNumber, formatPrice, isValidIban, percentOfCents, settlementRequestMessage, splitSummary,
  type SettlementMethod,
} from "@rydar/shared";
import { HandCoins, Lock, Percent, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { updateCentraleSettings } from "@/app/dashboard/settings/actions";
import { UnsavedGuard } from "@/components/settings/unsaved-guard";
import { SAMPLE_AMOUNT, SAMPLE_REF, SettlementMethodsFields, settlementLinkPreview } from "@/components/settlements/settlement-methods-fields";
import { SplitBar } from "@/components/settlements/settlement-ui";
import { centraleIssues } from "@/components/settlements/settings-schema";
import { centsToInput, eurosToCents } from "@/components/settlements/split-preview";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { Field, Input, asFieldControl } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch-row";
import { runAction } from "@/lib/run-action";
import { cn } from "@/lib/utils";

const NB = " ";

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
  settlement_payee_name: string | null;
  settlement_iban: string | null;
  settlement_bic: string | null;
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
  payeeName: string;
  iban: string;
  bic: string;
};

const SAMPLE_PRICE = 5900;

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
  payeeName: s.settlement_payee_name ?? "",
  iban: formatIban(s.settlement_iban),
  bic: s.settlement_bic ?? "",
});

const num = (v: string) => (v.trim() === "" ? "" : Number(v.trim().replace(",", ".")));
const cents = (v: string) => {
  const c = eurosToCents(v);
  return c == null ? "" : c;
};

/** Unité lue par les lecteurs d'écran (le symbole affiché à droite du champ ne l'est pas). */
const UNIT_WORDS: Record<string, string> = { "%": "en pourcentage", "€": "en euros", h: "en heures", courses: "en nombre de courses" };

/**
 * Champ avec unité : nom accessible = libellé visible de Field (WCAG 2.5.3), unité annoncée en description
 * (aria-describedby, après l'aide ou l'erreur de Field).
 */
const UnitInput = asFieldControl(function UnitInput({ unit, className, ...props }: React.ComponentProps<typeof Input> & { unit: string }) {
  const unitId = React.useId();
  return (
    <div className="relative">
      <Input
        inputMode="decimal"
        {...props}
        aria-describedby={[props["aria-describedby"], unitId].filter(Boolean).join(" ")}
        className={cn("mono pr-10", className)}
      />
      <span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12.5px] text-fg-muted">
        {unit}
      </span>
      <span id={unitId} className="sr-only">
        {UNIT_WORDS[unit] ?? unit}
      </span>
    </div>
  );
});

export function CentraleSettingsForm({
  settings,
  platformFee,
  orgName,
  legalName,
  currency = "EUR",
  readOnly,
  reminders,
}: {
  settings: CentraleSettingsRow;
  platformFee: { percent: number; fixed_cents: number };
  orgName: string;
  legalName?: string | null;
  currency?: string;
  readOnly: boolean;
  /** Carte « Relances des chauffeurs » (propriétaire et administrateurs), placée après l'encaissement */
  reminders?: React.ReactNode;
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
    payeeName: f.payeeName.trim(),
    iban: f.iban,
    bic: f.bic,
  };

  // Exemple de répartition (même calcul que la base : frais Rydar puis commission, plafonnés au prix)
  const example = useMemo(() => {
    const pct = typeof input.commissionPercent === "number" && Number.isFinite(input.commissionPercent) ? input.commissionPercent : 0;
    const fixed = typeof input.commissionFixedCents === "number" && Number.isFinite(input.commissionFixedCents) ? input.commissionFixedCents : 0;
    const platform = centralePlatformFee(SAMPLE_PRICE, platformFee.percent, platformFee.fixed_cents);
    const commission = Math.min(SAMPLE_PRICE - platform, percentOfCents(SAMPLE_PRICE, pct) + fixed);
    return { price: SAMPLE_PRICE, platform, commission, driver: SAMPLE_PRICE - platform - commission, pct, fixed };
  }, [input.commissionPercent, input.commissionFixedCents, platformFee.percent, platformFee.fixed_cents]);
  const exampleSentence = splitSummary({
    price_cents: example.price,
    driver_payout_cents: example.driver,
    commission_cents: example.commission,
    platform_fee_cents: example.platform,
    currency,
  });

  const linkPreview = settlementLinkPreview(f.link);
  const message = settlementRequestMessage({
    firstName: "Karim",
    organizationName: orgName,
    amountCents: SAMPLE_AMOUNT,
    currency,
    rideNumbers: [1783],
    link: f.methods.includes("link") ? linkPreview : null,
    reference: SAMPLE_REF,
    instructions: f.instructions.trim() || null,
    bank: f.methods.includes("transfer") && isValidIban(f.iban) ? { payeeName: f.payeeName.trim() || legalName || orgName, iban: f.iban, bic: f.bic.trim() || null } : null,
  });
  const feeLabel = [
    platformFee.percent ? `${formatNumber(platformFee.percent, platformFee.percent % 1 ? 1 : 0)}${NB}%` : null,
    platformFee.fixed_cents ? formatPrice(platformFee.fixed_cents, currency) : null,
  ]
    .filter(Boolean)
    .join(" + ");

  const save = () => {
    const parsed = centraleSettingsSchema.safeParse(input);
    if (!parsed.success) {
      const issues = centraleIssues(parsed.error);
      setErrors(issues);
      toast.error(Object.values(issues)[0] ?? "Vérifiez les réglages.");
      return;
    }
    start(() =>
      runAction(async () => {
        const res = await updateCentraleSettings(input);
        if (!res.ok) {
          setErrors(res.fieldErrors ?? {});
          return void toast.error(res.error);
        }
        toast.success("Réglages d'encaissement enregistrés");
        setBaseline(f);
        router.refresh();
      }),
    );
  };

  return (
    <div className="max-w-4xl space-y-6">
      {/* ---------------------------------------------------------------- commission */}
      <Card data-tour="centrale-commission">
        <CardHeader
          icon={<Percent />}
          title="Votre commission"
          description={`Calculée sur le prix de chaque course${NB}; modifiable course par course à la création.`}
        />
        <CardBody className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Pourcentage du prix" hint="Vide = aucun pourcentage." error={errors.commissionPercent}>
              <UnitInput
                unit="%"
                value={f.pct}
                placeholder="0"
                disabled={readOnly}
                onChange={(e) => set("pct", e.target.value.replace(/[^\d.,]/g, "").slice(0, 6))}
                aria-invalid={!!errors.commissionPercent}
              />
            </Field>
            <Field label="Montant fixe par course" hint="S'ajoute au pourcentage." error={errors.commissionFixedCents}>
              <UnitInput
                unit="€"
                value={f.fixed}
                placeholder="0"
                disabled={readOnly}
                onChange={(e) => set("fixed", e.target.value.replace(/[^\d.,]/g, "").slice(0, 9))}
                aria-invalid={!!errors.commissionFixedCents}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-white/[0.02] px-4 py-3">
            <span className="flex min-w-0 items-center gap-2.5">
              <Lock aria-hidden className="size-4 shrink-0 text-fg-subtle" />
              <span>
                <span className="block text-[13.5px] font-medium">Frais Rydar</span>
                <span className="block text-[12.5px] text-fg-muted">Fixés par Rydar, déduits avant votre commission.</span>
              </span>
            </span>
            <span className="mono shrink-0 text-[14px] font-semibold text-fg">{feeLabel || "Aucun"}</span>
          </div>
          <div className="rounded-xl bg-white/[0.03] px-4 py-3.5">
            <p className="mb-2 text-[12.5px] font-medium text-fg">
              Exemple{NB}: course à {formatPrice(SAMPLE_PRICE, currency)}
            </p>
            <SplitBar split={example} />
            {exampleSentence && <p className="mono mt-2 text-[13px] text-fg">{exampleSentence}</p>}
            <p className="mt-1.5 text-[12.5px] text-fg-muted">
              Le chauffeur voit «{NB}Vous gagnez <span className="mono text-fg">{formatPrice(example.driver, currency)}</span>
              {NB}» dans l&apos;offre. Payée en espèces, il vous doit <span className="mono text-fg">{formatPrice(example.commission + example.platform, currency)}</span>
              {NB}; payée en ligne, vous lui versez sa part.
            </p>
          </div>
        </CardBody>
      </Card>

      {/* ---------------------------------------------------------------- encaissement */}
      <Card>
        <CardHeader icon={<HandCoins />} title="Encaissement" description="Comment et quand les chauffeurs vous règlent votre commission." />
        <CardBody className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-[220px_minmax(0,1fr)] sm:items-start">
            <Field label="Délai de règlement" error={errors.graceHours}>
              <UnitInput
                unit="h"
                value={f.grace}
                disabled={readOnly}
                onChange={(e) => set("grace", e.target.value.replace(/\D/g, "").slice(0, 3))}
                aria-invalid={!!errors.graceHours}
              />
            </Field>
            <p className="rounded-xl bg-white/[0.03] px-3.5 py-2.5 text-[12.5px] leading-[19px] text-fg-muted sm:mt-[26px]">
              {Number(f.grace) === 0
                ? `0${NB}h${NB}: la commission est à régler dès la fin de la course.`
                : `La commission devient «${NB}en retard${NB}» ${f.grace || "…"}${NB}h après la fin de la course${f.blockUnpaid ? `${NB}; le chauffeur ne reçoit alors plus d'offres.` : "."}`}
            </p>
          </div>

          <SettlementMethodsFields
            value={{ methods: f.methods, link: f.link, instructions: f.instructions, payeeName: f.payeeName, iban: f.iban, bic: f.bic }}
            onChange={(k, v) => set(k, v as FormState[typeof k])}
            errors={errors}
            readOnly={readOnly}
            orgName={orgName}
            legalName={legalName}
            currency={currency}
          />

          <Disclosure
            title={`Message du bouton «${NB}Réclamer${NB}» — envoyé depuis votre WhatsApp, sans configuration`}
            className="rounded-xl border border-line px-4"
            contentClassName="space-y-3 pb-4"
          >
            <p className="text-[12.5px] text-fg-muted">Exemple du message prérempli quand vous réclamez une commission depuis Encaissements.</p>
            <div className="rounded-2xl rounded-tl-md bg-green/[0.1] px-3.5 py-3 text-[13px] leading-[20px] text-fg ring-1 ring-inset ring-green/20">
              <p className="whitespace-pre-wrap break-words">{message}</p>
            </div>
            <p className="text-[12.5px] text-fg-muted">
              Le lien porte le montant et la référence{NB}: le paiement se rapproche en un coup d&apos;œil, puis «{NB}Reçu{NB}» solde la commission.
            </p>
          </Disclosure>
        </CardBody>
      </Card>

      {/* ---------------------------------------------------------------- relances (enregistrées à chaque choix) */}
      {reminders}

      {/* ---------------------------------------------------------------- blocages et confiance */}
      <Card>
        <CardHeader icon={<ShieldCheck />} title="Blocages et confiance" description="Qui reçoit les courses : règles appliquées automatiquement par le dispatch." />
        <CardBody className="space-y-5">
          <SwitchRow
            title="Bloquer automatiquement les retardataires"
            hintOn={`Commission en retard ou contestée${NB}: plus aucune offre ni acceptation jusqu'au règlement.`}
            hintOff="Un chauffeur en retard de paiement continue de recevoir des courses."
            checked={f.blockUnpaid}
            onCheckedChange={(v) => set("blockUnpaid", v)}
            disabled={readOnly}
          />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Dette maximale d'un chauffeur" hint="Au-delà, il ne reçoit plus de courses. Vide = aucune limite." error={errors.creditLimitCents}>
              <UnitInput
                unit="€"
                value={f.credit}
                placeholder="Aucune"
                disabled={readOnly}
                onChange={(e) => set("credit", e.target.value.replace(/[^\d.,]/g, "").slice(0, 9))}
                aria-invalid={!!errors.creditLimitCents}
              />
            </Field>
            <Field
              label="Prix maximum pour un nouveau chauffeur"
              hint="Courses plus chères : chauffeurs confirmés seulement. Vide = aucune limite."
              error={errors.newDriverMaxPriceCents}
            >
              <UnitInput
                unit="€"
                value={f.newMax}
                placeholder="Aucun"
                disabled={readOnly}
                onChange={(e) => set("newMax", e.target.value.replace(/[^\d.,]/g, "").slice(0, 9))}
                aria-invalid={!!errors.newDriverMaxPriceCents}
              />
            </Field>
            <Field label="Chauffeur confirmé après" hint="Courses réglées, sans impayé. Vide = confirmation manuelle." error={errors.trustAfterRides}>
              <UnitInput
                unit="courses"
                value={f.trust}
                placeholder="Manuel"
                disabled={readOnly}
                onChange={(e) => set("trust", e.target.value.replace(/\D/g, "").slice(0, 4))}
                className="pr-20"
                aria-invalid={!!errors.trustAfterRides}
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      {!readOnly && (
        <>
          <div data-tour-avoid="" className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line-strong bg-ink-700/[0.97] px-4 py-3 shadow-float backdrop-blur-xl">
            <p className="flex items-center gap-2 text-[13px] text-fg-muted" aria-live="polite">
              <span aria-hidden className={cn("size-1.5 rounded-full", dirty ? "bg-amber" : "bg-green")} />
              {dirty ? "Modifications non enregistrées" : "Tout est enregistré"}
            </p>
            <div className="flex flex-wrap gap-2">
              {dirty && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setF(baseline);
                    setErrors({});
                  }}
                  disabled={pending}
                >
                  Annuler les modifications
                </Button>
              )}
              <Button variant="primary" size="sm" loading={pending} disabled={!dirty} onClick={save}>
                Enregistrer
              </Button>
            </div>
          </div>
          <UnsavedGuard dirty={dirty} />
        </>
      )}
    </div>
  );
}
