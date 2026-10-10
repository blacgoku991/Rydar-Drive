"use client";
// Candidature refusée (par l'organisation, ou d'office : appareil déjà utilisé par un chauffeur banni) :
// l'organisation peut changer d'avis et valider le chauffeur (centrale : niveau « Nouveau » ; flotte : « confirmé »),
// après une confirmation qui dit la conséquence.
import type { DispatchModel } from "@rydar/shared";
import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { approveApplication } from "@/app/dashboard/network/actions";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { runAction } from "@/lib/run-action";

const NB = " ";

export function ReconsiderButton({ driverId, name, model }: { driverId: string; name: string; model: DispatchModel }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const fleet = model !== "centrale";
  const reconsider = () =>
    start(() => runAction(async () => {
      const res = await approveApplication(driverId, fleet ? "trusted" : "new");
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${name} est validé.`);
      setOpen(false);
      router.refresh();
    }));
  return (
    <>
      <Button variant="ghost" size="xs" loading={pending} onClick={() => setOpen(true)} aria-label={`Reconsidérer la candidature de ${name}`}>
        <RotateCcw className="size-3.5" /> Reconsidérer
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(o) => !pending && setOpen(o)}
        tone="primary"
        title={`Reconsidérer la candidature de ${name}${NB}?`}
        consequence={
          fleet
            ? "Le chauffeur est validé et reçoit vos courses."
            : `Le chauffeur est validé au niveau «${NB}Nouveau${NB}» (courses plafonnées).`
        }
        confirmLabel="Valider le chauffeur"
        loading={pending}
        onConfirm={reconsider}
      />
    </>
  );
}
