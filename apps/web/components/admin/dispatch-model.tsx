"use client";
// Super admin : modèle d'exploitation d'un compte (option 1 Flotte / option 2 Centrale à commission)
// et frais plateforme Rydar dus sur chaque course terminée, dans les deux modèles (20260924006400) :
// centrale → calculés sur le prix (plafonnés au prix) ; flotte → % du prix (0 sans prix) + fixe, facturés à la flotte.
// Changement des frais par course (20260924006600, svc_platform_set_fees) : baisse tout de suite ; HAUSSE annoncée au
// moins 30 jours à l'avance par e-mail (et pas avant l'entrée en vigueur des CGV non acceptées ; impossible sans CGV
// acceptées ni annoncées, ou sans adresse e-mail), ou tout de suite sur accord écrit de l'organisation ; hausse annoncée
// annulable ; historique des changements. Changement de modèle : seulement à la demande de l'organisation ou avec son
// accord écrit, noté (CGV art. 3).
import {
  DISPATCH_MODEL_META, ORG_LEGAL_EFFECTIVE_AT, ORG_LEGAL_VERSION, PLATFORM_FEE_CHANGE_MODE_META, PLATFORM_FEE_CHANGE_STATUS_META,
  PLATFORM_FEE_MIN_REASON_LABEL, addIsoDays, fleetPlatformFee, formatDate, formatPrice, isoDayLabel, legalDateLabel, type AdminPlatformFeeSchedule,
  type DispatchModel, type LegalAcceptanceState, type PlatformFeeChangeRow,
} from "@rydar/shared";
import { AlertTriangle, CalendarClock, Check, Network, ShieldCheck, Truck, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { cancelPlatformFeeChange, updateDispatchModel } from "@/app/admin/actions";
import { feeChangePlan, type FeePlan } from "@/components/admin/fee-change-plan";
import { centsToInput, eurosToCents, formatPlatformFee, parsePercent, percentToInput, platformFee, readFees } from "@/components/admin/fees";
import { feeTermsText, frSpaces } from "@/components/platform-fees/org-platform-format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";

const ICON: Record<DispatchModel, typeof Truck> = { fleet: Truck, centrale: Network };

export function DispatchModelPicker({ value, onChange, disabled }: { value: DispatchModel; onChange: (v: DispatchModel) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Modèle d'exploitation" className="grid gap-2.5 sm:grid-cols-2">
      {(["fleet", "centrale"] as const).map((m) => {
        const meta = DISPATCH_MODEL_META[m];
        const Icon = ICON[m];
        const active = value === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(m)}
            className={cn(
              "relative flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors disabled:opacity-60",
              active ? "border-brand/50 bg-brand/[0.06]" : "border-line hover:border-line-strong hover:bg-white/[0.02]",
            )}
          >
            <span className="flex items-center gap-2.5">
              <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg border", active ? "border-brand/40 bg-brand/10 text-brand" : "border-line-strong bg-ink-700 text-fg-muted")}>
                <Icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[11px] font-medium uppercase tracking-[0.08em] text-fg-subtle">{m === "fleet" ? "Option 1" : "Option 2"}</span>
                <span className="block text-[14px] font-semibold text-fg">{meta.label}</span>
              </span>
              {active && (
                <span className="ml-auto grid size-5 place-items-center rounded-full bg-brand text-brand-fg">
                  <Check className="size-3" strokeWidth={3} />
                </span>
              )}
            </span>
            <span className="text-[12.5px] leading-relaxed text-fg-muted">{meta.description}</span>
          </button>
        );
      })}
    </div>
  );
}

export function FeeFields({
  model,
  percent,
  fixed,
  onPercent,
  onFixed,
  errors,
  disabled,
}: {
  model: DispatchModel;
  percent: string;
  fixed: string;
  onPercent: (v: string) => void;
  onFixed: (v: string) => void;
  errors?: { percent?: string; fixed?: string };
  disabled?: boolean;
}) {
  const p = parsePercent(percent);
  const f = eurosToCents(fixed);
  const valid = Number.isFinite(p) && Number.isFinite(f);
  const example = valid ? (model === "fleet" ? fleetPlatformFee(5900, p, f) : platformFee(5900, p, f)) : null;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Frais plateforme (%)" error={errors?.percent} hint="0 à 50 % du prix">
          <div className="relative">
            <Input inputMode="decimal" value={percent} onChange={(e) => onPercent(e.target.value)} disabled={disabled} className="num pr-8" aria-invalid={!!errors?.percent} />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-fg-subtle">%</span>
          </div>
        </Field>
        <Field label="Frais fixes par course" error={errors?.fixed} hint="0 à 1 000 €">
          <div className="relative">
            <Input inputMode="decimal" value={fixed} onChange={(e) => onFixed(e.target.value)} disabled={disabled} className="num pr-8" aria-invalid={!!errors?.fixed} />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-fg-subtle">€</span>
          </div>
        </Field>
      </div>
      {example != null &&
        (model === "fleet" ? (
          <p className="text-[12px] text-fg-muted">
            Exemple&nbsp;: course à <span className="num">59 €</span> → <span className="num font-medium text-fg">{formatPrice(example)}</span> dus par la flotte à Rydar
            {f > 0 && p > 0 ? (
              <>
                &nbsp;; course sans prix&nbsp;: <span className="num font-medium text-fg">{formatPrice(f)}</span> (frais fixes seuls)
              </>
            ) : null}
            .
          </p>
        ) : (
          <p className="text-[12px] text-fg-subtle">
            Exemple : course à <span className="num text-fg-muted">59 €</span> → <span className="num font-medium text-fg">{formatPrice(example)}</span> de frais plateforme, déduits avant la part chauffeur et la commission.
          </p>
        ))}
    </div>
  );
}

