"use client";
// Super admin : coordonnées de paiement de Rydar, affichées aux centrales avec le montant et la référence à indiquer.
import { formatIban, settlementPaymentLink, type AdminPlatformOverview } from "@rydar/shared";
import { AlertTriangle, Check, Copy, Landmark, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { updatePlatformBilling } from "@/app/admin/frais/actions";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { submitWith } from "@/lib/utils";
import { ago } from "./admin-platform-format";
import { usePlatformRunner } from "./admin-platform-dialogs";

type Billing = AdminPlatformOverview["billing"];

const EXAMPLE_REF = "RYD-EXEMPLE";
const EXAMPLE_CENTS = 36500;

function Row({ label, value, mono, copy }: { label: string; value: string | null; mono?: boolean; copy?: string | null }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <dt className="shrink-0 text-[12.5px] text-fg-subtle">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5 text-right">
        {value ? (
          <span className={mono ? "mono text-[13px] text-fg [overflow-wrap:anywhere]" : "text-[13px] text-fg [overflow-wrap:anywhere]"}>{value}</span>
        ) : (
          <span className="text-[13px] text-fg-subtle">Non renseigné</span>
        )}
        {copy && (
          <button
            type="button"
            aria-label={`Copier ${label}`}
            onClick={() =>
              navigator.clipboard?.writeText(copy).then(
                () => toast.success(`${label} copié`),
                () => undefined,
              )
            }
            className="grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle hover:bg-white/5 hover:text-fg"
          >
            <Copy className="size-3.5" />
          </button>
        )}
      </dd>
    </div>
  );
}

export function BillingCard({ billing }: { billing: Billing }) {
  const [open, setOpen] = useState(false);
  const configured = !!(billing.iban || billing.payment_link);
  const example = settlementPaymentLink(billing.payment_link, EXAMPLE_CENTS, EXAMPLE_REF);
  return (
    <Card>
      <CardHeader
        title="Coordonnées de paiement de Rydar"
        icon={<Landmark />}
        description="Affichées aux centrales avec le montant dû et leur référence de virement."
        action={
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Pencil /> Modifier
          </Button>
        }
      />
      <CardBody className="pt-3">
        {!configured && (
          <p className="mb-3 flex items-start gap-2 rounded-lg border border-amber/25 bg-amber/[0.07] px-3 py-2 text-[12.5px] text-fg-muted">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber" />
            Les centrales ne voient aucune coordonnée&nbsp;: renseignez au moins un IBAN ou un lien de paiement.
          </p>
        )}
        <dl className="divide-y divide-line">
          <Row label="Bénéficiaire" value={billing.payee_name} />
          <Row label="IBAN" value={billing.iban ? formatIban(billing.iban) : null} mono copy={billing.iban} />
          <Row label="BIC" value={billing.bic} mono copy={billing.bic} />
          <Row label="Lien de paiement" value={billing.payment_link} mono />
          <Row label="Instructions" value={billing.instructions} />
        </dl>
        {example && (
          <p className="mt-2 text-[12px] text-fg-subtle [overflow-wrap:anywhere]">
            Exemple pour 365&nbsp;€&nbsp;: <span className="mono text-fg-muted">{example}</span>
          </p>
        )}
        <p className="mt-3 text-[11.5px] text-fg-subtle" suppressHydrationWarning>
          Modifié {ago(billing.updated_at)}
        </p>
      </CardBody>
      <BillingDialog open={open} onOpenChange={setOpen} billing={billing} />
    </Card>
  );
}

function BillingDialog({ open, onOpenChange, billing }: { open: boolean; onOpenChange: (o: boolean) => void; billing: Billing }) {
  const { pending, run } = usePlatformRunner();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [link, setLink] = useState(billing.payment_link ?? "");
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setLink(billing.payment_link ?? "");
  }, [open, billing.payment_link]);
  const preview = link.trim() ? settlementPaymentLink(link.trim(), EXAMPLE_CENTS, EXAMPLE_REF) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="md"
        title="Coordonnées de paiement"
        description="Les organisations les voient dans « Encaissements » (centrale) ou « Frais Rydar » (flotte), avec le montant à régler et leur référence."
      >
        <form
          noValidate
          onSubmit={submitWith((fd) =>
            run(
              () =>
                updatePlatformBilling({
                  payeeName: String(fd.get("payeeName") ?? ""),
                  iban: String(fd.get("iban") ?? ""),
                  bic: String(fd.get("bic") ?? ""),
                  paymentLink: String(fd.get("paymentLink") ?? ""),
                  instructions: String(fd.get("instructions") ?? ""),
                }),
              { onDone: () => onOpenChange(false), onError: (res) => setErrors(res.fieldErrors ?? {}) },
            ),
          )}
          className="space-y-4"
        >
          <Field label="Bénéficiaire" optional htmlFor="bl-payee" error={errors.payeeName}>
            <Input
              id="bl-payee"
              name="payeeName"
              defaultValue={billing.payee_name ?? ""}
              maxLength={120}
              placeholder="Ex. Rydar SAS"
              aria-invalid={!!errors.payeeName || undefined}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
            <Field label="IBAN" optional htmlFor="bl-iban" error={errors.iban}>
              <Input
                id="bl-iban"
                name="iban"
                defaultValue={formatIban(billing.iban)}
                maxLength={48}
                placeholder="FR76 3000 6000 0112 3456 7890 189"
                className="mono uppercase"
                aria-invalid={!!errors.iban || undefined}
              />
            </Field>
            <Field label="BIC" optional htmlFor="bl-bic" error={errors.bic}>
              <Input
                id="bl-bic"
                name="bic"
                defaultValue={billing.bic ?? ""}
                maxLength={14}
                placeholder="AGRIFRPP"
                className="mono uppercase"
                aria-invalid={!!errors.bic || undefined}
              />
            </Field>
          </div>
          <Field
            label="Lien de paiement"
            optional
            htmlFor="bl-link"
            error={errors.paymentLink}
            hint={
              preview ? (
                <span className="[overflow-wrap:anywhere]">
                  Pour 365&nbsp;€&nbsp;: <span className="mono text-fg-muted">{preview}</span>
                </span>
              ) : (
                <>
                  https:// uniquement. Variables&nbsp;: <span className="mono">{"{montant}"}</span> (365.00), <span className="mono">{"{montant_centimes}"}</span>{" "}
                  (36500), <span className="mono">{"{reference}"}</span>.
                </>
              )
            }
          >
            <Input
              id="bl-link"
              name="paymentLink"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              maxLength={500}
              placeholder="https://revolut.me/rydar/{montant}"
              className="mono"
              aria-invalid={!!errors.paymentLink || undefined}
            />
          </Field>
          <Field
            label="Instructions"
            optional
            htmlFor="bl-instructions"
            error={errors.instructions}
            hint="Ex. délai, justificatif à envoyer, contact comptabilité."
          >
            <Textarea
              id="bl-instructions"
              name="instructions"
              defaultValue={billing.instructions ?? ""}
              maxLength={500}
              className="min-h-[72px]"
              placeholder="Indiquez la référence RYD-… en libellé du virement."
              aria-invalid={!!errors.instructions || undefined}
            />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              <Check /> Enregistrer
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
