"use client";
// Flotte Privée, Accueil et fiche d'une réservation : « Fixer le prix » (demande du site sans prix) ou « Modifier le
// prix » (prix et moyen de paiement ; updateRidePricing, sans commission : modèle flotte). Prix vide : demande sans prix
// (« prix à fixer »). Charge envoyée inchangée.
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type PaymentMethod } from "@rydar/shared";
import { Pencil, Tag } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updateRidePricing } from "@/app/dashboard/rides/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { submitWith } from "@/lib/utils";

const NB = " ";

/** « 85 » / « 85,50 » → centimes ; vide → null ; illisible → NaN. */
function eurosToCents(v: string): number | null {
  const t = v.trim().replace(/\s/g, "").replace(",", ".");
  if (!t) return null;
  return /^\d{1,6}(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : Number.NaN;
}

const centsToInput = (cents: number | null) => (cents == null ? "" : (cents / 100).toFixed(cents % 100 ? 2 : 0).replace(".", ","));

export function EditPriceButton({
  rideId,
  number,
  priceCents,
  paymentMethod,
  size = "md",
  variant = "secondary",
}: {
  rideId: string;
  number: number;
  priceCents: number | null;
  paymentMethod: PaymentMethod;
  size?: "sm" | "md";
  variant?: "secondary" | "outline";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Sans prix (demande du site) : « Fixer le prix » ; sinon « Modifier le prix »
  const toFix = priceCents == null;

  return (
    <>
      <Button variant={variant} size={size} onClick={() => (setErrors({}), setOpen(true))}>
        {toFix ? <Tag /> : <Pencil />} {toFix ? "Fixer le prix" : "Modifier le prix"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`Prix de la réservation #${number}`} description="Prix payé par le client, toutes taxes comprises." size="sm">
          <form
            onSubmit={submitWith((f) => {
              const cents = eurosToCents(String(f.get("price") ?? ""));
              if (cents !== null && Number.isNaN(cents)) {
                setErrors({ priceCents: `Montant en euros (ex.${NB}: 85 ou 85,50)` });
                return;
              }
              const method = String(f.get("payment") ?? "") as PaymentMethod;
              start(() => runAction(async () => {
                const res = await updateRidePricing(rideId, { priceCents: cents, commissionCents: null, paymentMethod: method });
                if (!res.ok) {
                  setErrors(res.fieldErrors ?? {});
                  toast.error(res.error);
                  return;
                }
                toast.success(res.changed ? "Prix enregistré" : "Aucun changement");
                setOpen(false);
                router.refresh();
              }));
            })}
            className="space-y-4"
          >
            <Field label="Prix (€ TTC)" optional hint={`Vide${NB}: demande sans prix.`} error={errors.priceCents}>
              <Input name="price" defaultValue={centsToInput(priceCents)} inputMode="decimal" className="num" autoComplete="off" placeholder={`ex.${NB}: 85 ou 85,50`} />
            </Field>
            <Field label="Paiement">
              <NativeSelect name="payment" defaultValue={paymentMethod}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <DialogFooter backDisabled={pending}>
              <Button type="submit" variant="primary" loading={pending}>
                Enregistrer le prix
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
