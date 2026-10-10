"use client";
// Flotte Privée : actions sur une réservation (Accueil, Réservations, fiche) — « Je la prends » (driver_take_ride, comme
// « Confirmer » / « La prendre » dans l'application : offre acceptée, aucune notification « attribuée » vers son propre
// téléphone, 6 h au plus après l'heure prévue), « Refuser » (decline_ride_offer), « Annuler la réservation » (cancel_ride,
// motif ; sur la fiche seulement : `cancel`), « Appeler » le client ; « Je la prends » et « Refuser » avec le compte de la
// session, qui est celui de la fiche. Jamais « Attribuer à… », « Relancer » ni « Retirer » (§ 7.3). Refus de la base
// affichés tels quels.
import { canCancel, formatPhone, type PrivateFleetBookingState, type RideStatus } from "@rydar/shared";
import { Ban, Check, Phone, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { cancelRide, declineOffer, takeBooking } from "@/app/dashboard/rides/actions";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { submitWith } from "@/lib/utils";

const NB = " ";

export type BookingActionTarget = {
  id: string;
  number: number;
  status: RideStatus;
  state: PrivateFleetBookingState | null;
  /** Offre en attente du chauffeur (« Refuser ») */
  offerId: string | null;
  /** Sans chauffeur, prise en charge il y a moins de 6 h */
  takeable: boolean;
  customerPhone: string | null;
};

/** Motif d'annulation : 3 à 280 caractères (comme l'application). */
const REASON_MIN = 3;
const REASON_MAX = 280;

export function BookingActions({
  booking,
  driverId,
  size = "sm",
  call = true,
  cancel = true,
}: {
  booking: BookingActionTarget;
  /** Fiche du propriétaire (null : fiche supprimée, « Je la prends » impossible) */
  driverId: string | null;
  size?: "sm" | "md";
  /** Bouton « Appeler » (masqué quand le numéro est déjà affiché à côté) */
  call?: boolean;
  /** Bouton « Annuler la réservation » (faux sur l'Accueil : l'annulation se fait depuis la fiche) */
  cancel?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [dialog, setDialog] = useState<null | "decline" | "cancel">(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const label = `Réservation #${booking.number}`;

  /** `description` : texte sous le message de succès, éventuellement d'après la réponse de l'action. */
  const run = <R extends { ok: boolean; error?: string }>(fn: () => Promise<R>, success: string, description?: string | ((res: R) => string)) =>
    start(() => runAction(async () => {
      const res = await fn();
      if (!res.ok) return void toast.error(res.error ?? "Action impossible.");
      const text = typeof description === "function" ? description(res) : description;
      toast.success(success, text ? { description: text } : undefined);
      setDialog(null);
      router.refresh();
    }));

  const take = () =>
    run(() => takeBooking(booking.id), `${label} confirmée`, (res) =>
      res.ok && res.chained ? "Elle vous est attribuée, à la suite de votre course en cours." : "Elle vous est attribuée.",
    );
  const decline = () => booking.offerId && run(() => declineOffer(booking.offerId!), `${label} refusée`, "Votre site en est informé.");

  return (
    <>
      {booking.takeable && driverId && (
        <Button variant="primary" size={size} loading={pending && dialog === null} onClick={take}>
          <Check /> Je la prends
        </Button>
      )}
      {booking.offerId && (
        <Button variant="secondary" size={size} disabled={pending} onClick={() => setDialog("decline")}>
          <X /> Refuser
        </Button>
      )}
      {cancel && canCancel(booking.status) && (
        <Button
          variant="outline"
          size={size}
          disabled={pending}
          onClick={() => {
            setReasonError(null);
            setDialog("cancel");
          }}
        >
          <Ban /> Annuler la réservation
        </Button>
      )}
      {call && booking.customerPhone && (
        <Button asChild variant="ghost" size={size}>
          <a href={`tel:${booking.customerPhone}`} aria-label={`Appeler le client au ${formatPhone(booking.customerPhone)}`}>
            <Phone /> Appeler
          </a>
        </Button>
      )}

      <ConfirmDialog
        open={dialog === "decline"}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Refuser la réservation #${booking.number}${NB}?`}
        consequence={`Elle passe «${NB}Refusée${NB}» tout de suite et votre site en est informé${NB}: prévenez votre client si besoin. Vous pourrez encore la prendre dans les 6${NB}heures qui suivent l'heure prévue.`}
        confirmLabel="Refuser la réservation"
        loading={pending}
        onConfirm={decline}
      />

      {cancel && (
        <Dialog open={dialog === "cancel"} onOpenChange={(o) => !o && setDialog(null)}>
          <DialogContent
            title={`Annuler la réservation #${booking.number}${NB}?`}
            description={`L'annulation est définitive${NB}; votre site en est informé. Indiquez le motif (visible dans la chronologie).`}
          >
            <form
              onSubmit={submitWith((f) => {
                const reason = String(f.get("reason") ?? "").trim();
                if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
                  setReasonError(`Entre ${REASON_MIN} et ${REASON_MAX} caractères`);
                  return;
                }
                setReasonError(null);
                run(() => cancelRide(booking.id, reason), `${label} annulée`);
              })}
            >
              <Field label="Motif" error={reasonError ?? undefined} hint={`${REASON_MIN} à ${REASON_MAX} caractères.`}>
                <Textarea name="reason" maxLength={REASON_MAX} placeholder={`ex.${NB}: client injoignable, vol annulé…`} />
              </Field>
              <DialogFooter backDisabled={pending}>
                <Button type="submit" variant="danger" loading={pending}>
                  Annuler la réservation
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
