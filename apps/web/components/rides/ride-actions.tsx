"use client";
import { PRESENCE_META, formatDistance, type DriverPresence } from "@rydar/shared";
import { Ban, RotateCcw, UserCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { assignRide, cancelRide, redispatchRide } from "@/app/dashboard/rides/actions";
import { PRESENCE_COLOR } from "@/components/map/map-theme";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type AssignableDriver = {
  id: string;
  name: string;
  number: number;
  presence: DriverPresence;
  vehicle: string;
  distance_m: number | null;
};

export function RideActions({
  rideId,
  number,
  canCancel,
  canRedispatch,
  canAssign,
  drivers,
}: {
  rideId: string;
  number: number;
  canCancel: boolean;
  canRedispatch: boolean;
  canAssign: boolean;
  drivers: AssignableDriver[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [picked, setPicked] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string, after?: () => void) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error ?? "Action impossible");
      else {
        toast.success(success);
        after?.();
        router.refresh();
      }
    });

  return (
    <>
      {canRedispatch && (
        <Button variant="secondary" disabled={pending} onClick={() => run(() => redispatchRide(rideId), "Dispatch relancé")}>
          <RotateCcw /> Relancer le dispatch
        </Button>
      )}
      {canAssign && (
        <Button variant="secondary" disabled={pending} onClick={() => setAssignOpen(true)}>
          <UserCheck /> Attribuer
        </Button>
      )}
      {canCancel && (
        <Button variant="danger" disabled={pending} onClick={() => setCancelOpen(true)}>
          <Ban /> Annuler
        </Button>
      )}

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent title={`Annuler la course #${number}`} description="Les offres en cours sont fermées et le chauffeur éventuellement attribué est prévenu.">
          <Field label="Motif" optional>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Client injoignable, vol annulé…" />
          </Field>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCancelOpen(false)}>Retour</Button>
            <Button variant="danger" loading={pending} onClick={() => run(() => cancelRide(rideId, reason), "Course annulée", () => setCancelOpen(false))}>
              Confirmer l&apos;annulation
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent title="Attribution manuelle" description="Le chauffeur reçoit immédiatement une notification. Les offres en cours sont fermées." size="lg">
          <div className="max-h-[50vh] space-y-1 overflow-y-auto rounded-xl border border-line p-1.5">
            {drivers.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => setPicked(d.id)}
                className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left", picked === d.id ? "bg-brand/10 ring-1 ring-brand/40" : "hover:bg-white/[0.04]")}
              >
                <span className="size-2 rounded-full" style={{ background: PRESENCE_COLOR[d.presence] }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">
                    {d.name} <span className="num text-fg-subtle">#{d.number}</span>
                  </span>
                  <span className="block truncate text-[12px] text-fg-subtle">{d.vehicle}</span>
                </span>
                <span className="text-[12px] text-fg-muted">{PRESENCE_META[d.presence].label}</span>
                <span className="num w-16 text-right text-[12px] text-fg-muted">{d.distance_m != null ? formatDistance(d.distance_m) : "—"}</span>
              </button>
            ))}
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAssignOpen(false)}>Annuler</Button>
            <Button
              variant="primary"
              disabled={!picked}
              loading={pending}
              onClick={() => picked && run(() => assignRide(rideId, picked), "Course attribuée", () => setAssignOpen(false))}
            >
              Attribuer la course
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
