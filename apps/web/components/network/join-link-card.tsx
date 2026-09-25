"use client";
// Page Réseau : lien d'inscription /rejoindre/{code} à partager dans les groupes WhatsApp / Telegram.
import { Check, Copy, ExternalLink, Link2, MessageCircle, RefreshCw, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { updateJoinLink, type JoinLinkState } from "@/app/dashboard/network/actions";
import { joinMessage, joinUrl } from "@/components/network/labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

/** Copie dans le presse-papiers (repli execCommand hors contexte sécurisé). */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

function CopyButton({ text, label, done, className, variant = "secondary" }: { text: string; label: string; done: string; className?: string; variant?: "secondary" | "primary" | "outline" }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      className={className}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          toast.success(done);
        } else toast.error("Copie impossible : sélectionnez le texte manuellement.");
      }}
    >
      {copied ? <Check className="text-brand" /> : <Copy />} {copied ? "Copié" : label}
    </Button>
  );
}

export function JoinLinkCard({ orgName, initial, canManage }: { orgName: string; initial: JoinLinkState; canManage: boolean }) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<"enabled" | "auto" | "regen" | "create" | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setState(initial), [initial]);

  const url = state.join_code ? joinUrl(state.join_code) : null;
  const message = url ? joinMessage(orgName, url) : "";

  const save = (key: NonNullable<typeof busy>, input: Parameters<typeof updateJoinLink>[0], success: string) => {
    setBusy(key);
    start(async () => {
      const res = await updateJoinLink(input);
      setBusy(null);
      if (!res.ok) return void toast.error(res.error);
      setState({ join_code: res.join_code, join_enabled: res.join_enabled, join_auto_approve: res.join_auto_approve });
      setConfirm(false);
      toast.success(success);
      router.refresh();
    });
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Lien d'inscription"
        icon={<Link2 />}
        description={`Partagez-le dans vos groupes : chaque inscrit est rattaché à ${orgName}.`}
        action={url ? <Badge tone={state.join_enabled ? "green" : "neutral"} pulse={state.join_enabled}>{state.join_enabled ? "Actif" : "Coupé"}</Badge> : undefined}
      />
      {!url ? (
        <div className="space-y-4 px-5 py-6">
          <p className="text-[13px] leading-relaxed text-fg-muted">
            Aucun lien pour l&apos;instant. Une fois créé, les chauffeurs s&apos;inscrivent eux-mêmes (compte, véhicule, carte VTC) puis déposent leurs documents dans l&apos;application.
          </p>
          {canManage ? (
            <Button variant="primary" loading={pending && busy === "create"} onClick={() => save("create", { enabled: true }, "Lien d'inscription créé")}>
              <Link2 /> Créer le lien d&apos;inscription
            </Button>
          ) : (
            <p className="text-[12.5px] text-fg-subtle">Un administrateur de la centrale peut le créer.</p>
          )}
        </div>
      ) : (
        <div className="space-y-5 p-5">
          <div className={cn("space-y-2", !state.join_enabled && "opacity-60")}>
            <div className="flex items-center gap-2 rounded-xl border border-line-strong bg-ink-850 py-1.5 pl-3 pr-1.5">
              <Link2 className="size-4 shrink-0 text-brand" />
              <a href={url} target="_blank" rel="noreferrer" className="num min-w-0 flex-1 truncate text-[13px] text-fg hover:text-brand" title={url}>
                {url.replace(/^https?:\/\//, "")}
              </a>
              <a href={url} target="_blank" rel="noreferrer" className="grid size-8 shrink-0 place-items-center rounded-md text-fg-subtle hover:bg-white/5 hover:text-fg" aria-label="Ouvrir la page d'inscription">
                <ExternalLink className="size-4" />
              </a>
              <CopyButton text={url} label="Copier" done="Lien copié" />
            </div>
            {!state.join_enabled && <p className="text-[12px] text-amber">Lien coupé : la page affiche « Lien invalide ou désactivé ».</p>}
          </div>

          <div className="rounded-xl border border-line bg-white/[0.02]">
            <p className="border-b border-line px-3.5 py-2 text-[11.5px] font-medium uppercase tracking-[0.08em] text-fg-subtle">Message prêt à coller</p>
            <p className="px-3.5 py-3 text-[13px] leading-relaxed text-fg [overflow-wrap:anywhere]">{message}</p>
            <div className="flex flex-wrap gap-2 border-t border-line px-3.5 py-2.5">
              <CopyButton text={message} label="Copier le message" done="Message copié : collez-le dans votre groupe" variant="primary" />
              <Button asChild size="sm" variant="outline">
                <a href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">
                  <MessageCircle /> WhatsApp
                </a>
              </Button>
              <Button asChild size="sm" variant="outline">
                <a href={`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(`Rejoignez le réseau ${orgName} sur Rydar Drive`)}`} target="_blank" rel="noreferrer">
                  <Send /> Telegram
                </a>
              </Button>
            </div>
          </div>

          <div className="divide-y divide-line rounded-xl border border-line">
            <label className="flex cursor-pointer items-center justify-between gap-4 px-3.5 py-3">
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">Lien actif</span>
                <span className="block text-[12px] text-fg-subtle">Coupé, plus personne ne peut s&apos;inscrire avec ce lien.</span>
              </span>
              <Switch
                checked={state.join_enabled}
                disabled={!canManage || pending}
                aria-label="Lien actif"
                onCheckedChange={(v) => save("enabled", { enabled: v }, v ? "Lien d'inscription activé" : "Lien d'inscription coupé")}
              />
            </label>
            <label className="flex cursor-pointer items-center justify-between gap-4 px-3.5 py-3">
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">Validation automatique des inscrits</span>
                <span className="block text-[12px] text-fg-subtle">
                  {state.join_auto_approve ? "Actifs dès l'inscription, au niveau « Nouveau » (courses plafonnées)." : "Chaque inscrit attend votre validation ci-contre."}
                </span>
              </span>
              <Switch
                checked={state.join_auto_approve}
                disabled={!canManage || pending}
                aria-label="Validation automatique des inscrits"
                onCheckedChange={(v) => save("auto", { autoApprove: v }, v ? "Validation automatique activée" : "Validation manuelle : vous validez chaque inscrit")}
              />
            </label>
          </div>

          {canManage ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12px] text-fg-subtle">Lien diffusé trop largement ? Remplacez-le.</p>
              <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
                <RefreshCw /> Régénérer le lien
              </Button>
            </div>
          ) : (
            <p className="text-[12px] text-fg-subtle">Réglages du lien réservés aux administrateurs de la centrale.</p>
          )}
        </div>
      )}

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent title="Régénérer le lien d'inscription ?" description="Un nouveau lien est créé : l'ancien cesse immédiatement de fonctionner, y compris dans les messages déjà partagés.">
          <p className="text-[13px] text-fg-muted">Les chauffeurs déjà inscrits ne sont pas concernés. Pensez à partager le nouveau lien dans vos groupes.</p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(false)}>Annuler</Button>
            <Button variant="danger" loading={pending && busy === "regen"} onClick={() => save("regen", { regenerate: true }, "Nouveau lien créé : l'ancien ne fonctionne plus")}>
              <RefreshCw /> Régénérer
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
