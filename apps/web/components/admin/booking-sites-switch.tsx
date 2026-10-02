"use client";
// Super admin (Offres & limites) : interrupteur plateforme des mini-sites de réservation, avec confirmation.
import { Globe } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setBookingSitesEnabled } from "@/app/admin/plans/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { runAction } from "@/lib/run-action";

/** `updatedLabel` : date du dernier changement, mise en forme côté serveur (aucun écart d'hydratation). */
export function BookingSitesSwitchCard({ enabled, configured, updatedLabel }: { enabled: boolean; configured: number | null; updatedLabel: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const next = !enabled;

  const apply = () =>
    start(() => runAction(async () => {
      const res = await setBookingSitesEnabled(next);
      if (!res.ok) return void toast.error(res.error);
      setConfirm(false);
      toast.success(res.enabled ? "Mini-sites réactivés" : "Mini-sites désactivés");
      router.refresh();
    }));

  const sites = configured == null ? null : `${configured} centrale${configured > 1 ? "s" : ""}`;
  return (
    <Card className="mb-6">
      <CardHeader
        icon={<Globe />}
        title="Mini-sites de réservation"
        description="Interrupteur de toute la plateforme, quelle que soit l'offre de chaque centrale."
        action={<Badge tone={enabled ? "green" : "amber"}>{enabled ? "Activés" : "Désactivés"}</Badge>}
      />
      <CardBody className="flex flex-wrap items-center justify-between gap-4">
        <div className="max-w-2xl space-y-1 text-[13px] text-fg-muted">
          {enabled ? (
            <p>
              Les centrales et flottes dont l&apos;offre inclut le mini-site le gèrent depuis leur tableau de bord (menu « Mini-site »)
              {sites ? <>. Mini-site en ligne chez <span className="num text-fg">{sites}</span>.</> : "."}
            </p>
          ) : (
            <p>
              Menu « Mini-site » masqué partout, pages de réservation, sous-domaines et domaines personnalisés hors ligne. Les
              réglages de chaque centrale sont conservés{sites ? <> (mini-site activé chez <span className="num text-fg">{sites}</span>)</> : null}
              {" "}et reviennent tels quels à la réactivation.
            </p>
          )}
          {updatedLabel && <p className="text-[12px] text-fg-subtle">Dernier changement {updatedLabel}</p>}
        </div>
        <Button variant={enabled ? "danger" : "primary"} onClick={() => setConfirm(true)} disabled={pending}>
          {enabled ? "Désactiver les mini-sites" : "Réactiver les mini-sites"}
        </Button>
      </CardBody>

      <Dialog open={confirm} onOpenChange={(open) => !pending && setConfirm(open)}>
        <DialogContent
          size="sm"
          title={enabled ? "Désactiver tous les mini-sites ?" : "Réactiver les mini-sites ?"}
          description={
            enabled
              ? "Toutes les centrales et flottes sont concernées, immédiatement."
              : "Chaque mini-site revient tel que sa centrale l'avait laissé."
          }
        >
          <ul className="space-y-2 text-[13px] text-fg-muted">
            {enabled ? (
              <>
                <li className="flex gap-2"><span className="text-amber">•</span> Pages de réservation, sous-domaines et domaines personnalisés hors ligne.</li>
                <li className="flex gap-2"><span className="text-amber">•</span> Menu « Mini-site » retiré des tableaux de bord, réglages figés.</li>
                <li className="flex gap-2"><span className="text-amber">•</span> Réglages conservés&nbsp;; tableau de bord, API et app chauffeur inchangés.</li>
              </>
            ) : (
              <>
                <li className="flex gap-2"><span className="text-brand">•</span> Menu « Mini-site » de retour dans les tableaux de bord.</li>
                <li className="flex gap-2"><span className="text-brand">•</span> Mini-sites activés par leur centrale de nouveau en ligne (sous-domaines en moins d&apos;une minute).</li>
                <li className="flex gap-2"><span className="text-brand">•</span> L&apos;offre de chaque centrale s&apos;applique toujours.</li>
              </>
            )}
          </ul>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" disabled={pending} onClick={() => setConfirm(false)}>Annuler</Button>
            <Button variant={enabled ? "danger" : "primary"} loading={pending} onClick={apply}>
              {enabled ? "Désactiver" : "Réactiver"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
