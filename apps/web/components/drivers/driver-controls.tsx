"use client";
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_META } from "@rydar/shared";
import { Ban, CheckCircle2, FilePlus2, KeyRound, LogOut, Pencil, PowerOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { addDriverDocument, resetDriverPassword, revokeDriverSessions, setDriverStatus, updateDriver } from "@/app/dashboard/drivers/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { submitWith } from "@/lib/utils";

type DriverData = {
  id: string;
  status: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  vtc_card_number: string | null;
  notes: string | null;
  vehicle: { brand: string | null; model: string; color: string | null; plate: string; category: string; seats: number; luggage_capacity: number } | null;
};

export function DriverControls({ driver, canManage }: { driver: DriverData; canManage: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [dialog, setDialog] = useState<null | "suspend" | "password" | "edit" | "document">(null);
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const run = (fn: () => Promise<{ ok: boolean; error?: string; fieldErrors?: Record<string, string> }>, msg: string) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success(msg);
      setDialog(null);
      router.refresh();
    });

  return (
    <>
      <Button variant="secondary" onClick={() => setDialog("edit")}>
        <Pencil /> Modifier
      </Button>
      <Button variant="secondary" onClick={() => setDialog("document")}>
        <FilePlus2 /> Document
      </Button>
      {canManage && (
        <>
          <Button variant="secondary" onClick={() => setDialog("password")}>
            <KeyRound /> Mot de passe
          </Button>
          <Button variant="secondary" loading={pending} onClick={() => run(() => revokeDriverSessions(driver.id), "Chauffeur déconnecté de tous ses appareils")}>
            <LogOut /> Déconnecter
          </Button>
          {driver.status !== "active" && (
            <Button variant="primary" loading={pending} onClick={() => run(() => setDriverStatus(driver.id, { status: "active" }), "Chauffeur activé")}>
              <CheckCircle2 /> Activer
            </Button>
          )}
          {driver.status === "active" && (
            <Button variant="outline" loading={pending} onClick={() => run(() => setDriverStatus(driver.id, { status: "inactive" }), "Chauffeur désactivé")}>
              <PowerOff /> Désactiver
            </Button>
          )}
          {driver.status !== "suspended" && (
            <Button variant="danger" onClick={() => setDialog("suspend")}>
              <Ban /> Suspendre
            </Button>
          )}
        </>
      )}

      <Dialog open={dialog === "suspend"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent title="Suspendre le chauffeur" description="Accès révoqué immédiatement : il ne reçoit plus aucune course et ne peut plus se connecter.">
          <Field label="Motif (visible dans l'audit)">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Document expiré, comportement…" />
          </Field>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>Annuler</Button>
            <Button variant="danger" loading={pending} onClick={() => run(() => setDriverStatus(driver.id, { status: "suspended", reason }), "Chauffeur suspendu")}>
              Suspendre
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "password"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent title="Nouveau mot de passe" description="Le chauffeur est déconnecté de tous ses appareils et devra se reconnecter avec ce mot de passe.">
          <Field label="Mot de passe" hint="10 caractères minimum.">
            <Input value={password} onChange={(e) => setPassword(e.target.value)} className="num" />
          </Field>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>Annuler</Button>
            <Button variant="primary" loading={pending} onClick={() => run(() => resetDriverPassword(driver.id, password), "Mot de passe modifié")}>
              Enregistrer
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "document"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent title="Ajouter un document" description="Carte VTC, permis, assurance… avec date d'expiration pour les alertes.">
          <form
            onSubmit={submitWith((f) =>
              run(
                () =>
                  addDriverDocument(driver.id, {
                    type: String(f.get("type")) as never,
                    number: String(f.get("number") ?? ""),
                    expiresAt: String(f.get("expiresAt") ?? ""),
                  }),
                "Document ajouté",
              ),
            )}
            className="grid grid-cols-2 gap-3"
          >
            <Field label="Type" className="col-span-2">
              <NativeSelect name="type" defaultValue="vtc_card">
                <option value="vtc_card">Carte VTC</option>
                <option value="driving_license">Permis de conduire</option>
                <option value="insurance">Assurance RC Pro</option>
                <option value="vehicle_registration">Carte grise</option>
                <option value="identity">Pièce d&apos;identité</option>
                <option value="medical">Visite médicale</option>
                <option value="other">Autre</option>
              </NativeSelect>
            </Field>
            <Field label="Numéro" optional>
              <Input name="number" />
            </Field>
            <Field label="Expire le" optional>
              <Input name="expiresAt" type="date" className="[color-scheme:dark]" />
            </Field>
            <div className="col-span-2 mt-4 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setDialog(null)}>Annuler</Button>
              <Button type="submit" variant="primary" loading={pending}>Ajouter</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "edit"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent title="Modifier le chauffeur" size="lg">
          <form
            onSubmit={submitWith((f) => {
              const g = (k: string) => String(f.get(k) ?? "");
              run(
                () =>
                  updateDriver(driver.id, {
                    firstName: g("firstName"), lastName: g("lastName"), phone: g("phone"), email: g("email"),
                    vtcCardNumber: g("vtc"), notes: g("notes"),
                    vehicle: {
                      brand: g("brand"), model: g("model"), color: g("color"), plate: g("plate"),
                      category: g("category") as never, seats: Number(g("seats")), luggageCapacity: Number(g("luggage")),
                    },
                  }),
                "Fiche mise à jour",
              );
            })}
            className="grid grid-cols-2 gap-3"
          >
            <Field label="Prénom" error={errors.firstName}><Input name="firstName" defaultValue={driver.first_name} /></Field>
            <Field label="Nom" error={errors.lastName}><Input name="lastName" defaultValue={driver.last_name} /></Field>
            <Field label="Téléphone" error={errors.phone}><Input name="phone" defaultValue={driver.phone} /></Field>
            <Field label="E-mail" error={errors.email}><Input name="email" defaultValue={driver.email ?? ""} /></Field>
            <Field label="N° carte VTC" optional className="col-span-2"><Input name="vtc" defaultValue={driver.vtc_card_number ?? ""} /></Field>
            <Field label="Marque" optional><Input name="brand" defaultValue={driver.vehicle?.brand ?? ""} /></Field>
            <Field label="Modèle" error={errors["vehicle.model"]}><Input name="model" defaultValue={driver.vehicle?.model ?? ""} /></Field>
            <Field label="Plaque" error={errors["vehicle.plate"]}><Input name="plate" defaultValue={driver.vehicle?.plate ?? ""} className="num uppercase" /></Field>
            <Field label="Couleur" optional><Input name="color" defaultValue={driver.vehicle?.color ?? ""} /></Field>
            <Field label="Catégorie">
              <NativeSelect name="category" defaultValue={driver.vehicle?.category ?? "standard"}>
                {VEHICLE_CATEGORIES.map((c) => <option key={c} value={c}>{VEHICLE_CATEGORY_META[c].label}</option>)}
              </NativeSelect>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Places"><Input name="seats" type="number" defaultValue={driver.vehicle?.seats ?? 4} /></Field>
              <Field label="Bagages"><Input name="luggage" type="number" defaultValue={driver.vehicle?.luggage_capacity ?? 3} /></Field>
            </div>
            <Field label="Notes internes" optional className="col-span-2"><Textarea name="notes" defaultValue={driver.notes ?? ""} /></Field>
            <div className="col-span-2 mt-4 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setDialog(null)}>Annuler</Button>
              <Button type="submit" variant="primary" loading={pending}>Enregistrer</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
