"use client";
import {
  formatRelative,
  formatRideDate,
  WEBHOOK_DELIVERY_STATUS_META,
  WEBHOOK_EVENT_META,
  WEBHOOK_EVENTS,
  WEBHOOK_MAX_ENDPOINTS,
  webhookEventLabel,
  webhookUrlProblem,
  type WebhookDeliveryStatus,
  type WebhookEndpoint,
  type WebhookEvent,
} from "@rydar/shared";
import { Plus, RotateCcwKey, Send, ShieldAlert, Trash2, Webhook } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  createWebhook,
  deleteWebhook,
  redeliverWebhook,
  rotateWebhookSecret,
  setWebhookEnabled,
  testWebhook,
} from "@/app/dashboard/integrations/actions";
import { CopyButton } from "@/components/dashboard-integrations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/misc";
import { useNow } from "@/hooks/use-now";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";

/** Envoi lu par RLS (owner / admin) : aucune charge utile n'est conservée, seulement l'état de l'envoi. */
export type WebhookDeliveryRow = {
  id: string;
  endpoint_id: string;
  ride_id: string | null;
  ride_number: number | null;
  event_type: string;
  occurred_at: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  next_attempt_at: string;
  last_status_code: number | null;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
};

const NB = String.fromCharCode(0xa0); // espace insécable (avant : ; ! ? et dans « »)
const DEFAULT_EVENTS: WebhookEvent[] = ["ride.accepted", "ride.driver_arrived", "ride.completed", "ride.cancelled", "ride.no_driver_found"];

