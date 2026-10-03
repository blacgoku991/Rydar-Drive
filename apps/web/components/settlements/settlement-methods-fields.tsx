"use client";
// Moyens de paiement proposés aux chauffeurs (lien, virement avec RIB, espèces, autre) : bloc partagé entre
// « Commission & encaissement » (centrale) et la carte « Encaissement » du réseau partagé (flotte). Mêmes colonnes
// (organization_settings.settlement_*) et même schéma (settlementPaymentSchema) des deux côtés.
import { SETTLEMENT_LINK_EXAMPLES, formatIban, formatPrice, isValidIban, settlementPaymentLink, type SettlementMethod } from "@rydar/shared";
import { Check, ExternalLink, Landmark } from "lucide-react";
import { useId } from "react";
import { METHOD_ICON, methodLabel } from "@/components/settlements/settlement-ui";
import { Field, Input, Textarea } from "@/components/ui/input";
import { NewTabHint } from "@/components/ui/new-tab";
import { cn } from "@/lib/utils";

export type SettlementMethodsValue = {
  methods: SettlementMethod[];
  link: string;
  instructions: string;
  payeeName: string;
  iban: string;
  bic: string;
};

export const SETTLEMENT_METHODS_ORDER: SettlementMethod[] = ["link", "transfer", "cash", "other"];
/** Bouton affiché au chauffeur dans l'application */
const DRIVER_BUTTON: Record<SettlementMethod, string> = {
  link: "Payer par lien",
  transfer: "J'ai payé par virement",
  cash: "J'ai payé en espèces",
  other: "J'ai payé (autre moyen)",
};
export const SAMPLE_AMOUNT = 1900;
export const SAMPLE_REF = "C1783";

/** Lien de paiement d'exemple (19 € · réf. C1783), null si le lien n'est pas un https:// valide. */
export function settlementLinkPreview(link: string): string | null {
  const v = link.trim();
  return v && /^https:\/\/\S+$/.test(v) ? settlementPaymentLink(v, SAMPLE_AMOUNT, SAMPLE_REF) : null;
}

/** Valeur du formulaire depuis les colonnes d'organization_settings. */
export function settlementMethodsFromRow(s: {
  settlement_methods: SettlementMethod[] | null;
  settlement_link: string | null;
  settlement_instructions: string | null;
  settlement_payee_name: string | null;
  settlement_iban: string | null;
  settlement_bic: string | null;
}): SettlementMethodsValue {
  return {
    methods: s.settlement_methods?.length ? s.settlement_methods : ["link", "cash"],
    link: s.settlement_link ?? "",
    instructions: s.settlement_instructions ?? "",
    payeeName: s.settlement_payee_name ?? "",
    iban: formatIban(s.settlement_iban),
    bic: s.settlement_bic ?? "",
  };
}