/** Règle des frais Rydar selon le modèle (affichée sous le titre des champs) : montant, taux appliqués, changements. */
export function feeRule(model: DispatchModel) {
  return model === "fleet"
    ? "Dus par la flotte à Rydar pour chaque course terminée (frais fixes même sans prix), en plus de l'abonnement. Taux appliqués\u00a0: ceux en vigueur à la fin de la course."
    : "Calculés sur le prix de chaque course terminée (jamais plus que le prix), avant la part chauffeur et la commission\u00a0; dus par la centrale à Rydar. Taux appliqués\u00a0: ceux en vigueur au calcul de la répartition (création de la course, puis chaque changement de prix, de commission ou de mode de paiement, même après la course).";
}

/**
 * Acceptation des CGV et de l'accord de traitement en vigueur (ORG_LEGAL_VERSION) par l'organisation, et annonce par
 * e-mail de cette version (svc_org_terms_notify) : sans l'une ni l'autre, aucune hausse annoncée (accord écrit seulement).
 */
export type OrgTermsStatus = {
  state: LegalAcceptanceState;
  acceptedAt: string | null;
  notifiedAt?: string | null;
  notifiedEffectiveOn?: string | null;
};

/** Fiche organisation : choix du modèle + frais par course (hausse annoncée ou sur accord écrit), confirmations. */
export function DispatchModelForm({
  orgId,
  model,
  feePercent,
  feeFixedCents,
  joinEnabled,
  timeZone,
  schedule,
  terms,
  today,
}: {
  orgId: string;
  model: DispatchModel;
  feePercent: number;
  feeFixedCents: number;
  joinEnabled: boolean;
  /** Fuseau de l'organisation (date d'effet : minuit dans ce fuseau) */
  timeZone: string;
  /** admin_platform_fee_schedule (null : lecture impossible ; la base calcule alors seule la date d'effet) */
  schedule: AdminPlatformFeeSchedule | null;
  /** null : lecture impossible */
  terms: OrgTermsStatus | null;
  /** Aujourd'hui (« AAAA-MM-JJ », fuseau de l'organisation) : date d'effet au plus un an après (366 jours, comme la base) */
  today: string;
}) {
  const router = useRouter();
  const maxEffectiveOn = addIsoDays(today, 366);
  const formId = useId();
  const [pending, start] = useTransition();
  const [value, setValue] = useState<DispatchModel>(model);
  const [percent, setPercent] = useState(percentToInput(feePercent));
  const [fixed, setFixed] = useState(centsToInput(feeFixedCents));
  const [mode, setMode] = useState<"notice" | "consent">("notice");
  const [effectiveOn, setEffectiveOn] = useState("");
  const [consentNote, setConsentNote] = useState("");
  const [errors, setErrors] = useState<{ percent?: string; fixed?: string; effectiveOn?: string; consentNote?: string; dispatchModel?: string; mode?: string }>({});
  const [confirm, setConfirm] = useState(false);

  const fees = readFees(percent, fixed);
  const ratesTouched = percent !== percentToInput(feePercent) || fixed !== centsToInput(feeFixedCents);
  const plan = feeChangePlan({
    current: { percent: Number(feePercent), fixedCents: feeFixedCents },
    next: fees.valid ? { percent: fees.percent, fixedCents: fees.fixedCents } : null,
    schedule: schedule ? { min_effective_on: schedule.min_effective_on, min_reason: schedule.min_reason, scheduled: schedule.scheduled } : null,
    mode,
    effectiveOn,
    maxEffectiveOn,
  });
  const increase = plan.kind === "increase";
  const scheduled = schedule?.scheduled ?? null;
  const toFleet = model === "centrale" && value === "fleet";
  const toCentrale = model === "fleet" && value === "centrale";
  const dirty = value !== model || ratesTouched;
  const nextText = fees.valid ? ratesText(fees.percent, fees.fixedCents) : "";
  const currentText = ratesText(Number(feePercent), feeFixedCents);
  const fixedAfter = plan.sendRates && fees.valid ? fees.fixedCents : feeFixedCents;
  const modelChanged = value !== model;
  // Note d'accord écrit : hausse appliquée tout de suite, ou changement de modèle (demande / accord de l'organisation)
  const needsNote = (increase && mode === "consent") || modelChanged;
  // Hausse annoncée impossible (svc_platform_set_fees la refuserait) : CGV ni acceptées ni annoncées, ou aucune adresse
  const noticeBlocked = !schedule
    ? null
    : schedule.terms && !schedule.terms.accepted && !schedule.terms.notified_at
      ? `CGV du ${legalDateLabel(ORG_LEGAL_VERSION)} ni acceptées par l'organisation ni annoncées par e-mail : prévenez-la d'abord (Informations légales, « Prévenir par e-mail »), ou choisissez « Accord écrit reçu ».`
      : schedule.email_recipients === 0
        ? "Aucune adresse e-mail valide pour le propriétaire ni pour l'organisation : corrigez l'adresse pour annoncer la hausse, ou choisissez « Accord écrit reçu »."
        : null;

  const reset = () => {
    setValue(model);
    setPercent(percentToInput(feePercent));
    setFixed(centsToInput(feeFixedCents));
    setMode("notice");
    setEffectiveOn("");
    setConsentNote("");
    setErrors({});
  };

  const save = () =>
    start(() => runAction(async () => {
      const res = await updateDispatchModel(orgId, {
        dispatchModel: value,
        // Taux inchangés : modèle seul (une hausse annoncée reste prévue ; renvoyer les taux actuels l'annulerait)
        platformFeePercent: plan.sendRates ? fees.percent : null,
        platformFeeFixedCents: plan.sendRates ? fees.fixedCents : null,
        mode: increase ? mode : "notice",
        effectiveOn: increase && mode === "notice" ? plan.sendOn : null,
        consentNote: needsNote ? consentNote : null,
      });
      if (!res.ok) {
        setConfirm(false);
        const f = res.fieldErrors ?? {};
        setErrors({
          percent: f.platformFeePercent,
          fixed: f.platformFeeFixedCents,
          effectiveOn: f.effectiveOn,
          consentNote: f.consentNote,
          dispatchModel: f.dispatchModel,
          mode: f.mode,
        });
        // Préavis trop court (la date au plus tôt a pu avancer d'un jour depuis l'ouverture de la page) : date proposée
        if (res.minEffectiveOn) setEffectiveOn(res.minEffectiveOn);
        return void toast.error(res.error);
      }
      setConfirm(false);
      toast.success(value !== model ? `Modèle : ${DISPATCH_MODEL_META[value].label}` : res.code === "SCHEDULED" ? "Hausse programmée" : "Frais plateforme enregistrés", {
        description: frSpaces([res.message, value !== model && joinEnabled ? "Le lien d'inscription des chauffeurs reste actif." : ""].filter(Boolean).join(" ")),
        duration: res.code === "SCHEDULED" || res.emailsQueued > 0 ? 10_000 : undefined,
      });
      // La page relue remonte le formulaire (clé = modèle, taux, changement annoncé) : saisie remise aux valeurs en vigueur
      router.refresh();
    }));

  const submit = () => {
    if (ratesTouched && !fees.valid) return void setErrors(fees.errors);
    if (needsNote && consentNote.trim().length < 3) {
      return void setErrors({
        consentNote: modelChanged && !(increase && mode === "consent")
          ? "Précisez la demande ou l'accord écrit de l'organisation pour ce changement de modèle (date et forme : e-mail, courrier…)"
          : "Précisez la date et la forme de l'accord écrit (e-mail, courrier…)",
      });
    }
    if (increase && mode === "notice" && noticeBlocked && !plan.sameAsScheduled) return void setErrors({ mode: noticeBlocked });
    if (increase && mode === "notice" && plan.dateError) return void setErrors({ effectiveOn: plan.dateError });
    setErrors({});
    // Confirmation : changement de modèle (dans les deux sens), ou hausse (annoncée ou appliquée tout de suite)
    if (modelChanged || (increase && !plan.sameAsScheduled)) setConfirm(true);
    else save();
  };

  return (
    <div className="space-y-5">
      <DispatchModelPicker value={value} onChange={setValue} disabled={pending} />
      {errors.dispatchModel && <p className="-mt-3 text-xs text-red">{errors.dispatchModel}</p>}
      <div className="space-y-3.5 rounded-xl border border-line bg-white/[0.015] p-4">
        <div>
          <p className="mb-1 text-[13px] font-medium text-fg">Frais plateforme Rydar</p>
          <p className="text-[12px] text-fg-muted">{feeRule(value)}</p>
          <p className="mt-1 text-[12px] text-fg-muted">
            Changement{"\u00a0"}: une baisse s&apos;applique tout de suite{"\u00a0"}; une hausse est annoncée par e-mail au propriétaire au moins
            30{"\u00a0"}jours à l&apos;avance, ou appliquée tout de suite sur son accord écrit.
          </p>
        </div>
        <TermsLine terms={terms} today={today} />
        {scheduled && <ScheduledFeeChange orgId={orgId} change={scheduled} currentText={currentText} timeZone={timeZone} />}
        <form id={formId} onSubmit={submitWith(() => submit())} className="space-y-3.5">
          <FeeFields
            model={value}
            percent={percent}
            fixed={fixed}
            onPercent={setPercent}
            onFixed={setFixed}
            errors={{ percent: errors.percent, fixed: errors.fixed }}
            disabled={pending}
          />
          {increase && (
            <fieldset className="space-y-3 rounded-lg border border-amber/25 bg-amber/[0.04] p-3.5" disabled={pending}>
              <legend className="px-1 text-[12.5px] font-medium text-amber">Hausse des frais par course</legend>
              <RadioRow
                name={`${formId}-mode`}
                checked={mode === "notice"}
                onSelect={() => setMode("notice")}
                title="Programmer avec préavis"
                description="Annoncée dès l'enregistrement par e-mail au propriétaire (et dans son tableau de bord), appliquée à la date d'effet si l'e-mail est parti au moins 30 jours avant (sinon annulée)."
              />
              {mode === "notice" && (noticeBlocked || errors.mode) && (
                <p className="pl-7 text-[12px] leading-[18px] text-red">{frSpaces(errors.mode ?? noticeBlocked ?? "")}</p>
              )}
              {mode === "notice" && (
                <Field
                  label="Date d'effet"
                  htmlFor={`${formId}-date`}
                  error={errors.effectiveOn}
                  hint={
                    plan.min && plan.reason
                      ? `Au plus tôt le ${isoDayLabel(plan.min)} (${PLATFORM_FEE_MIN_REASON_LABEL[plan.reason]}). S'applique à 00:00, heure de l'organisation (${timeZone}).`
                      : "Vide : la date la plus proche permise, calculée à l'enregistrement."
                  }
                  className="pl-7"
                >
                  <Input
                    id={`${formId}-date`}
                    type="date"
                    value={effectiveOn || plan.displayOn || ""}
                    min={plan.min ?? undefined}
                    max={maxEffectiveOn}
                    onChange={(e) => setEffectiveOn(e.target.value)}
                    className="num max-w-[200px] [color-scheme:dark]"
                    aria-invalid={!!errors.effectiveOn}
                  />
                </Field>
              )}
              <RadioRow
                name={`${formId}-mode`}
                checked={mode === "consent"}
                onSelect={() => setMode("consent")}
                title="Accord écrit de l'organisation reçu : appliquer maintenant"
                description="Appliquée dès l'enregistrement ; le propriétaire reçoit un e-mail de confirmation. L'accord est gardé dans l'historique et le journal d'audit."
              />
              {mode === "consent" && (
                <Field
                  label={modelChanged ? "Accord écrit (hausse et changement de modèle)" : "Accord écrit"}
                  htmlFor={`${formId}-consent`}
                  error={errors.consentNote}
                  hint={frSpaces(`Date et forme de l'accord (ex. « e-mail du propriétaire du 3 octobre 2026 »). ${consentNote.length}/500`)}
                  className="pl-7"
                >
                  <Textarea
                    id={`${formId}-consent`}
                    value={consentNote}
                    onChange={(e) => setConsentNote(e.target.value)}
                    maxLength={500}
                    className="min-h-[64px]"
                    aria-invalid={!!errors.consentNote}
                  />
                </Field>
              )}
            </fieldset>
          )}
          {modelChanged && !(increase && mode === "consent") && (
            <Field
              label="Demande ou accord écrit de l'organisation"
              htmlFor={`${formId}-model-note`}
              error={errors.consentNote}
              hint={frSpaces(`Changement de modèle : seulement à la demande de l'organisation ou avec son accord écrit (CGV, article 3). Date et forme (ex. « e-mail du propriétaire du 3 octobre 2026 »). ${consentNote.length}/500`)}
            >
              <Textarea
                id={`${formId}-model-note`}
                value={consentNote}
                onChange={(e) => setConsentNote(e.target.value)}
                maxLength={500}
                disabled={pending}
                className="min-h-[64px]"
                aria-invalid={!!errors.consentNote}
              />
            </Field>
          )}
          <PlanPreview plan={plan} mode={mode} nextText={nextText} scheduled={scheduled} ratesTouched={ratesTouched} />
        </form>
        {schedule && schedule.history.length > 0 && <FeeChangeHistory history={schedule.history} timeZone={timeZone} />}
      </div>
      {toFleet && (
        <p className="flex items-start gap-2 rounded-lg border border-amber/25 bg-amber/[0.07] px-3 py-2.5 text-[12.5px] text-amber">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            Retour au mode flotte{"\u00a0"}: plus de commission ni de règlement sur les nouvelles courses. Le lien d&apos;inscription des chauffeurs est
            conservé{joinEnabled ? " (actif)" : ""}, sans mention de commission{"\u00a0"}; les chauffeurs déjà inscrits restent rattachés.
            {fixedAfter > 0 && (
              <>
                {" "}
                Frais fixes de {formatPrice(fixedAfter)}{"\u00a0"}: en flotte, ils sont dus même pour une course sans prix (et le pourcentage n&apos;est plus
                plafonné au prix) — à faire seulement à la demande de l&apos;organisation.
              </>
            )}
          </span>
        </p>
      )}
      {toCentrale && (
        <p className="rounded-lg border border-line bg-white/[0.015] px-3 py-2.5 text-[12.5px] text-fg-muted">
          Passage en centrale{"\u00a0"}: les chauffeurs entrés par la validation automatique du lien d&apos;inscription (jamais vérifiés)
          seront au niveau «{"\u00a0"}Nouveau{"\u00a0"}» (courses plafonnées) jusqu&apos;à leur confirmation dans «{"\u00a0"}Réseau{"\u00a0"}»{"\u00a0"}; ceux
          créés ou validés par la flotte sont «{"\u00a0"}Confirmés{"\u00a0"}».
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        {dirty && (
          <Button type="button" variant="ghost" disabled={pending} onClick={reset}>
            Annuler
          </Button>
        )}
        <Button type="submit" form={formId} variant="primary" disabled={!dirty} loading={pending && !confirm}>
          {increase && !plan.sameAsScheduled ? (mode === "consent" ? "Appliquer la hausse" : "Programmer la hausse") : "Enregistrer"}
        </Button>
      </div>

      <Dialog open={confirm} onOpenChange={(o) => !pending && setConfirm(o)}>
        <DialogContent
          title={frSpaces(
            toFleet ? "Repasser en mode flotte ?" : toCentrale ? "Passer en centrale à commission ?" : mode === "consent" ? "Appliquer la hausse maintenant ?" : "Programmer la hausse ?",
          )}
          description={frSpaces(
            toFleet
              ? "Le compte redevient une flotte classique : plus de répartition part chauffeur / commission sur les nouvelles courses."
              : toCentrale
                ? "Le logiciel calcule en plus, pour chaque course, la part du chauffeur et la commission de la centrale, et suit leur règlement."
                : `Frais par course : ${currentText} → ${nextText}.`,
          )}
        >
          <ul className="space-y-2 text-[13px] text-fg-muted">
            {toFleet && (
              <>
                <li className="flex gap-2">
                  <span className="text-amber">•</span> Le lien d&apos;inscription /rejoindre est conservé (même adresse, mêmes réglages){"\u00a0"}: la page
                  s&apos;adapte à la flotte et les candidatures en attente restent à valider dans «{"\u00a0"}Inscriptions{"\u00a0"}».
                </li>
                <li className="flex gap-2"><span className="text-amber">•</span> Les chauffeurs et règlements existants sont conservés.</li>
                <li className="flex gap-2">
                  <span className="text-amber">•</span> Frais Rydar{"\u00a0"}: ceux réglés ci-dessus s&apos;appliquent aux courses terminées en flotte{"\u00a0"}; les frais déjà dus restent dus.
                </li>
                <li className="flex gap-2">
                  <span className="text-amber">•</span> Repasser en centrale{"\u00a0"}: seulement à la demande de l&apos;organisation ou avec son accord écrit (CGV, article 3).
                </li>
              </>
            )}
            {modelChanged && (
              <li className="flex gap-2">
                <span className="text-amber">•</span>
                <span>
                  Changement de modèle à la demande de l&apos;organisation ou avec son accord écrit (CGV, article 3), gardé au journal d&apos;audit{"\u00a0"}:
                  «{"\u00a0"}{consentNote.trim()}{"\u00a0"}».
                </span>
              </li>
            )}
            {increase && !plan.sameAsScheduled && (mode === "consent" ? (
              <>
                {toFleet && <li className="flex gap-2"><span className="text-amber">•</span> Hausse des frais par course{"\u00a0"}: {currentText} → {nextText}.</li>}
                <li className="flex gap-2">
                  <span className="text-amber">•</span> Appliquée dès maintenant, sur l&apos;accord écrit indiqué{"\u00a0"}: «{"\u00a0"}{consentNote.trim()}{"\u00a0"}».
                </li>
                <li className="flex gap-2">
                  <span className="text-amber">•</span> Le propriétaire reçoit un e-mail de confirmation{"\u00a0"}; s&apos;il n&apos;a pas donné cet accord, il est invité à le signaler.
                </li>
              </>
            ) : (
              <>
                {toFleet && <li className="flex gap-2"><span className="text-amber">•</span> Hausse des frais par course{"\u00a0"}: {currentText} → {nextText}.</li>}
                <li className="flex gap-2">
                  <span className="text-amber">•</span> Annonce envoyée dès maintenant par e-mail au propriétaire (et affichée dans son tableau de bord)
                  {plan.replacesScheduled && scheduled ? `, en remplacement de celle du ${isoDayLabel(scheduled.effective_on)}` : ""}.
                </li>
                <li className="flex gap-2">
                  <span className="text-amber">•</span> Nouveaux frais à partir du {plan.displayOn ? isoDayLabel(plan.displayOn) : "jour le plus proche permis"} à
                  00:00 ({timeZone}){"\u00a0"}; d&apos;ici là, les frais actuels restent appliqués.
                </li>
                <li className="flex gap-2">
                  <span className="text-amber">•</span> L&apos;organisation peut résilier sans frais avant cette date{"\u00a0"}; vous pouvez annuler la hausse tant qu&apos;elle n&apos;est pas appliquée.
                </li>
              </>
            ))}
          </ul>
          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setConfirm(false)}>
              Annuler
            </Button>
            <Button type="button" variant={toFleet ? "danger" : "primary"} loading={pending} onClick={save}>
              {toFleet
                ? "Passer en mode flotte"
                : toCentrale
                  ? "Passer en centrale"
                  : mode === "consent" && increase
                    ? "Appliquer maintenant"
                    : "Programmer"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------- éléments
function RadioRow({ name, checked, onSelect, title, description }: { name: string; checked: boolean; onSelect: () => void; title: string; description: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="mt-1 size-4 shrink-0 accent-brand" />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-fg">{frSpaces(title)}</span>
        <span className="block text-[12px] leading-[18px] text-fg-muted">{frSpaces(description)}</span>
      </span>
    </label>
  );
}

/** Statut d'acceptation des CGV en vigueur : sans elle, une hausse ne s'applique pas avant leur entrée en vigueur. */
function TermsLine({ terms, today }: { terms: OrgTermsStatus | null; today: string }) {
  const version = legalDateLabel(ORG_LEGAL_VERSION);
  const limit = legalDateLabel(ORG_LEGAL_EFFECTIVE_AT);
  if (!terms) return <p className="text-[12px] text-fg-subtle">Acceptation des CGV du {version} indisponible.</p>;
  if (terms.state === "accepted") {
    return (
      <p className="flex items-start gap-1.5 text-[12px] text-fg-muted">
        <ShieldCheck className="mt-px size-3.5 shrink-0 text-green" />
        <span>
          CGV et accord de traitement du {version} acceptés{terms.acceptedAt ? ` le ${formatDate(terms.acceptedAt)}` : ""}.
        </span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 rounded-lg border border-amber/25 bg-amber/[0.06] px-3 py-2 text-[12px] text-fg-muted">
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber" />
      <span>
        <span className="font-medium text-amber">CGV du {version} pas encore acceptées</span> (
        {terms.state === "updated" ? "version antérieure acceptée" : "aucune version acceptée"}
        {terms.notifiedAt ? `, annoncées par e-mail le ${formatDate(terms.notifiedAt)}` : ", pas encore annoncées par e-mail"})
        {!terms.notifiedAt ? (
          <>
            {"\u00a0"}: aucune hausse annoncée possible tant qu&apos;elles ne sont ni acceptées ni annoncées (Informations légales, «{"\u00a0"}Prévenir
            par e-mail{"\u00a0"}»), seulement une hausse sur accord écrit.
          </>
        ) : today < (terms.notifiedEffectiveOn ?? ORG_LEGAL_EFFECTIVE_AT) ? (
          <>
            {"\u00a0"}: sans accord écrit, une hausse s&apos;applique au plus tôt le {legalDateLabel(terms.notifiedEffectiveOn ?? ORG_LEGAL_EFFECTIVE_AT)} (leur
            entrée en vigueur annoncée), et au moins 30{"\u00a0"}jours après son annonce.
          </>
        ) : (
          <>
            {"\u00a0"}; leur date limite d&apos;entrée en vigueur ({limit}) est passée{"\u00a0"}: une hausse reste annoncée au moins 30{"\u00a0"}jours à
            l&apos;avance, sauf accord écrit.
          </>
        )}
      </span>
    </p>
  );
}

/** Ce que fera l'enregistrement (frais saisis). */
function PlanPreview({
  plan,
  mode,
  nextText,
  scheduled,
  ratesTouched,
}: {
  plan: FeePlan;
  mode: "notice" | "consent";
  nextText: string;
  scheduled: PlatformFeeChangeRow | null;
  ratesTouched: boolean;
}) {
  let text: string | null = null;
  if (plan.kind === "increase") {
    if (plan.sameAsScheduled && scheduled) text = `Hausse déjà annoncée pour le ${isoDayLabel(scheduled.effective_on)} : rien ne change (aucun nouvel e-mail).`;
    else if (mode === "consent") text = `${nextText} dès l'enregistrement ; confirmation par e-mail au propriétaire.`;
    else {
      text = `${nextText} à partir du ${plan.displayOn ? isoDayLabel(plan.displayOn) : "jour le plus proche permis"} ; annonce par e-mail au propriétaire dès l'enregistrement.`;
      if (plan.replacesScheduled && scheduled) text += ` Elle remplace l'annonce du ${isoDayLabel(scheduled.effective_on)}.`;
    }
  } else if (plan.kind === "decrease") {
    text = `Baisse : ${nextText} dès l'enregistrement.`;
    if (scheduled) text += ` La hausse programmée le ${isoDayLabel(scheduled.effective_on)} est annulée (e-mail d'annulation au propriétaire).`;
  } else if (ratesTouched && scheduled) {
    text = `Frais inchangés : la hausse programmée le ${isoDayLabel(scheduled.effective_on)} reste prévue (« Annuler ce changement » pour la retirer).`;
  }
  if (!text) return null;
  return <p className={cn("text-[12px] leading-[18px]", plan.kind === "increase" ? "text-fg" : "text-fg-muted")}>{frSpaces(text)}</p>;
}

/** « 2 € par course terminée », « 10 % du prix + 0,50 € par course terminée », « aucuns frais par course ». */
const ratesText = (percent: number, fixedCents: number) =>
  feeTermsText({ fee_percent: percent, fee_fixed_cents: fixedCents, currency: "EUR" }, "aucuns frais par course");

/** Hausse annoncée, pas encore appliquée : taux, date d'effet, annonce envoyée, annulation. */
function ScheduledFeeChange({ orgId, change, currentText, timeZone }: { orgId: string; change: PlatformFeeChangeRow; currentText: string; timeZone: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const target = ratesText(Number(change.percent), change.fixed_cents);
  const mail = emailsSummary(change);
  const late = noticeLate(change);

  return (
    <div className="rounded-lg border border-amber/25 bg-amber/[0.06] px-3.5 py-3 text-[12.5px]" role="status">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-medium text-fg">
            <CalendarClock className="size-3.5 shrink-0 text-amber" /> Hausse programmée le {isoDayLabel(change.effective_on)}
          </p>
          <p className="mt-0.5 text-fg-muted">
            {frSpaces(`À partir du ${isoDayLabel(change.effective_on)} à 00:00 (${timeZone}) : ${target}. Actuellement : ${currentText}.`)}
          </p>
          <p className="mt-0.5 text-fg-muted">
            Annoncée le {formatDate(change.created_at, timeZone)}
            {change.created_by_name ? ` par ${change.created_by_name}` : ""} · <span className={mail.tone}>{mail.text}</span>
          </p>
          {late && (
            <p className="mt-0.5 text-red">
              {frSpaces("E-mail d'annonce pas parti au moins 30 jours avant la date d'effet : la hausse ne sera pas appliquée (annulée à cette date). Annulez-la et reprogrammez-la, ou appliquez-la sur accord écrit.")}
            </p>
          )}
        </div>
        <Button type="button" variant="outline" size="xs" onClick={() => setOpen(true)}>
          <X /> Annuler ce changement
        </Button>
      </div>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent
          title="Annuler la hausse programmée ?"
          description={frSpaces(`Les frais restent : ${currentText}. Le propriétaire est prévenu par e-mail de l'annulation.`)}
        >
          <form
            onSubmit={submitWith(() =>
              start(() => runAction(async () => {
                setError(null);
                const res = await cancelPlatformFeeChange(orgId, change.id, reason);
                if (!res.ok) {
                  setError(res.error);
                  return void toast.error(res.error);
                }
                toast.success("Hausse annulée", { description: res.message });
                setOpen(false);
                router.refresh();
              })),
            )}
          >
            <Field label="Motif" optional htmlFor={`cancel-${change.id}`} error={error ?? undefined} hint={`Gardé dans l'historique. ${reason.length}/300`}>
              <Textarea id={`cancel-${change.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-[64px]" />
            </Field>
            <div className="mt-6 flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
                Garder la hausse
              </Button>
              <Button type="submit" variant="danger" loading={pending}>
                Annuler la hausse
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Hausse programmée dont l'e-mail d'annonce n'est pas (ou ne sera plus) parti au moins 30 jours avant la date d'effet :
 * le ménage l'annulera (private.apply_platform_fee_changes). Envoi encore possible à temps : pas d'alerte.
 */
function noticeLate(c: Pick<PlatformFeeChangeRow, "status" | "mode" | "effective_at" | "notice_sent_at">, now = Date.now()): boolean {
  if (c.status !== "scheduled" || c.mode !== "notice") return false;
  const limit = Date.parse(c.effective_at) - 30 * 86_400_000;
  return c.notice_sent_at ? Date.parse(c.notice_sent_at) > limit : now > limit;
}

/** E-mails d'un changement (annonce, confirmation, annulation) : envoyés, en attente, en échec, ou aucune adresse. */
function emailsSummary(c: Pick<PlatformFeeChangeRow, "emails" | "emails_queued">): { text: string; tone: string } {
  const list = c.emails ?? [];
  if (!list.length) {
    return c.emails_queued > 0
      ? { text: `${c.emails_queued} e-mail${c.emails_queued > 1 ? "s" : ""} mis en file`, tone: "text-fg-muted" }
      : { text: "aucune adresse e-mail valide\u00a0: prévenez l'organisation vous-même", tone: "text-amber" };
  }
  const failed = list.filter((e) => e.status === "failed").length;
  const waiting = list.filter((e) => e.status === "pending" || e.status === "sending").length;
  const sent = list.length - failed - waiting;
  if (failed) return { text: `${failed} e-mail${failed > 1 ? "s" : ""} en échec\u00a0: prévenez l'organisation vous-même`, tone: "text-red" };
  if (waiting) return { text: `${waiting} e-mail${waiting > 1 ? "s" : ""} en attente d'envoi`, tone: "text-fg-muted" };
  return { text: `e-mail envoyé${sent > 1 ? ` (${sent})` : ""}`, tone: "text-fg-muted" };
}

/** 20 derniers changements des frais par course (création, baisses, hausses annoncées ou sur accord écrit). */
function FeeChangeHistory({ history, timeZone }: { history: PlatformFeeChangeRow[]; timeZone: string }) {
  return (
    <details className="group rounded-lg border border-line">
      <summary className="cursor-pointer select-none px-3.5 py-2.5 text-[12.5px] font-medium text-fg-muted hover:text-fg">
        Historique des frais par course ({history.length})
      </summary>
      <ul className="divide-y divide-line border-t border-line">
        {history.map((h) => {
          const status = PLATFORM_FEE_CHANGE_STATUS_META[h.status];
          const mail = h.mode === "notice" || h.mode === "consent" || h.emails.length ? emailsSummary(h) : null;
          return (
            <li key={h.id} className="space-y-0.5 px-3.5 py-2.5 text-[12px]">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="num text-fg">
                  {formatPlatformFee(h.from_percent, h.from_fixed_cents)} → {formatPlatformFee(h.percent, h.fixed_cents)}
                </span>
                <Badge tone={status.tone} dot={false} className="h-[18px]">
                  {status.label}
                </Badge>
                <span className="text-fg-subtle">{PLATFORM_FEE_CHANGE_MODE_META[h.mode].label}</span>
              </p>
              <p className="text-fg-muted">
                {h.mode === "notice" ? `Effet le ${isoDayLabel(h.effective_on)}` : `Appliqué le ${formatDate(h.applied_at ?? h.created_at, timeZone)}`} · réglé le{" "}
                {formatDate(h.created_at, timeZone)}
                {h.created_by_name ? ` par ${h.created_by_name}` : ""}
                {mail ? (
                  <>
                    {" "}
                    · <span className={mail.tone}>{mail.text}</span>
                  </>
                ) : null}
              </p>
              {h.consent_note && <p className="text-fg-muted">Accord écrit{"\u00a0"}: «{"\u00a0"}{h.consent_note}{"\u00a0"}»</p>}
              {h.close_reason && (
                <p className="text-fg-subtle">
                  {h.close_reason}
                  {h.closed_by_name ? ` (${h.closed_by_name})` : ""}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
