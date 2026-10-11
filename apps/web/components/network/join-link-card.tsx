"use client";
// Pages Réseau (centrale) et Inscriptions (flotte) : lien d'inscription /rejoindre/{code} à partager dans les groupes
// WhatsApp / Telegram (textes selon le modèle de l'organisation : join-copy.ts). Interrupteurs avec une aide qui dit
// l'état courant ; « Régénérer le lien » sous « Options du lien » (confirmation : l'ancien lien cesse de fonctionner).
import type { DispatchModel } from "@rydar/shared";
import { ExternalLink, Link2, MessageCircle, RefreshCw, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { updateJoinLink, type JoinLinkState } from "@/app/dashboard/network/actions";
import { autoApproveHelp, joinMessage, joinShareText } from "@/components/network/join-copy";
import { joinUrl } from "@/components/network/labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { NewTabHint } from "@/components/ui/new-tab";
import { SwitchRow } from "@/components/ui/switch-row";
import { runAction } from "@/lib/run-action";

const NB = " ";

export function JoinLinkCard({
  orgName,
  initial,
  canManage,
  model,
}: {
  orgName: string;
  initial: JoinLinkState;
  canManage: boolean;
  /** Modèle de l'organisation : textes du message partagé et de la validation automatique */
  model: DispatchModel;
}) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<"enabled" | "auto" | "regen" | "create" | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setState(initial), [initial]);

  const url = state.join_code ? joinUrl(state.join_code) : null;
  const message = url ? joinMessage(orgName, url, model) : "";

  const save = (key: NonNullable<typeof busy>, input: Parameters<typeof updateJoinLink>[0], success: string) => {
    setBusy(key);
    start(() => runAction(async () => {
      const res = await updateJoinLink(input);
      setBusy(null);
      if (!res.ok) return void toast.error(res.error);
      setState({ join_code: res.join_code, join_enabled: res.join_enabled, join_auto_approve: res.join_auto_approve });
      setConfirm(false);
      toast.success(success);
      router.refresh();
    }));
  };

  return (
    <Card data-tour="join-link" className="overflow-hidden">
      <CardHeader
        title="Lien d'inscription"
        icon={<Link2 />}
        description={`Partagez-le dans vos groupes${NB}: chaque inscrit est rattaché à ${orgName}.`}
        action={url ? <Badge tone={state.join_enabled ? "green" : "neutral"}>{state.join_enabled ? "Actif" : "Coupé"}</Badge> : undefined}
      />
      {!url ? (
        <div className="space-y-4 px-5 py-5">
          <p className="text-[13px] leading-relaxed text-fg-muted">
            Aucun lien pour l&apos;instant. Une fois créé, les chauffeurs s&apos;inscrivent eux-mêmes (compte, véhicule, carte VTC) puis déposent leurs
            documents dans l&apos;application.
          </p>
          {canManage && (
            <Button variant="primary" loading={pending && busy === "create"} onClick={() => save("create", { enabled: true }, "Lien d'inscription créé")}>
              <Link2 /> Créer le lien d&apos;inscription
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4 p-4 sm:p-5">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line-strong bg-ink-850 py-1.5 pl-3 pr-1.5">
              <Link2 aria-hidden className="size-4 shrink-0 text-fg-muted" />
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="num relative min-w-0 flex-1 basis-40 truncate text-[13px] text-fg hover:text-brand"
                title={url}
              >
                {url.replace(/^https?:\/\//, "")}
                <NewTabHint />
              </a>
              <span className="flex shrink-0 items-center gap-1">
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="grid size-9 place-items-center rounded-md text-fg-muted hover:bg-white/5 hover:text-fg"
                  aria-label="Ouvrir la page d'inscription (nouvel onglet)"
                >
                  <ExternalLink className="size-4" />
                </a>
                <CopyButton value={url} label="Copier" what="le lien d'inscription" />
              </span>
            </div>
            {!state.join_enabled && <p className="text-[13px] text-amber">Lien coupé{NB}: la page affiche «{NB}Lien invalide ou désactivé{NB}».</p>}
          </div>

          <div className="rounded-xl border border-line bg-white/[0.02]">
            <p className="border-b border-line px-3.5 py-2 text-[13px] font-medium text-fg-muted">Message prêt à coller</p>
            <p className="px-3.5 py-3 text-[13px] leading-relaxed text-fg [overflow-wrap:anywhere]">{message}</p>
            <div className="flex flex-wrap gap-2 border-t border-line px-3.5 py-2.5">
              <CopyButton value={message} label="Copier le message" variant="primary" />
              <Button asChild size="sm" variant="outline">
                <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">
                  <MessageCircle /> WhatsApp
                  <NewTabHint />
                </a>
              </Button>
              <Button asChild size="sm" variant="outline">
                <a href={`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(joinShareText(orgName, model))}`} target="_blank" rel="noreferrer">
                  <Send /> Telegram
                  <NewTabHint />
                </a>
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <SwitchRow
              title="Lien actif"
              hintOn="Les chauffeurs peuvent s'inscrire avec ce lien."
              hintOff={`Lien coupé${NB}: plus personne ne peut s'inscrire avec ce lien.`}
              checked={state.join_enabled}
              disabled={!canManage || pending}
              onCheckedChange={(v) => save("enabled", { enabled: v }, v ? "Lien d'inscription activé" : "Lien d'inscription coupé")}
            />
            <SwitchRow
              title="Validation automatique des inscrits"
              hint={autoApproveHelp(model, state.join_auto_approve)}
              checked={state.join_auto_approve}
              disabled={!canManage || pending}
              onCheckedChange={(v) => save("auto", { autoApprove: v }, v ? "Validation automatique activée" : "Validation manuelle : vous validez chaque inscrit")}
            />
          </div>

          {canManage && (
            <Disclosure title="Options du lien" className="rounded-xl border border-line" summaryClassName="px-3.5" contentClassName="border-t border-line px-3.5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px] text-fg-muted">Lien diffusé trop largement{NB}? Remplacez-le par un nouveau lien.</p>
                <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
                  <RefreshCw /> Régénérer le lien
                </Button>
              </div>
            </Disclosure>
          )}
        </div>
      )}

      <Dialog open={confirm} onOpenChange={(o) => !pending && setConfirm(o)}>
        <DialogContent
          title={`Régénérer le lien d'inscription${NB}?`}
          description="Un nouveau lien est créé : l'ancien cesse immédiatement de fonctionner, y compris dans les messages déjà partagés."
        >
          <p className="text-[13px] text-fg-muted">Les chauffeurs déjà inscrits ne sont pas concernés. Pensez à partager le nouveau lien dans vos groupes.</p>
          <DialogFooter backDisabled={pending}>
            <Button variant="danger" loading={pending && busy === "regen"} onClick={() => save("regen", { regenerate: true }, "Nouveau lien créé : l'ancien ne fonctionne plus")}>
              <RefreshCw /> Régénérer le lien
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