export function SettlementMethodsFields({
  value: f,
  onChange: set,
  errors,
  readOnly,
  orgName,
  legalName,
  currency = "EUR",
  audience = "Le chauffeur",
  whatsapp = true,
}: {
  value: SettlementMethodsValue;
  onChange: <K extends keyof SettlementMethodsValue>(key: K, value: SettlementMethodsValue[K]) => void;
  errors: Record<string, string>;
  readOnly: boolean;
  orgName: string;
  legalName?: string | null;
  currency?: string;
  /** Sujet des textes d'aide (« Le chauffeur », « Le chauffeur partenaire ») */
  audience?: string;
  /** Instructions reprises dans les relances WhatsApp (centrale) ; réseau partagé : application seulement (v1) */
  whatsapp?: boolean;
}) {
  // « chauffeur » / « chauffeur partenaire » : libellés du champ « Instructions » et de l'aperçu
  const noun = audience.replace(/^Le /, "");
  // Moyen coché mais non renseigné : le chauffeur ne le verrait pas
  const ready: Record<SettlementMethod, boolean> = {
    link: /^https:\/\/\S+$/.test(f.link.trim()),
    transfer: isValidIban(f.iban),
    cash: true,
    other: f.instructions.trim().length > 0,
  };
  const linkPreview = settlementLinkPreview(f.link);
  const methodsId = useId();

  return (
    <div className="space-y-6">
      {/* Boutons à bascule (aria-pressed) groupés sous leur intitulé, erreur reliée au groupe (pas de champ unique) */}
      <div role="group" aria-labelledby={`${methodsId}-label`} aria-describedby={errors.methods ? `${methodsId}-error` : undefined}>
        <p id={`${methodsId}-label`} className="mb-2 text-[12.5px] font-medium text-fg-muted">Moyens acceptés</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {SETTLEMENT_METHODS_ORDER.map((m) => {
            const Icon = METHOD_ICON[m];
            const on = f.methods.includes(m);
            return (
              <button
                key={m}
                type="button"
                disabled={readOnly}
                aria-pressed={on}
                onClick={() => set("methods", on ? f.methods.filter((x) => x !== m) : SETTLEMENT_METHODS_ORDER.filter((x) => x === m || f.methods.includes(x)))}
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
        {errors.methods && (
          <p id={`${methodsId}-error`} className="mt-1.5 text-xs text-red">
            {errors.methods}
          </p>
        )}
      </div>

      {f.methods.includes("link") && (
        <div className="space-y-2">
          <Field
            label="Lien de paiement"
            error={errors.link}
            hint={
              <>
                Variables : <code className="mono text-fg-muted">{"{montant}"}</code> (19.00), <code className="mono text-fg-muted">{"{montant_centimes}"}</code> (1900),{" "}
                <code className="mono text-fg-muted">{"{reference}"}</code> (C1783) — remplacées pour chaque règlement.
              </>
            }
          >
            <Input
              name="link"
              value={f.link}
              disabled={readOnly}
              onChange={(e) => set("link", e.target.value)}
              placeholder="https://revolut.me/votre-identifiant/{montant}"
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
                <ExternalLink aria-hidden className="size-3.5 shrink-0" />
                <NewTabHint />
              </a>
            ) : (
              <p className="mt-1 text-[12.5px] text-fg-subtle">{f.link.trim() ? "Lien invalide : il doit commencer par https://" : "Collez le lien de votre compte (Revolut, PayPal, Lydia, Stripe…)."}</p>
            )}
            {linkPreview && !/\{montant(_centimes)?\}/.test(f.link) && (
              <p className="mt-1.5 text-[12px] text-amber">Sans {"{montant}"}, le chauffeur devra saisir le montant lui-même.</p>
            )}
          </div>
        </div>
      )}

      {f.methods.includes("transfer") && (
        <div className="space-y-3 rounded-xl border border-line bg-white/[0.02] p-4">
          <p className="flex items-center gap-2 text-[13px] font-medium">
            <Landmark className="size-4 text-fg-subtle" />
            Virement : vos coordonnées bancaires (RIB)
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Bénéficiaire" optional hint="Nom du titulaire du compte, affiché au chauffeur." error={errors.payeeName}>
              <Input name="payeeName" value={f.payeeName} disabled={readOnly} maxLength={120} onChange={(e) => set("payeeName", e.target.value)} placeholder={legalName || orgName} aria-invalid={!!errors.payeeName} />
            </Field>
            <Field label="BIC" optional error={errors.bic}>
              <Input name="bic" value={f.bic} disabled={readOnly} maxLength={14} onChange={(e) => set("bic", e.target.value.toUpperCase())} placeholder="AGRIFRPP" className="mono" aria-invalid={!!errors.bic} spellCheck={false} />
            </Field>
          </div>
          <Field label="IBAN" error={errors.iban}>
            <Input
              name="iban"
              value={f.iban}
              disabled={readOnly}
              maxLength={42}
              onChange={(e) => set("iban", e.target.value.toUpperCase())}
              onBlur={() => set("iban", formatIban(f.iban))}
              placeholder="FR76 3000 6000 0112 3456 7890 189"
              className="mono"
              aria-invalid={!!errors.iban}
              spellCheck={false}
            />
          </Field>
          <p className="text-[12px] text-fg-subtle">{audience} copie l&apos;IBAN et la référence depuis l&apos;application, puis signale « J&apos;ai payé par virement ».</p>
        </div>
      )}

      <Field
        label={f.methods.includes("other") ? "Autre moyen : comment payer" : `Instructions au ${noun}`}
        optional={!f.methods.includes("other")}
        hint={
          f.methods.includes("other")
            ? "Ex. Wero ou Lydia au 06 12 34 56 78, ou au bureau du lundi au vendredi."
            : whatsapp
              ? "Affichées avec le montant à régler (application et message WhatsApp)."
              : `Affichées au ${noun} avec le montant à régler, dans l'application.`
        }
        error={errors.instructions}
      >
        <Textarea
          name="instructions"
          value={f.instructions}
          disabled={readOnly}
          maxLength={500}
          onChange={(e) => set("instructions", e.target.value)}
          placeholder={f.methods.includes("other") ? "Ex. Wero au 06 12 34 56 78 en indiquant la référence (C1783)." : "Ex. indiquez la référence (C1783) dans le commentaire du paiement."}
          className="min-h-[72px]"
        />
      </Field>

      <div className="rounded-xl bg-white/[0.03] px-4 py-3">
        <p className="mb-2 text-[11.5px] font-medium uppercase tracking-wide text-fg-subtle">Dans l&apos;application, le {noun} voit</p>
        <div className="flex flex-wrap gap-1.5">
          {f.methods.map((m) => (
            <span key={m} className={cn("rounded-lg border px-2.5 py-1 text-[12.5px]", ready[m] ? "border-line-strong text-fg" : "border-amber/40 text-amber")}>
              {DRIVER_BUTTON[m]}
              {!ready[m] && " — à renseigner"}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