function hostOf(url: string | undefined) {
  if (!url) return "adresse supprimée";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Tentatives d'envoi : `attempts` ne compte que les échecs (un succès ne le change pas), la réussie est ajoutée. */
function deliveryTries(d: Pick<WebhookDeliveryRow, "attempts" | "status">): number {
  return d.attempts + (d.status === "delivered" ? 1 : 0);
}

/**
 * « Succès il y a 3 min · Échec il y a 2 h » : la dernière erreur n'est montrée que si l'échec est le plus récent.
 * `now` : heure du rendu serveur, puis horloge du navigateur après le montage (aucun écart d'hydratation).
 */
function health(e: WebhookEndpoint, now: Date) {
  const parts: string[] = [];
  if (e.last_success_at) parts.push(`Dernier succès ${formatRelative(e.last_success_at, now)}`);
  if (e.last_failure_at) parts.push(`dernier échec ${formatRelative(e.last_failure_at, now)}`);
  if (!parts.length) return { text: "Aucun envoi pour le moment", error: null };
  const failing = !!e.last_failure_at && (!e.last_success_at || Date.parse(e.last_failure_at) > Date.parse(e.last_success_at));
  const text = parts.join(" · ");
  return { text: text.charAt(0).toUpperCase() + text.slice(1), error: failing ? e.last_error : null };
}

/**
 * Webhooks de la centrale (owner / admin) : `canManage` = l'offre inclut l'API (ajout, réactivation, test, nouvel
 * envoi) ; désactiver, supprimer ou changer le secret reste toujours possible. `deliveries` : derniers envois de
 * CHAQUE adresse, plus ses échecs et nouveaux essais plus anciens (« Renvoyer » toujours accessible), affichés adresse
 * par adresse. `serverNow` : heure du rendu serveur (temps relatifs identiques au serveur et à l'hydratation).
 */
export function WebhooksPanel({
  endpoints,
  deliveries,
  canManage,
  timezone,
  serverNow,
}: {
  endpoints: WebhookEndpoint[];
  deliveries: WebhookDeliveryRow[];
  canManage: boolean;
  timezone: string;
  serverNow: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [urlError, setUrlError] = useState<string | undefined>();
  const [allEvents, setAllEvents] = useState(true);
  const [events, setEvents] = useState<WebhookEvent[]>(DEFAULT_EVENTS);
  const [revealed, setRevealed] = useState<{ secret: string; url: string; rotated: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "delete" | "rotate"; endpoint: WebhookEndpoint } | null>(null);
  const full = endpoints.length >= WEBHOOK_MAX_ENDPOINTS;
  const urls = new Map(endpoints.map((e) => [e.id, e.url]));
  const loading = (key: string) => pending && busy === key;
  const now = new Date(useNow(30_000) ?? serverNow);
  /** Envois regroupés par adresse (dans l'ordre des adresses), du plus récent au plus ancien. */
  const groups = useMemo(() => {
    const byEndpoint = new Map<string, WebhookDeliveryRow[]>();
    for (const d of deliveries) {
      const rows = byEndpoint.get(d.endpoint_id);
      if (rows) rows.push(d);
      else byEndpoint.set(d.endpoint_id, [d]);
    }
    return endpoints
      .map((endpoint) => ({
        endpoint,
        rows: [...(byEndpoint.get(endpoint.id) ?? [])].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
      }))
      .filter((g) => g.rows.length > 0);
  }, [endpoints, deliveries]);

  /** Action serveur : bouton concerné en chargement ; `fn` renvoie un message d'erreur (toast) ou rien (page rafraîchie). */
  function run(key: string, fn: () => Promise<string | void>) {
    setBusy(key);
    start(() =>
      runAction(async () => {
        const error = await fn();
        if (error) toast.error(error);
        else router.refresh();
      }),
    );
  }

  function create(form: FormData) {
    const url = String(form.get("url") ?? "").trim();
    const problem = webhookUrlProblem(url);
    if (problem) return setUrlError(problem);
    setUrlError(undefined);
    if (!allEvents && !events.length) return void toast.error(`Choisissez au moins un événement, ou «${NB}Tous les événements${NB}».`);
    run("create", async () => {
      const res = await createWebhook({ url, description: String(form.get("description") ?? ""), events: allEvents ? [] : events });
      if (!res.ok) return res.error;
      setCreateOpen(false);
      if (res.created && res.secret) setRevealed({ secret: res.secret, url, rotated: false });
      else toast.success(`Adresse déjà enregistrée${NB}: réglages mis à jour et webhook réactivé, secret inchangé.`);
    });
  }

  function confirmAction() {
    if (!confirm) return;
    const { kind, endpoint } = confirm;
    run(`${kind}:${endpoint.id}`, async () => {
      if (kind === "delete") {
        const res = await deleteWebhook(endpoint.id);
        if (!res.ok) return res.error;
        toast.success("Webhook supprimé");
      } else {
        const res = await rotateWebhookSecret(endpoint.id);
        if (!res.ok) return res.error;
        setRevealed({ secret: res.secret, url: endpoint.url, rotated: true });
      }
      setConfirm(null);
    });
  }

  const toggleEvent = (ev: WebhookEvent) => setEvents((cur) => (cur.includes(ev) ? cur.filter((x) => x !== ev) : [...cur, ev]));

  function renderDelivery(d: WebhookDeliveryRow) {
    const meta = WEBHOOK_DELIVERY_STATUS_META[d.status] ?? { label: d.status, tone: "neutral" as const };
    const retry = d.status === "delivered" || d.status === "failed";
    const tries = deliveryTries(d);
    return (
      <div key={d.id} className="px-4 py-2.5 text-[12.5px]">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="num w-32 shrink-0 text-fg-subtle">{formatRideDate(d.occurred_at, timezone)}</span>
          <div className="min-w-[180px] flex-1">
            <p className="text-fg">
              {webhookEventLabel(d.event_type)}
              {d.ride_number != null && <span className="text-fg-muted"> · course n°&nbsp;{d.ride_number}</span>}
            </p>
            <p className="mono truncate text-[11.5px] text-fg-subtle">{d.event_type}</p>
          </div>
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <span className="num w-12 text-right text-fg-muted" title="Code HTTP de la dernière réponse">
            {d.last_status_code ?? "—"}
          </span>
          <span className="num w-20 text-right text-fg-muted" title="Tentatives d'envoi, réussie comprise">
            {tries}&nbsp;essai{tries > 1 ? "s" : ""}
          </span>
          <div className="flex w-40 justify-end text-right text-fg-muted">
            {d.status === "pending" ? (
              d.attempts > 0 ? `Nouvel essai ${formatRelative(d.next_attempt_at, now)}` : "En file d'envoi"
            ) : d.status === "sending" ? (
              "Envoi en cours"
            ) : retry && canManage && urls.has(d.endpoint_id) ? (
              <Button
                variant="outline"
                size="xs"
                loading={loading(`redeliver:${d.id}`)}
                onClick={() =>
                  run(`redeliver:${d.id}`, async () => {
                    const res = await redeliverWebhook(d.id);
                    if (!res.ok) return res.error;
                    toast.success("Nouvel envoi programmé");
                  })
                }
              >
                Renvoyer
              </Button>
            ) : d.delivered_at ? (
              formatRelative(d.delivered_at, now)
            ) : null}
          </div>
        </div>
        {d.last_error && d.status !== "delivered" && <p className="mono mt-1 truncate text-[11.5px] text-fg-muted">{d.last_error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-[12.5px] text-fg-muted">
          Votre serveur reçoit une requête POST signée (HMAC-SHA256) à chaque étape d&apos;une course&nbsp;: création, chauffeur attribué,
          arrivée, fin, annulation… En cas d&apos;échec, nouveaux essais automatiques pendant près de 2&nbsp;jours.
        </p>
        {canManage && (
          <Button
            variant="primary"
            size="sm"
            disabled={full}
            title={full ? `${WEBHOOK_MAX_ENDPOINTS} adresses au plus` : undefined}
            onClick={() => {
              setUrlError(undefined);
              setCreateOpen(true);
            }}
          >
            <Plus /> Nouvelle adresse
          </Button>
        )}
      </div>

      <div className="divide-y divide-line rounded-xl border border-line">
        {endpoints.length === 0 && (
          <div className="flex items-center gap-3 px-4 py-6 text-[13px] text-fg-subtle">
            <Webhook className="size-4 shrink-0" /> Aucune adresse. Ajoutez celle de votre serveur pour suivre vos courses en direct.
          </div>
        )}
        {endpoints.map((e) => {
          const h = health(e, now);
          return (
            <div key={e.id} className="flex flex-wrap items-start gap-4 px-4 py-3.5">
              <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-white/[0.02]">
                <Webhook className={cn("size-4", e.enabled ? "text-brand" : "text-fg-subtle")} />
              </div>
              <div className="min-w-[220px] flex-1 space-y-1.5">
                <p className="mono break-all text-[13px] text-fg">{e.url}</p>
                {e.description && <p className="text-[12.5px] text-fg-muted">{e.description}</p>}
                <div className="flex flex-wrap gap-1">
                  {(e.events.length ? e.events.map((ev) => WEBHOOK_EVENT_META[ev]?.label ?? ev) : ["Tous les événements"]).map((label) => (
                    <span key={label} className="rounded-md border border-line bg-white/[0.03] px-1.5 py-0.5 text-[11px] text-fg-muted">
                      {label}
                    </span>
                  ))}
                </div>
                <p className="text-[12px] text-fg-muted">{h.text}</p>
                {h.error && <p className="mono break-all text-[11.5px] text-red">{h.error}</p>}
                {!e.enabled && e.disabled_reason && <p className="text-[12px] text-amber">{e.disabled_reason}</p>}
              </div>
              <Badge tone={e.enabled ? "green" : "neutral"}>{e.enabled ? "Actif" : "Désactivé"}</Badge>
              <div className="flex items-center gap-1">
                <Switch
                  checked={e.enabled}
                  disabled={pending || (!e.enabled && !canManage)}
                  aria-label={e.enabled ? "Désactiver le webhook" : "Réactiver le webhook"}
                  title={e.enabled ? "Désactiver" : "Réactiver"}
                  onCheckedChange={(enabled) =>
                    run(`toggle:${e.id}`, async () => {
                      const res = await setWebhookEnabled(e.id, enabled);
                      if (!res.ok) return res.error;
                      toast.success(enabled ? "Webhook réactivé" : "Webhook désactivé");
                    })
                  }
                  className="mr-2"
                />
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Envoyer un test"
                    title={e.enabled ? `Envoyer un test (événement «${NB}ping${NB}»)` : "Réactivez le webhook pour l'essayer"}
                    disabled={!e.enabled}
                    loading={loading(`ping:${e.id}`)}
                    onClick={() =>
                      run(`ping:${e.id}`, async () => {
                        const res = await testWebhook(e.id);
                        if (!res.ok) return res.error;
                        toast.success(`Test envoyé${NB}: résultat dans «${NB}Derniers envois${NB}» d'ici quelques secondes.`);
                      })
                    }
                  >
                    <Send />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Nouveau secret"
                  title="Nouveau secret de signature"
                  onClick={() => setConfirm({ kind: "rotate", endpoint: e })}
                >
                  <RotateCcwKey />
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label="Supprimer" title="Supprimer" onClick={() => setConfirm({ kind: "delete", endpoint: e })}>
                  <Trash2 className="text-red" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="space-y-2">
        <p className="text-[12.5px] font-medium text-fg-muted">
          Derniers envois <span className="font-normal text-fg-subtle">· par adresse, échecs plus anciens compris</span>
        </p>
        <div className="divide-y divide-line/70 rounded-xl border border-line">
          {groups.length === 0 && (
            <p className="px-4 py-5 text-[13px] text-fg-subtle">
              Aucun envoi pour le moment. Le bouton d&apos;essai envoie un événement «&nbsp;ping&nbsp;» à l&apos;adresse choisie.
            </p>
          )}
          {groups.map(({ endpoint, rows }) => {
            const failed = rows.filter((d) => d.status === "failed").length;
            return (
              <Fragment key={endpoint.id}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-white/[0.02] px-4 py-2 text-[12px]">
                  <Webhook className={cn("size-3.5 shrink-0", endpoint.enabled ? "text-brand" : "text-fg-subtle")} />
                  <span className="mono min-w-0 flex-1 truncate text-fg">{hostOf(endpoint.url)}</span>
                  {failed > 0 && <span className="text-red">{failed}&nbsp;en échec</span>}
                </div>
                {rows.map((d) => renderDelivery(d))}
              </Fragment>
            );
          })}
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent
          title="Nouvelle adresse de webhook"
          description={`Adresse https publique de votre serveur${NB}: elle reçoit les événements en POST, signés avec un secret propre à cette adresse.`}
        >
          <form onSubmit={submitWith(create)} className="space-y-4">
            <Field label="Adresse" error={urlError}>
              <Input
                name="url"
                type="url"
                required
                maxLength={500}
                inputMode="url"
                aria-invalid={!!urlError}
                placeholder="https://www.mon-site.fr/api/rydar/webhook"
                className="mono"
                onChange={() => urlError && setUrlError(undefined)}
              />
            </Field>
            <Field label="Description" optional>
              <Input name="description" maxLength={120} placeholder="Site de réservation" />
            </Field>
            <Field
              label="Événements"
              hint={allEvents ? "Les événements ajoutés plus tard seront aussi envoyés." : "Seuls les événements cochés sont envoyés."}
            >
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setAllEvents((v) => !v)}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-[12.5px]",
                    allEvents ? "border-brand/50 bg-brand/[0.08] text-brand" : "border-line text-fg-muted",
                  )}
                >
                  Tous les événements
                </button>
                {WEBHOOK_EVENTS.map((ev) => (
                  <button
                    key={ev}
                    type="button"
                    disabled={allEvents}
                    title={WEBHOOK_EVENT_META[ev].description}
                    onClick={() => toggleEvent(ev)}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-[12.5px] disabled:cursor-not-allowed disabled:opacity-60",
                      !allEvents && events.includes(ev) ? "border-brand/50 bg-brand/[0.08] text-brand" : "border-line text-fg-muted",
                    )}
                  >
                    {WEBHOOK_EVENT_META[ev].label}
                  </button>
                ))}
              </div>
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
                Annuler
              </Button>
              <Button type="submit" variant="primary" loading={loading("create")}>
                Ajouter
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent
          size="sm"
          title={confirm?.kind === "delete" ? `Supprimer ce webhook${NB}?` : `Remplacer le secret${NB}?`}
          description={
            confirm?.kind === "delete"
              ? `Votre serveur ne recevra plus aucun événement à cette adresse${NB}; les envois en attente sont abandonnés.`
              : `L'ancien secret cesse aussitôt de signer${NB}: mettez à jour votre serveur avec le nouveau, affiché une seule fois.`
          }
        >
          <p className="mono break-all rounded-lg border border-line bg-white/[0.02] px-3 py-2 text-[12.5px] text-fg">{confirm?.endpoint.url}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Annuler
            </Button>
            <Button
              variant={confirm?.kind === "delete" ? "danger" : "primary"}
              loading={!!confirm && loading(`${confirm.kind}:${confirm.endpoint.id}`)}
              onClick={confirmAction}
            >
              {confirm?.kind === "delete" ? "Supprimer" : "Générer un nouveau secret"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!revealed} onOpenChange={(o) => !o && setRevealed(null)}>
        <DialogContent
          title={revealed?.rotated ? "Nouveau secret de signature" : "Secret de signature"}
          description={`Copiez-le maintenant${NB}: il ne sera plus jamais affiché. Votre serveur s'en sert pour vérifier l'en-tête X-Rydar-Signature de chaque envoi.`}
        >
          <p className="mono mb-2 break-all text-[12px] text-fg-subtle">{revealed?.url}</p>
          <div className="rounded-xl border border-brand/30 bg-brand/[0.05] p-4">
            <p className="mono break-all text-[13px] text-fg">{revealed?.secret}</p>
          </div>
          <div className="mt-3 flex items-start gap-2 text-[12px] text-amber">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" /> Gardez-le côté serveur (variable d&apos;environnement)&nbsp;: quiconque le connaît peut fabriquer de faux événements.
          </div>
          <div className="mt-5 flex justify-end gap-2">
            {revealed && <CopyButton value={revealed.secret} label="Copier le secret" />}
            <Button variant="primary" onClick={() => setRevealed(null)}>
              J&apos;ai copié le secret
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
