"use client";
// Candidature refusée (par l'organisation, ou d'office : appareil déjà utilisé par un chauffeur banni) :
// l'organisation peut changer d'avis et valider le chauffeur (centrale : niveau « Nouveau » ; flotte : « confirmé »).
import type { DispatchModel } from "@rydar/shared";
import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { approveApplication } from "@/app/dashboard/network/actions";
import { Button } from "@/components/ui/button";
import { runAction } from "@/lib/run-action";

export function ReconsiderButton({ driverId, name, model }: { driverId: string; name: string; model: DispatchModel }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const fleet = model !== "centrale";
  const reconsider = () => {
    const question = fleet
      ? `Reconsidérer la candidature de ${name} ? Le chauffeur est validé et reçoit vos courses.`
      : `Reconsidérer la candidature de ${name} ? Le chauffeur est validé au niveau « Nouveau » (courses plafonnées).`;
    if (!window.confirm(question)) return;
    start(() => runAction(async () => {
      const res = await approveApplication(driverId, fleet ? "trusted" : "new");
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${name} est validé.`);
      router.refresh();
    }));
  };
  return (
    <Button variant="ghost" size="xs" loading={pending} onClick={reconsider} aria-label={`Reconsidérer la candidature de ${name}`}>
      <RotateCcw className="size-3.5" /> Reconsidérer
    </Button>
  );
}
