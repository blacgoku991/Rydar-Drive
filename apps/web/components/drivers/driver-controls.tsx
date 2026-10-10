"use client";
// Actions de l'en-tête d'une fiche chauffeur (docs/REFONTE-PANELS.md, R8) : « Modifier », « Document », puis le menu
// « Plus d'actions » (propriétaire et administrateur) : mot de passe, déconnexion de ses appareils, désactivation ou
// activation, suspension (en dernier, en rouge). Ce qui coupe un accès demande une confirmation qui dit la conséquence
// (lue dans setDriverStatus / revokeDriverSessions et leurs RPC) ; actions serveur et charges inchangées.
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_META } from "@rydar/shared";
import { Ban, CheckCircle2, EllipsisVertical, FilePlus2, KeyRound, LogOut, Pencil, PowerOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { resetDriverPassword, revokeDriverSessions, setDriverStatus, updateDriver } from "@/app/dashboard/drivers/actions";
import { AddDocumentDialog } from "@/components/drivers/add-document-dialog";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/misc";
import { runAction } from "@/lib/run-action";
import { submitWith } from "@/lib/utils";

const NB = "\u00a0";

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

type DialogKind = null | "suspend" | "password" | "edit" | "document" | "logout" | "deactivate";

/**
 * `self` (Flotte Privée, « Mon profil chauffeur ») : la fiche du propriétaire lui-même — « Modifier ma fiche » et
 * « Ajouter un document » seulement (canManage faux), sans notes de gestion.
 */
export function DriverControls({ driver, canManage, self = false }: { driver: DriverData; canManage: boolean; self?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const name = `${driver.first_name} ${driver.last_name}`;

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string; fieldErrors?: Record<string, string> }>, msg: string) =>
    start(() => runAction(async () => {
      const res = await fn();
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      setErrors({});
      toast.success(res.message ?? msg);
      setDialog(null);
      router.refresh();
    }));

  const open = (kind: DialogKind) => {
    setErrors({});
    setDialog(kind);
  };
  const close = (o: boolean) => {
    if (!o) setDialog(null);
  };

  return (
    <>
      <Button variant="secondary" onClick={() => open("edit")}>
        <Pencil /> {self ? "Modifier ma fiche" : "Modifier"}
      </Button>
      <Button variant="secondary" onClick={() => open("document")}>
        <FilePlus2 /> {self ? "Ajouter un document" : "Document"}
      </Button>
      {canManage && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" disabled={pending}>
              <EllipsisVertical /> Plus d&apos;actions
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[min(18rem,calc(100vw-2rem))]">
            <DropdownMenuItem onSelect={() => { setPassword(""); open("password"); }}>
              <KeyRound /> Changer le mot de passe
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => open("logout")}>
              <LogOut /> Déconnecter de ses appareils
            </DropdownMenuItem>
            {driver.status !== "active" && (
              <DropdownMenuItem onSelect={() => run(() => setDriverStatus(driver.id, { status: "active" }), "Chauffeur activé")}>
                <CheckCircle2 /> Activer le chauffeur
              </DropdownMenuItem>
            )}
            {/* Actions qui coupent l'accès : en dernier, en rouge (désactiver si actif, suspendre sauf déjà suspendu) */}
            {driver.status !== "suspended" && <DropdownMenuSeparator />}
            {driver.status === "active" && (
              <DropdownMenuItem destructive onSelect={() => open("deactivate")}>
                <PowerOff /> Désactiver le chauffeur
              </DropdownMenuItem>
            )}
            {driver.status !== "suspended" && (
              <DropdownMenuItem destructive onSelect={() => { setReason(""); open("suspend"); }}>
                <Ban /> Suspendre le chauffeur
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Déconnexion : revoke_driver_sessions ferme toutes ses sessions ; disponible → hors ligne */}
      <ConfirmDialog
        open={dialog === "logout"}
        onOpenChange={close}
        title={`Déconnecter ${name} de ses appareils${NB}?`}
        consequence={`Toutes ses sessions sont fermées${NB}: il devra se reconnecter à l'application sur ses téléphones, et passe hors ligne s'il était disponible.`}
        confirmLabel="Déconnecter ses appareils"
        loading={pending}
        onConfirm={() => run(() => revokeDriverSessions(driver.id), "Chauffeur déconnecté de tous ses appareils")}
      />

      {/* Désactivation : set_driver_status (inactive) — offres closes, courses non commencées remises en recherche, sessions fermées */}
      <ConfirmDialog
        open={dialog === "deactivate"}
        onOpenChange={close}
        title={`Désactiver ${name}${NB}?`}
        consequence={`Il ne reçoit plus de courses et l'application le déconnecte${NB}; ses courses attribuées pas encore commencées sont remises en recherche. Vous pourrez le réactiver à tout moment.`}
        confirmLabel="Désactiver le chauffeur"
        loading={pending}
        onConfirm={() => run(() => setDriverStatus(driver.id, { status: "inactive" }), "Chauffeur désactivé")}
      />

      <Dialog open={dialog === "suspend"} onOpenChange={close}>
        <DialogContent
          title={`Suspendre ${name}${NB}?`}
          description={`Accès coupé immédiatement${NB}: il ne reçoit plus de courses et ses courses attribuées pas encore commencées sont remises en recherche. Impossible pendant une course avec client à bord.`}
        >
          <Field label="Motif (visible dans l'audit)" optional>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder={`ex.${NB}: document expiré, comportement…`} />
          </Field>
          <DialogFooter backDisabled={pending}>
            <Button variant="danger" loading={pending} onClick={() => run(() => setDriverStatus(driver.id, { status: "suspended", reason }), "Chauffeur suspendu")}>
              Suspendre le chauffeur
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "password"} onOpenChange={close}>
        <DialogContent title="Nouveau mot de passe" description="Le chauffeur est déconnecté de tous ses appareils et devra se reconnecter avec ce mot de passe.">
          <Field label="Mot de passe" hint="10 caractères minimum." error={errors.password}>
            <Input value={password} onChange={(e) => setPassword(e.target.value)} className="num" autoComplete="new-password" />
          </Field>
          <DialogFooter backDisabled={pending}>
            <Button variant="primary" loading={pending} onClick={() => run(() => resetDriverPassword(driver.id, password), "Mot de passe modifié")}>
              Enregistrer le mot de passe
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddDocumentDialog driverId={driver.id} self={self} open={dialog === "document"} onOpenChange={close} />

      <Dialog open={dialog === "edit"} onOpenChange={close}>
        <DialogContent title={self ? "Modifier ma fiche" : "Modifier le chauffeur"} size="lg">
          <form
            onSubmit={submitWith((f) => {
              const g = (k: string) => String(f.get(k) ?? "");
              run(
                () =>
                  updateDriver(driver.id, {
                    firstName: g("firstName"), lastName: g("lastName"), phone: g("phone"), email: g("email"),
                    vtcCardNumber: g("vtc"), notes: self ? (driver.notes ?? "") : g("notes"),
                    vehicle: {
                      brand: g("brand"), model: g("model"), color: g("color"), plate: g("plate"),
                      category: g("category") as never, seats: Number(g("seats")), luggageCapacity: Number(g("luggage")),
                    },
                  }),
                "Fiche mise à jour",
              );
            })}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          >
            <Field label="Prénom" error={errors.firstName}><Input name="firstName" defaultValue={driver.first_name} autoComplete="off" /></Field>
            <Field label="Nom" error={errors.lastName}><Input name="lastName" defaultValue={driver.last_name} autoComplete="off" /></Field>
            <Field label="Téléphone" error={errors.phone}><Input name="phone" type="tel" inputMode="tel" defaultValue={driver.phone} autoComplete="off" /></Field>
            <Field
              label="E-mail de contact"
              hint={
                self
                  ? "Votre identifiant de connexion reste l'adresse de votre compte."
                  : "L'identifiant de connexion du chauffeur reste l'adresse utilisée à la création du compte."
              }
              error={errors.email}
            >
              <Input name="email" type="email" inputMode="email" defaultValue={driver.email ?? ""} autoComplete="off" />
            </Field>
            <Field label="N° carte VTC" optional className="sm:col-span-2"><Input name="vtc" defaultValue={driver.vtc_card_number ?? ""} autoComplete="off" /></Field>
            <Field label="Marque" optional><Input name="brand" defaultValue={driver.vehicle?.brand ?? ""} autoComplete="off" /></Field>
            <Field label="Modèle" error={errors["vehicle.model"]}><Input name="model" defaultValue={driver.vehicle?.model ?? ""} autoComplete="off" /></Field>
            <Field label="Plaque" error={errors["vehicle.plate"]}><Input name="plate" defaultValue={driver.vehicle?.plate ?? ""} className="num uppercase" autoComplete="off" /></Field>
            <Field label="Couleur" optional><Input name="color" defaultValue={driver.vehicle?.color ?? ""} autoComplete="off" /></Field>
            <Field label="Catégorie">
              <NativeSelect name="category" defaultValue={driver.vehicle?.category ?? "standard"}>
                {VEHICLE_CATEGORIES.map((c) => <option key={c} value={c}>{VEHICLE_CATEGORY_META[c].label}</option>)}
              </NativeSelect>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Places"><Input name="seats" type="number" inputMode="numeric" defaultValue={driver.vehicle?.seats ?? 4} /></Field>
              <Field label="Bagages"><Input name="luggage" type="number" inputMode="numeric" defaultValue={driver.vehicle?.luggage_capacity ?? 3} /></Field>
            </div>
            {!self && (
              <Field label="Notes (visibles par le chauffeur)" optional hint={`Le chauffeur peut les lire${NB}: n'y notez rien de confidentiel, ni aucune donnée sensible (santé, opinions, infractions).`} className="sm:col-span-2">
                <Textarea name="notes" defaultValue={driver.notes ?? ""} />
              </Field>
            )}
            <DialogFooter className="sm:col-span-2" backDisabled={pending} sticky>
              <Button type="submit" variant="primary" loading={pending}>Enregistrer</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
