"use client";
import { API_SCOPES, formatRelative } from "@rydar/shared";
import { Check, Copy, KeyRound, Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createApiKey, revokeApiKey, rotateApiKey } from "@/app/dashboard/integrations/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { cn, submitWith } from "@/lib/utils";

export type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  scopes: string[];
  rate_limit_per_minute: number;
  allowed_origins: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

const SCOPE_LABELS: Record<string, string> = {
  "rides:create": "Créer des courses",
  "rides:read": "Lire le statut",
  "rides:cancel": "Annuler",
};

export function CopyButton({ value, label = "Copier" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="text-brand" /> : <Copy />} {done ? "Copié" : label}
    </Button>
  );
}

export function ApiKeysPanel({ keys, canManage }: { keys: ApiKeyRow[]; canManage: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState<{ key: string; prefix: string } | null>(null);
  const [scopes, setScopes] = useState<string[]>(["rides:create", "rides:read"]);

  function create(form: FormData) {
    start(async () => {
      const origins = String(form.get("origins") ?? "").split(/[\s,]+/).filter(Boolean);
      const res = await createApiKey({
        name: String(form.get("name") ?? ""),
        scopes: scopes as never,
        rateLimitPerMinute: Number(form.get("rate") || 60),
        allowedOrigins: origins,
      });
      if (!res.ok) return void toast.error(res.error);
      setCreateOpen(false);
      setRevealed({ key: res.key, prefix: res.prefix });
      router.refresh();
    });
  }

  const now = Date.now();
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] text-fg-muted">La clé identifie votre organisation : chaque course reçue entre uniquement dans votre espace.</p>
        {canManage && (
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus /> Nouvelle clé
          </Button>
        )}
      </div>
      <div className="divide-y divide-line rounded-xl border border-line">
        {keys.length === 0 && (
          <div className="flex items-center gap-3 px-4 py-6 text-[13px] text-fg-subtle">
            <KeyRound className="size-4" /> Aucune clé. Créez-en une pour connecter votre site.
          </div>
        )}
        {keys.map((k) => {
          const expired = k.expires_at && new Date(k.expires_at).getTime() < now;
          const state = k.revoked_at ? "revoked" : expired ? "expired" : "active";
          return (
            <div key={k.id} className={cn("flex flex-wrap items-center gap-4 px-4 py-3.5", state !== "active" && "opacity-55")}>
              <div className="grid size-9 place-items-center rounded-lg border border-line bg-white/[0.02]">
                <KeyRound className={cn("size-4", state === "active" ? "text-brand" : "text-fg-subtle")} />
              </div>
              <div className="min-w-[200px] flex-1">
                <p className="text-[13.5px] font-medium">{k.name}</p>
                <p className="mono text-[12px] text-fg-subtle">
                  {k.prefix}_••••{k.last4}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                {k.scopes.map((s) => (
                  <span key={s} className="rounded-md border border-line bg-white/[0.03] px-1.5 py-0.5 text-[11px] text-fg-muted">
                    {SCOPE_LABELS[s] ?? s}
                  </span>
                ))}
              </div>
              <div className="w-32 text-right text-[12px] text-fg-subtle">
                <span className="num text-fg-muted">{k.rate_limit_per_minute}</span> req/min
                <br />
                {k.last_used_at ? `utilisée ${formatRelative(k.last_used_at)}` : "jamais utilisée"}
              </div>
              <Badge tone={state === "active" ? "green" : state === "expired" ? "amber" : "neutral"}>
                {state === "active" ? (k.expires_at ? "Active · expire" : "Active") : state === "expired" ? "Expirée" : "Révoquée"}
              </Badge>
              {canManage && state === "active" && (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Rotation"
                    title="Rotation (l'ancienne clé reste valide 24 h)"
                    onClick={() =>
                      start(async () => {
                        const res = await rotateApiKey(k.id);
                        if (!res.ok) return void toast.error(res.error);
                        setRevealed({ key: res.key, prefix: res.prefix });
                        router.refresh();
                      })
                    }
                  >
                    <RefreshCw />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Révoquer"
                    title="Révoquer immédiatement"
                    onClick={() =>
                      start(async () => {
                        const res = await revokeApiKey(k.id);
                        if (!res.ok) return void toast.error(res.error);
                        toast.success("Clé révoquée");
                        router.refresh();
                      })
                    }
                  >
                    <Trash2 className="text-red" />
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent title="Nouvelle clé API" description="Donnez-lui un nom explicite (ex. « Site web », « WordPress »).">
          <form onSubmit={submitWith(create)} className="space-y-4">
            <Field label="Nom">
              <Input name="name" required placeholder="Site web — formulaire de réservation" />
            </Field>
            <Field label="Permissions">
              <div className="flex flex-wrap gap-2">
                {API_SCOPES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))}
                    className={cn("rounded-lg border px-3 py-1.5 text-[12.5px]", scopes.includes(s) ? "border-brand/50 bg-brand/[0.08] text-brand" : "border-line text-fg-muted")}
                  >
                    {SCOPE_LABELS[s]}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Limite de débit" hint="Requêtes par minute pour cette clé.">
              <Input name="rate" type="number" min={1} max={10000} defaultValue={60} className="num" />
            </Field>
            <Field label="Origines autorisées (CORS)" optional hint="Uniquement si le formulaire appelle l'API depuis le navigateur. Recommandé : appel serveur.">
              <Textarea name="origins" placeholder="https://www.ma-centrale.fr" className="min-h-[60px]" />
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>Annuler</Button>
              <Button type="submit" variant="primary" loading={pending}>Générer la clé</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!revealed} onOpenChange={(o) => !o && setRevealed(null)}>
        <DialogContent title="Votre clé API" description="Copiez-la maintenant : elle ne sera plus jamais affichée (seul un hash est conservé).">
          <div className="rounded-xl border border-brand/30 bg-brand/[0.05] p-4">
            <p className="mono break-all text-[13px] text-fg">{revealed?.key}</p>
          </div>
          <div className="mt-3 flex items-start gap-2 text-[12px] text-amber">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" /> Ne l&apos;exposez jamais dans le code JavaScript public de votre site : appelez l&apos;API depuis votre serveur.
          </div>
          <div className="mt-5 flex justify-end gap-2">
            {revealed && <CopyButton value={revealed.key} label="Copier la clé" />}
            <Button variant="primary" onClick={() => setRevealed(null)}>J&apos;ai copié la clé</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
