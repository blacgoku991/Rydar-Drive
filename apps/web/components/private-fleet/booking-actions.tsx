"use client";
// Flotte Privée : actions sur une réservation (Accueil, Réservations, fiche) — « Je la prends » (assign_ride vers la
// fiche du propriétaire), « Refuser » (decline_ride_offer, même compte que la fiche), « Annuler » (cancel_ride, motif),
// « Appeler » le client. Jamais « Attribuer à… », « Relancer » ni « Retirer » (§ 7.3). Refus de la base affichés tels quels.
import { canCancel, formatPhone, type PrivateFleetBookingState, type RideStatus } from "@rydar/shared";
import { Ban, Check, Phone, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { assignRide, cancelRide, declineOffer } from "@/app/dashboard/rides/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { submitWith } from "@/lib/utils";

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
}: {
  booking: BookingActionTarget;
  /** Fiche du propriétaire (null : fiche supprimée, « Je la prends » impossible) */
  driverId: string | null;
  size?: "sm" | "md";
  /** Bouton « Appeler » (masqué quand le numéro est déjà affiché à côté) */
  call?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [dialog, setDialog] = useState<null | "decline" | "cancel">(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const label = `Réservation #${booking.number}`;

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string, description?: string) =>
    start(() => runAction(async () => {
      const res = await fn();
      if (!res.ok) return void toast.error(res.error ?? "Action impossible.");
      toast.success(success, description ? { description } : undefined);
      setDialog(null);
      router.refresh();
    }));

  const take = () => driverId && run(() => assignRide(booking.id, driverId), `${label} confirmée`, "Elle vous est attribuée.");
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
      {canCancel(booking.status) && (
        <Button
          variant="outline"
          size={size}
          disabled={pending}
          onClick={() => {
            setReasonError(null);
            setDialog("cancel");
          }}
        >
          <Ban /> Annuler
        </Button>
      )}
      {call && booking.customerPhone && (
        <Button asChild variant="ghost" size={size}>
          <a href={`tel:${booking.customerPhone}`} aria-label={`Appeler le client au ${formatPhone(booking.customerPhone)}`}>
            <Phone /> Appeler
          </a>
        </Button>
      )}

      <Dialog open={dialog === "decline"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent
          title={`Refuser la réservation #${booking.number}`}
          description="Elle passe « Refusée » tout de suite et votre site en est informé : prévenez votre client si besoin. Vous pourrez encore la prendre dans les 6 heures qui suivent l'heure prévue."
          size="sm"
        >
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Retour
            </Button>
            <Button variant="danger" loading={pending} onClick={decline}>
              Refuser la réservation
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "cancel"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent
          title={`Annuler la réservation #${booking.number}`}
          description="L'annulation est définitive ; votre site en est informé. Indiquez le motif (visible dans la chronologie)."
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
              <Textarea name="reason" maxLength={REASON_MAX} placeholder="Client injoignable, vol annulé…" />
            </Field>
            <div className="mt-6 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setDialog(null)}>
                Retour
              </Button>
              <Button type="submit" variant="danger" loading={pending}>
                Confirmer l&apos;annulation
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
