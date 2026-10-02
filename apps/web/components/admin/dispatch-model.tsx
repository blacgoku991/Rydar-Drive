"use client";
// Super admin : modèle d'exploitation d'un compte (option 1 Flotte / option 2 Centrale à commission)
// et frais plateforme Rydar dus sur chaque course terminée, dans les deux modèles (20260924006400) :
// centrale → prélevés sur le prix (plafonnés au prix) ; flotte → % du prix (0 sans prix) + fixe, facturés à la flotte.
import { DISPATCH_MODEL_META, fleetPlatformFee, formatPrice, type DispatchModel } from "@rydar/shared";
import { AlertTriangle, Check, Network, Truck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updateDispatchModel } from "@/app/admin/actions";
import { CGV_COVERS_FLEET_FEES, centsToInput, eurosToCents, parsePercent, percentToInput, platformFee, readFees } from "@/components/admin/fees";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { cn } from "@/lib/utils";

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
      {model === "fleet" && !CGV_COVERS_FLEET_FEES && (
        <p role="note" className="flex items-start gap-2 rounded-lg border border-amber/25 bg-amber/[0.07] px-3 py-2.5 text-[12.5px] text-amber">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            CGV à mettre à jour avant de facturer une flotte{"\u00a0"}: l&apos;article 5 ne prévoit encore les frais par course que pour les
            centrales (prélevés sur le prix, plafonnés). Publiez d&apos;abord la nouvelle version (flotte{"\u00a0"}: % du prix + frais fixes
            facturés à la flotte, fixes dus même sans prix), acceptée par la flotte, puis réglez ses frais ici.
          </span>
        </p>
      )}
    </div>
  );
}

/** Règle des frais Rydar selon le modèle (affichée sous le titre des champs). */
export function feeRule(model: DispatchModel) {
  return model === "fleet"
    ? "Dus par la flotte à Rydar pour chaque course terminée (frais fixes même sans prix), en plus de l'abonnement. Un changement s'applique aux courses terminées après lui."
    : "Prélevés sur le prix de chaque course terminée (jamais plus que le prix), avant la part chauffeur et la commission. Dus par la centrale à Rydar.";
}

/** Fiche organisation : choix du modèle + frais, avec confirmation d'un retour au mode flotte. */
export function DispatchModelForm({
  orgId,
  model,
  feePercent,
  feeFixedCents,
  joinEnabled,
}: {
  orgId: string;
  model: DispatchModel;
  feePercent: number;
  feeFixedCents: number;
  joinEnabled: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState<DispatchModel>(model);
  const [percent, setPercent] = useState(percentToInput(feePercent));
  const [fixed, setFixed] = useState(centsToInput(feeFixedCents));
  const [errors, setErrors] = useState<{ percent?: string; fixed?: string }>({});
  const [confirm, setConfirm] = useState(false);

  const fees = readFees(percent, fixed);
  const dirty = value !== model || (fees.valid && (fees.percent !== Number(feePercent) || fees.fixedCents !== feeFixedCents));
  const toFleet = model === "centrale" && value === "fleet";
  const toCentrale = model === "fleet" && value === "centrale";

  const save = () =>
    start(() => runAction(async () => {
      if (!fees.valid) return void setErrors(fees.errors);
      setErrors({});
      const res = await updateDispatchModel(orgId, { dispatchModel: value, platformFeePercent: fees.percent, platformFeeFixedCents: fees.fixedCents });
      if (!res.ok) return void toast.error(res.error);
      setConfirm(false);
      toast.success(value !== model ? `Modèle : ${DISPATCH_MODEL_META[value].label}` : "Frais plateforme enregistrés", {
        description: value !== model && joinEnabled ? "Le lien d'inscription des chauffeurs reste actif." : undefined,
      });
      router.refresh();
    }));

  return (
    <div className="space-y-5">
      <DispatchModelPicker value={value} onChange={setValue} disabled={pending} />
      <div className="rounded-xl border border-line bg-white/[0.015] p-4">
        <p className="mb-1 text-[13px] font-medium text-fg">Frais plateforme Rydar</p>
        <p className="mb-3 text-[12px] text-fg-muted">{feeRule(value)}</p>
        <FeeFields model={value} percent={percent} fixed={fixed} onPercent={setPercent} onFixed={setFixed} errors={errors} disabled={pending} />
      </div>
      {toFleet && (
        <p className="flex items-start gap-2 rounded-lg border border-amber/25 bg-amber/[0.07] px-3 py-2.5 text-[12.5px] text-amber">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          Retour au mode flotte{" "}: plus de commission ni de règlement sur les nouvelles courses. Le lien d&apos;inscription des chauffeurs est
          conservé{joinEnabled ? " (actif)" : ""}, sans mention de commission{" "}; les chauffeurs déjà inscrits restent rattachés.
        </p>
      )}
      {toCentrale && (
        <p className="rounded-lg border border-line bg-white/[0.015] px-3 py-2.5 text-[12.5px] text-fg-muted">
          Passage en centrale{" "}: les chauffeurs entrés par la validation automatique du lien d&apos;inscription (jamais vérifiés)
          seront au niveau «{" "}Nouveau{" "}» (courses plafonnées) jusqu&apos;à leur confirmation dans «{" "}Réseau{" "}»{" "}; ceux
          créés ou validés par la flotte sont «{" "}Confirmés{" "}».
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        {dirty && (
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setValue(model);
              setPercent(percentToInput(feePercent));
              setFixed(centsToInput(feeFixedCents));
              setErrors({});
            }}
          >
            Annuler
          </Button>
        )}
        <Button variant="primary" disabled={!dirty} loading={pending && !confirm} onClick={() => (toFleet ? setConfirm(true) : save())}>
          Enregistrer
        </Button>
      </div>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent title="Repasser en mode flotte ?" description="Le compte redevient une flotte classique : plus de répartition part chauffeur / commission sur les nouvelles courses.">
          <ul className="space-y-2 text-[13px] text-fg-muted">
            <li className="flex gap-2">
              <span className="text-amber">•</span> Le lien d&apos;inscription /rejoindre est conservé (même adresse, mêmes réglages){" "}: la page
              s&apos;adapte à la flotte et les candidatures en attente restent à valider dans «{" "}Inscriptions{" "}».
            </li>
            <li className="flex gap-2"><span className="text-amber">•</span> Les chauffeurs et règlements existants sont conservés.</li>
            <li className="flex gap-2">
              <span className="text-amber">•</span> Frais Rydar&nbsp;: ceux réglés ci-dessus s&apos;appliquent aux courses terminées en flotte&nbsp;; les frais déjà dus restent dus.
            </li>
            <li className="flex gap-2"><span className="text-amber">•</span> Vous pourrez repasser en centrale à tout moment.</li>
          </ul>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(false)}>Annuler</Button>
            <Button variant="danger" loading={pending} onClick={save}>Passer en mode flotte</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
