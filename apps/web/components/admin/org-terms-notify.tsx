"use client";
// Super admin (/admin/legal) : « Prévenir par e-mail » les propriétaires des clients qui n'ont pas accepté les
// CGV et l'accord de traitement en vigueur (svc_org_terms_notify : contenu fixe mis en file email_outbox, une seule
// annonce par organisation et par version, journal d'audit en base). Le web n'envoie aucun e-mail lui-même.
import { ORG_LEGAL_EFFECTIVE_AT, ORG_LEGAL_VERSION, legalDateLabel } from "@rydar/shared";
import { Mail } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { notifyOrgTerms } from "@/app/admin/legal/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { runAction } from "@/lib/run-action";

/**
 * `shortNotice` : annoncée aujourd'hui, la version laisserait moins de 30 jours avant ORG_LEGAL_EFFECTIVE_AT (CGV
 * art. 16 ; même règle que svc_org_terms_notify, qui refuse l'envoi : TERMS_NOTICE_TOO_SHORT) — bouton désactivé : la
 * date se repousse dans @rydar/shared, puis redéploiement.
 */
export function OrgTermsNotifyButton({
  toNotify,
  effectivePassed,
  shortNotice = false,
}: {
  toNotify: number;
  effectivePassed: boolean;
  shortNotice?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const version = legalDateLabel(ORG_LEGAL_VERSION);
  const limit = legalDateLabel(ORG_LEGAL_EFFECTIVE_AT);
  const n = toNotify;

  const send = () =>
    start(() => runAction(async () => {
      const res = await notifyOrgTerms();
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.organizations > 0 ? "Annonce des CGV mise en file d'envoi" : "Aucun client à prévenir", {
        description: res.message,
        duration: 10_000,
      });
      setOpen(false);
      router.refresh();
    }));

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={effectivePassed || shortNotice || n === 0}
        title={
          effectivePassed
            ? `Entrée en vigueur atteinte (${limit})\u00a0: l'annonce n'est plus envoyée`
            : shortNotice
              ? `Moins de 30 jours avant le ${limit}\u00a0: la date d'entrée en vigueur doit d'abord être repoussée`
              : n === 0
                ? "Tous les clients en attente ont déjà été prévenus"
                : undefined
        }
      >
        <Mail /> Prévenir par e-mail
      </Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent
          title={"Prévenir par e-mail\u00a0?"}
          description={`Annonce des CGV et de l'accord de traitement du ${version} aux propriétaires de ${n} client${n > 1 ? "s" : ""} qui ne les ont pas acceptés et n'${n > 1 ? "ont" : "a"} pas encore été prévenu${n > 1 ? "s" : ""}.`}
        >
          <ul className="space-y-2 text-[13px] text-fg-muted">
            <li className="flex gap-2">
              <span aria-hidden className="text-brand">•</span>
              <span>
                Contenu fixe{"\u00a0"}: les principaux changements (ceux en défaveur du client compris), la date d&apos;application (au plus tard
                le {limit} pour un client existant, c&apos;est-à-dire créé avant la première annonce de cette version ou qui avait accepté une
                version antérieure, avec résiliation sans frais avant et remboursement au prorata), et les liens vers le tableau de bord et les
                CGV.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="text-brand">•</span>
              <span>
                Une seule annonce par client et par version{"\u00a0"}: un nouveau clic ne prévient que les clients pas encore prévenus. Sans
                annonce ni acceptation, aucune hausse de leurs frais par course ne peut être annoncée (seulement sur accord écrit).
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="text-brand">•</span>
              <span>
                Envoi par la file des e-mails{"\u00a0"}: suivi dans Supervision › E-mails. Un client sans adresse valide n&apos;est pas noté et
                pourra être prévenu plus tard.
              </span>
            </li>
          </ul>
          <DialogFooter backDisabled={pending}>
            <Button type="button" variant="primary" loading={pending} onClick={send}>
              <Mail /> Envoyer l&apos;annonce
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
