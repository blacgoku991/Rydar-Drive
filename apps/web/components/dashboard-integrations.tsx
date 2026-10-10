"use client";
// API & site web › Clés de connexion (docs/REFONTE-PANELS.md § 5.6, lot R10). Une clé relie le site du client à son
// compte : elle n'est affichée qu'une fois (seule son empreinte est gardée). Révoquer ou remplacer une clé coupe ou
// change l'accès du site : confirmation qui dit la conséquence (revokeApiKey, rotateApiKey inchangées). Clé révoquée
// ou expirée : texte lisible et badge (plus d'opacité réduite). Actions et contrôles inchangés (actions.ts).
import { API_SCOPE_LABELS, API_SCOPES, BROWSER_KEY_SCOPES, dateTimeFormat, formatRelative } from "@rydar/shared";
import { KeyRound, Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { createApiKey, revokeApiKey, rotateApiKey } from "@/app/dashboard/integrations/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { Field, Input, Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { useNow } from "@/hooks/use-now";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";

const NB = " ";

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

const SCOPE_LABELS: Record<string, string> = API_SCOPE_LABELS;

type KeyState = "active" | "expiring" | "expired" | "revoked";

function keyState(k: ApiKeyRow, now: number): KeyState {
  if (k.revoked_at) return "revoked";
  if (k.expires_at && Date.parse(k.expires_at) <= now) return "expired";
  return k.expires_at ? "expiring" : "active";
}

/** « 11 oct. 14:32 » (heure de Paris, formateur mémorisé). */
const shortDate = (iso: string) =>
  dateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(new Date(iso));

/** « monsite.fr, www.monsite.fr » (origines d'une clé navigateur, sans le protocole). */
const originsText = (origins: string[]) => origins.map((o) => o.replace(/^https?:\/\//, "")).join(", ");

export function ApiKeysPanel({ keys, canManage, serverNow }: { keys: ApiKeyRow[]; canManage: boolean; serverNow: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState<{ key: string; prefix: string; rotated: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "revoke" | "rotate"; key: ApiKeyRow } | null>(null);
  const [scopes, setScopes] = useState<string[]>(["rides:create", "rides:read"]);
  const [originsInput, setOriginsInput] = useState("");
  const scopesId = useId();
  // Clé « navigateur » (origines saisies) : visible par tout visiteur du site → création de courses et devis seulement
  const browserKey = originsInput.trim().length > 0;
  const effectiveScopes = browserKey ? [...BROWSER_KEY_SCOPES] : scopes;
  // Heure du rendu serveur, puis horloge du navigateur après le montage (aucun écart d'hydratation)
  const now = useNow(60_000) ?? serverNow;

  function create(form: FormData) {
    start(() =>
      runAction(async () => {
        const origins = String(form.get("origins") ?? "").split(/[\s,]+/).filter(Boolean);
        const res = await createApiKey({
          name: String(form.get("name") ?? ""),
          scopes: (origins.length ? [...BROWSER_KEY_SCOPES] : scopes) as never,
          rateLimitPerMinute: Number(form.get("rate") || 60),
          allowedOrigins: origins,
        });
        if (!res.ok) return void toast.error(res.error);
        setCreateOpen(false);
        setRevealed({ key: res.key, prefix: res.prefix, rotated: false });
        router.refresh();
      }),
    );
  }

  function confirmAction() {
    if (!confirm) return;
    const { kind, key } = confirm;
    start(() =>
      runAction(async () => {
        if (kind === "revoke") {
          const res = await revokeApiKey(key.id);
          if (!res.ok) return void toast.error(res.error);
          toast.success("Clé révoquée");
        } else {
          const res = await rotateApiKey(key.id);
          if (!res.ok) return void toast.error(res.error);
          setRevealed({ key: res.key, prefix: res.prefix, rotated: true });
        }
        setConfirm(null);
        router.refresh();
      }),
    );
  }

  // Clés utilisables d'abord, puis expirées et révoquées (les plus récentes en tête dans chaque groupe)
  const sorted = [...keys].sort((a, b) => {
    const rank = (k: ApiKeyRow) => (["active", "expiring"].includes(keyState(k, now)) ? 0 : 1);
    return rank(a) - rank(b);
  });

  return (
    <div className="space-y-3">
      {canManage && (
        <div className="flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)} className="max-sm:min-h-11 max-sm:w-full">
            <Plus aria-hidden /> Nouvelle clé
          </Button>
        </div>
      )}
      {keys.length === 0 ? (
        <div className="rounded-xl border border-line">
          <EmptyState
            size="compact"
            icon={<KeyRound />}
            title="Aucune clé."
            description={canManage ? "Créez-en une pour relier votre site, puis donnez-la à la personne qui gère votre site." : undefined}
          />
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {sorted.map((k) => {
            const state = keyState(k, now);
            const usable = state === "active" || state === "expiring";
            const browser = (k.allowed_origins ?? []).length > 0;
            // Clé « navigateur » : seules la création de courses et les devis sont acceptés par l'API, quelles que soient ses portées
            const shown = browser ? k.scopes.filter((s) => (BROWSER_KEY_SCOPES as readonly string[]).includes(s)) : k.scopes;
            return (
              <li key={k.id} className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-3.5">
                <div aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-white/[0.02]">
                  <KeyRound className={cn("size-4", usable ? "text-brand" : "text-fg-subtle")} />
                </div>
                <div className="min-w-0 flex-1 basis-[14rem] space-y-1.5">
                  <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-fg">
                    <span className="[overflow-wrap:anywhere]">{k.name}</span>
                    {state === "revoked" ? (
                      <Badge tone="neutral">Révoquée</Badge>
                    ) : state === "expired" ? (
                      <Badge tone="amber">Expirée</Badge>
                    ) : state === "expiring" ? (
                      <Badge tone="amber">Valable jusqu&apos;au {shortDate(k.expires_at!)}</Badge>
                    ) : (
                      <Badge tone="green">Active</Badge>
                    )}
                  </p>
                  <p className="text-[12.5px] text-fg-muted [overflow-wrap:anywhere]">
                    <span className="mono text-fg">
                      {k.prefix}_••••{k.last4}
                    </span>
                    {" · "}
                    {browser ? `Clé navigateur (${originsText(k.allowed_origins)})` : "Clé serveur"}
                  </p>
                  <ul className="flex flex-wrap gap-1" aria-label="Permissions">
                    {shown.map((s) => (
                      <li key={s} className="rounded-md border border-line bg-white/[0.03] px-1.5 py-0.5 text-[12px] text-fg-muted">
                        {SCOPE_LABELS[s] ?? s}
                      </li>
                    ))}
                  </ul>
                  <p className="text-[12.5px] text-fg-muted" suppressHydrationWarning>
                    {k.last_used_at ? `Utilisée ${formatRelative(k.last_used_at, new Date(now))}` : "Jamais utilisée"}
                    {` · ${k.rate_limit_per_minute}${NB}requêtes par minute au plus`}
                  </p>
                </div>
                {canManage && usable && (
                  <div className="flex shrink-0 flex-wrap gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setConfirm({ kind: "rotate", key: k })} className="max-sm:min-h-11" disabled={pending}>
                      <RefreshCw aria-hidden /> Remplacer
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirm({ kind: "revoke", key: k })}
                      className="text-red hover:text-red max-sm:min-h-11"
                      disabled={pending}
                    >
                      <Trash2 aria-hidden /> Révoquer
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Révoquer : la clé est refusée aussitôt (revokeApiKey) ; remplacer : nouvelle clé, l'ancienne valable 24 h au
          plus (rotateApiKey : expiration ramenée à 24 h, ou plus tôt si elle expirait déjà avant) */}
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title={confirm ? `${confirm.kind === "revoke" ? "Révoquer" : "Remplacer"} la clé «${NB}${confirm.key.name}${NB}»${NB}?` : ""}
        consequence={
          confirm?.kind === "revoke"
            ? `Les appels faits avec cette clé sont refusés aussitôt${NB}: si votre site l'utilise, il ne pourra plus envoyer de réservations.`
            : `Une nouvelle clé est créée et affichée une seule fois. L'ancienne reste valable 24${NB}h au plus${NB}: mettez votre site à jour avec la nouvelle.`
        }
        confirmLabel={confirm?.kind === "revoke" ? "Révoquer la clé" : "Remplacer la clé"}
        tone={confirm?.kind === "revoke" ? "danger" : "primary"}
        loading={pending}
        onConfirm={confirmAction}
      />

      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) setOriginsInput("");
        }}
      >
        <DialogContent title="Nouvelle clé" description={`Donnez-lui un nom qui dit où elle sert (ex.${NB}: «${NB}Site web${NB}», «${NB}WordPress${NB}»).`}>
          <form onSubmit={submitWith(create)} className="space-y-4">
            <Field label="Nom">
              <Input name="name" required maxLength={80} autoComplete="off" placeholder={`ex.${NB}: Site web — formulaire de réservation`} />
            </Field>
            <div role="group" aria-labelledby={`${scopesId}-label`} aria-describedby={`${scopesId}-hint`}>
              <p id={`${scopesId}-label`} className="mb-1.5 text-[12.5px] font-medium text-fg-muted">
                Permissions
              </p>
              <div className="flex flex-wrap gap-2">
                {API_SCOPES.map((s) => {
                  const on = effectiveScopes.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      disabled={browserKey}
                      aria-pressed={on}
                      onClick={() => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))}
                      className={cn(
                        "min-h-9 rounded-lg border px-3 text-[13px] disabled:cursor-not-allowed max-sm:min-h-11",
                        on ? "border-brand/50 bg-brand/[0.08] text-brand" : "border-line text-fg-muted hover:text-fg",
                      )}
                    >
                      {SCOPE_LABELS[s]}
                    </button>
                  );
                })}
              </div>
              <p id={`${scopesId}-hint`} className="mt-1.5 text-xs text-fg-subtle">
                {browserKey
                  ? "Clé utilisée depuis le navigateur : création de courses et devis uniquement."
                  : "« Webhooks » : votre serveur enregistre lui-même l'adresse qui reçoit les changements de statut des courses (POST /api/v1/webhooks)."}
              </p>
            </div>
            <Field
              label="Origines autorisées (CORS)"
              optional
              hint="Uniquement si le formulaire appelle l'API depuis le navigateur : la clé est alors visible par tout visiteur du site, elle ne peut que créer des courses et demander des devis (prix et paiement fixés par votre grille). Recommandé : appel serveur."
            >
              <Textarea
                name="origins"
                value={originsInput}
                onChange={(e) => setOriginsInput(e.target.value)}
                placeholder={`ex.${NB}: https://www.monsite.fr`}
                className="min-h-[60px]"
              />
            </Field>
            <Disclosure title="Options avancées" className="rounded-xl border border-line px-4" contentClassName="pb-4">
              <Field label="Limite de débit" hint="Requêtes par minute pour cette clé.">
                <Input name="rate" type="number" inputMode="numeric" min={1} max={10000} defaultValue={60} className="num sm:max-w-40" />
              </Field>
            </Disclosure>
            <DialogFooter backDisabled={pending}>
              <Button type="submit" variant="primary" loading={pending}>
                Générer la clé
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!revealed} onOpenChange={(o) => !o && setRevealed(null)}>
        <DialogContent
          title={revealed?.rotated ? "Votre nouvelle clé" : "Votre clé"}
          description={`Copiez-la maintenant${NB}: elle ne sera plus jamais affichée (seule une empreinte est conservée).`}
        >
          <div className="rounded-xl border border-brand/30 bg-brand/[0.05] p-4">
            <p className="mono break-all text-[13px] text-fg">{revealed?.key}</p>
          </div>
          <p className="mt-3 flex items-start gap-2 text-[12.5px] text-amber">
            <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" /> Ne l&apos;exposez jamais dans le code JavaScript public de votre site : appelez
            l&apos;API depuis votre serveur.
          </p>
          <DialogFooter hideBack>
            {revealed && <CopyButton value={revealed.key} label="Copier la clé" />}
            <Button variant="primary" onClick={() => setRevealed(null)}>
              J&apos;ai copié la clé
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
