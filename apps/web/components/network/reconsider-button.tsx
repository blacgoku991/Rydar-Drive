"use client";
// Candidature refusée (par la centrale, ou d'office : appareil déjà utilisé par un chauffeur banni) :
// la centrale peut changer d'avis et valider le chauffeur (niveau « Nouveau »).
import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { approveApplication } from "@/app/dashboard/network/actions";
import { Button } from "@/components/ui/button";

export function ReconsiderButton({ driverId, name }: { driverId: string; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const reconsider = () => {
    if (!window.confirm(`Reconsidérer la candidature de ${name} ? Le chauffeur est validé au niveau « Nouveau » (courses plafonnées).`)) return;
    start(async () => {
      const res = await approveApplication(driverId, "new");
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${name} est validé.`);
      router.refresh();
    });
  };
  return (
    <Button variant="ghost" size="xs" loading={pending} onClick={reconsider} aria-label={`Reconsidérer la candidature de ${name}`}>
      <RotateCcw className="size-3.5" /> Reconsidérer
    </Button>
  );
}
