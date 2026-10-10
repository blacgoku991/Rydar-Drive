"use client";
// Fenêtre « Ajouter un document » (extraite de DriverControls) : ouverte par le bouton « Document » de l'en-tête de la
// fiche, ou par « Ajouter » sur une pièce manquante ou expirée (type choisi d'office : `defaultType`). Même action et
// même charge qu'avant (addDriverDocument : type, numéro, date d'expiration ; la photo se dépose depuis l'application).
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { addDriverDocument } from "@/app/dashboard/drivers/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { submitWith } from "@/lib/utils";

/** Types proposés à l'ajout (« Visite médicale » n'est plus proposée : aucune donnée de santé collectée). */
export const ADDABLE_DOCUMENT_TYPES = [
  { value: "vtc_card", label: "Carte VTC" },
  { value: "driving_license", label: "Permis de conduire" },
  { value: "insurance", label: "Assurance RC Pro" },
  { value: "vehicle_registration", label: "Carte grise" },
  { value: "identity", label: "Pièce d'identité" },
  { value: "other", label: "Autre" },
] as const;
export type AddableDocumentType = (typeof ADDABLE_DOCUMENT_TYPES)[number]["value"];

export const isAddableDocumentType = (type: string): type is AddableDocumentType => ADDABLE_DOCUMENT_TYPES.some((t) => t.value === type);

/** Pièces à échéance : date obligatoire (même règle que l'action serveur et que review_driver_document). */
const EXPIRY_REQUIRED = new Set<string>(["vtc_card", "driving_license", "insurance", "identity"]);

export function AddDocumentDialog({
  driverId,
  open,
  onOpenChange,
  defaultType = "vtc_card",
  self = false,
}: {
  driverId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Type choisi à l'ouverture (« Ajouter » sur une pièce manquante) */
  defaultType?: AddableDocumentType;
  /** Fiche du propriétaire lui-même (Flotte Privée, « Mon profil chauffeur ») */
  self?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [docType, setDocType] = useState<string>(defaultType);
  // Chaque ouverture repart du type demandé, sans erreur d'une saisie précédente
  useEffect(() => {
    if (open) {
      setDocType(defaultType);
      setErrors({});
    }
  }, [open, defaultType]);
  const expiryRequired = EXPIRY_REQUIRED.has(docType);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Ajouter un document"
        description={
          self
            ? "La photo se dépose depuis l'application\u00a0; ici, vous enregistrez le numéro et la date d'expiration."
            : "Carte VTC, permis, assurance… avec la date d'expiration pour les rappels."
        }
      >
        <form
          onSubmit={submitWith((f) =>
            start(() =>
              runAction(async () => {
                const res = await addDriverDocument(driverId, {
                  type: String(f.get("type")) as never,
                  number: String(f.get("number") ?? ""),
                  expiresAt: String(f.get("expiresAt") ?? ""),
                });
                if (!res.ok) {
                  setErrors(res.fieldErrors ?? {});
                  toast.error(res.error);
                  return;
                }
                setErrors({});
                toast.success("Document ajouté");
                onOpenChange(false);
                router.refresh();
              }),
            ),
          )}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        >
          <Field label="Type" className="sm:col-span-2">
            <NativeSelect name="type" value={docType} onChange={(e) => setDocType(e.target.value)}>
              {ADDABLE_DOCUMENT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Numéro" optional>
            <Input name="number" autoComplete="off" />
          </Field>
          <Field label="Expire le" optional={!expiryRequired} error={errors.expiresAt}>
            <Input name="expiresAt" type="date" required={expiryRequired} className="[color-scheme:dark]" aria-invalid={!!errors.expiresAt} />
          </Field>
          <DialogFooter className="sm:col-span-2" backDisabled={pending}>
            <Button type="submit" variant="primary" loading={pending}>
              Ajouter le document
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
