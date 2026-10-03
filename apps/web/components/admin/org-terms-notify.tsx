"use client";
// Super admin (/admin/legal) : « Prévenir par e-mail » les propriétaires des organisations qui n'ont pas accepté les
// CGV et l'accord de traitement en vigueur (svc_org_terms_notify : contenu fixe mis en file email_outbox, une seule
// annonce par organisation et par version, journal d'audit en base). Le web n'envoie aucun e-mail lui-même.
import { ORG_LEGAL_EFFECTIVE_AT, ORG_LEGAL_VERSION, legalDateLabel } from "@rydar/shared";
import { Mail } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { notifyOrgTerms } from "@/app/admin/legal/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { runAction } from "@/lib/run-action";

/**
 * `shortNotice` : moins de 30 jours avant ORG_LEGAL_EFFECTIVE_AT (CGV art. 16) — l'envoi reste possible, avec un
 * avertissement dans la confirmation (la date se repousse dans @rydar/shared, puis redéploiement).
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
      toast.success(res.organizations > 0 ? "Annonce des CGV mise en file d'envoi" : "Aucune organisation à prévenir", {
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
        disabled={effectivePassed || n === 0}
        title={
          effectivePassed
            ? `Entrée en vigueur atteinte (${limit})\u00a0: l'annonce n'est plus envoyée`
            : n === 0
              ? "Toutes les organisations en attente ont déjà été prévenues"
              : undefined
        }
      >
        <Mail /> Prévenir par e-mail
      </Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent
          title="Prévenir par e-mail ?"
          description={`Annonce des CGV et de l'accord de traitement du ${version} aux propriétaires de ${n} organisation${n > 1 ? "s" : ""} qui ne les ont pas acceptés et n'ont pas encore été prévenue${n > 1 ? "s" : ""}.`}
        >
          <ul className="space-y-2 text-[13px] text-fg-muted">
            {shortNotice && (
              <li className="flex gap-2 text-amber">
                <span>•</span>
                <span>
                  Moins de 30 jours avant le {limit}{" "}: l&apos;article 16 des CGV demande d&apos;annoncer une modification
                  défavorable au moins 30 jours avant son entrée en vigueur. Repoussez d&apos;abord la date (ORG_LEGAL_EFFECTIVE_AT).
                </span>
              </li>
            )}
            <li className="flex gap-2">
              <span className="text-brand">•</span>
              <span>
                Contenu fixe{" "}: ce qui change (frais par course possibles pour les flottes comme pour les centrales, en plus de l&apos;abonnement{" "};
                toute hausse annoncée au moins 30{" "}jours à l&apos;avance), la date d&apos;application (au plus tard le {limit} pour une organisation
                déjà cliente, c&apos;est-à-dire créée avant la version ou qui avait accepté une version antérieure, avec résiliation
                sans frais avant), et les liens vers le tableau de bord et les CGV.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-brand">•</span>
              <span>Une seule annonce par organisation et par version{" "}: un nouveau clic ne prévient que les organisations pas encore prévenues.</span>
            </li>
            <li className="flex gap-2">
              <span className="text-brand">•</span>
              <span>
                Envoi par la file des e-mails (service mailer)
                {" "}: suivi dans «{" "}Contacts{" "}». Une organisation sans adresse valide n&apos;est pas notée et pourra être prévenue plus tard.
              </span>
            </li>
          </ul>
          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="button" variant="primary" loading={pending} onClick={send}>
              <Mail /> Envoyer l&apos;annonce
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
