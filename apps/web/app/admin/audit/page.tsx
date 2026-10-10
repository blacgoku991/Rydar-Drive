import { formatDate, formatRelative, formatTime } from "@rydar/shared";
import { ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SupervisionTabs } from "@/components/admin/supervision-tabs";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { FilterTabs } from "@/components/ui/filter-tabs";
import { Field, NativeSelect } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { PAGE_SIZE, Pagination, pageBounds } from "@/components/ui/pagination";
import { requireSuperAdmin } from "@/lib/auth";
import {
  AUDIT_ALERT_SEVERITIES,
  AUDIT_PEOPLE_FILTER,
  AUDIT_VIEWS,
  auditActionLabel,
  auditActorLabel,
  auditSeverity,
  auditViewOf,
  plural,
  type AuditView,
} from "@/lib/wording";

export const metadata: Metadata = { title: "Sécurité & audit" };
export const dynamic = "force-dynamic";

type Row = {
  id: number;
  organization_id: string | null;
  actor_type: string;
  actor_user_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  severity: string;
  ip: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};
type SearchParams = { severity?: string | string[]; vue?: string | string[]; client?: string | string[]; page?: string | string[] };

const COLUMNS = "id, organization_id, actor_type, actor_user_id, action, entity_type, entity_id, severity, ip, metadata, created_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Filtre « client » : un client, ou les actions sans client (plateforme). */
const PLATFORM = "plateforme";
/** Métadonnées affichées dans le détail d'une ligne, au plus (une ligne d'audit peut porter un objet volumineux). */
const METADATA_MAX = 2000;

const dateTime = (d: string) => `${formatDate(d)} à ${formatTime(d)}`;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Adresse d'une vue, du filtre client et d'une page (paramètres vides omis). */
function auditHref(view: AuditView, client: string | null, page = 1): string {
  const qs = new URLSearchParams();
  if (view === "security") qs.set("severity", "security");
  if (view === "all") qs.set("vue", "tout");
  if (client) qs.set("client", client);
  if (page > 1) qs.set("page", String(page));
  const query = qs.toString();
  return query ? `/admin/audit?${query}` : "/admin/audit";
}

/**
 * Supervision › Sécurité & audit (docs/REFONTE-PANELS.md, R6). Vue par défaut « Actions des personnes » : tout sauf
 * les écritures automatiques du système de gravité « Info » ; une alerte (Attention, Critique) n'est jamais masquée.
 * Vues « Alertes de sécurité » (?severity=security, clé existante) et « Tout (détail technique) » (?vue=tout), filtre
 * par client (?client=), 50 lignes par page. Gravité, auteur et action en français ; IP, élément et métadonnées dans
 * le détail replié de chaque ligne.
 */
export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await requireSuperAdmin();
  const sp = await searchParams;
  const view = auditViewOf({ severity: first(sp.severity), vue: first(sp.vue) });
  const rawClient = first(sp.client) ?? "";
  const client = rawClient === PLATFORM || UUID.test(rawClient) ? rawClient : null;
  const db = session.supabase;

  /** Lignes de la vue et du client demandés (mêmes filtres pour le comptage et pour la page). */
  const scoped = (columns: string, head = false) => {
    let q = head ? db.from("audit_logs").select(columns, { count: "exact", head: true }) : db.from("audit_logs").select(columns);
    if (view === "security") q = q.in("severity", [...AUDIT_ALERT_SEVERITIES]);
    if (view === "people") q = q.or(AUDIT_PEOPLE_FILTER);
    if (client === PLATFORM) q = q.is("organization_id", null);
    else if (client) q = q.eq("organization_id", client);
    return q;
  };
  const [countRes, { data: orgData }] = await Promise.all([scoped("id", true), db.from("organizations").select("id, name").order("name")]);
  const total = countRes.error ? null : (countRes.count ?? 0);
  // Page demandée (`?page=`) ramenée dans les bornes : une adresse ancienne au-delà de la dernière page montre la dernière
  const { page, pages } = pageBounds(total, first(sp.page), PAGE_SIZE);
  const res = await scoped(COLUMNS)
    .order("id", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  const logs = (res.data ?? []) as unknown as Row[];

  const orgs = (orgData ?? []) as { id: string; name: string }[];
  const name = new Map(orgs.map((o) => [o.id, o.name]));
  // Comptes des auteurs (nom ou e-mail) : affichés dans le détail de la ligne
  const actorIds = [...new Set(logs.map((l) => l.actor_user_id).filter((id): id is string => !!id))];
  const { data: actorData } = actorIds.length ? await db.from("users").select("id, full_name, email").in("id", actorIds) : { data: [] };
  const actor = new Map(((actorData ?? []) as { id: string; full_name: string | null; email: string }[]).map((u) => [u.id, u.full_name || u.email]));
  const clientLabel = (id: string | null) => (id ? (name.get(id) ?? "Client supprimé") : "Plateforme");
  const clientName = client === PLATFORM ? "Plateforme" : client ? (name.get(client) ?? "Client supprimé") : null;

  return (
    <>
      <PageHeader title="Sécurité & audit" description={"Actions sensibles tracées\u00a0: créations, suspensions, clés du site, accès refusés."}>
        <SupervisionTabs current="audit" />
      </PageHeader>
      <PageBody className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 space-y-1.5">
            <FilterTabs
              wrap
              label="Vues du journal"
              items={(["people", "security", "all"] as const).map((v) => ({ href: auditHref(v, client), label: AUDIT_VIEWS[v], active: v === view }))}
            />
            {view === "people" && (
              <p className="text-[12.5px] text-fg-muted">
                Écritures automatiques du système de gravité «{"\u00a0"}Info{"\u00a0"}» masquées{"\u00a0"}; les alertes restent toujours visibles.
              </p>
            )}
          </div>
          {/* Filtre par client : formulaire GET vers la page (la vue est gardée, la page revient à 1) */}
          <form action="/admin/audit" method="get" className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
            {view === "security" && <input type="hidden" name="severity" value="security" />}
            {view === "all" && <input type="hidden" name="vue" value="tout" />}
            <Field label="Client" className="min-w-0 flex-1 sm:w-64 sm:flex-none">
              <NativeSelect name="client" defaultValue={client ?? ""}>
                <option value="">Tous les clients</option>
                <option value={PLATFORM}>Plateforme (sans client)</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Button type="submit" variant="secondary" className="h-10">
              Afficher
            </Button>
            {client && (
              <Link href={auditHref(view, null)} prefetch={false} className="inline-flex h-10 items-center rounded-lg px-2 text-[13px] text-fg-muted hover:text-fg">
                Tous les clients
              </Link>
            )}
          </form>
        </div>

        <Card className="overflow-hidden">
          {res.error ? (
            <CardBody className="text-[13px] text-fg-muted">Lecture impossible, réessayez dans un instant.</CardBody>
          ) : logs.length === 0 ? (
            <EmptyState
              size="compact"
              title={`Aucune ligne dans «\u00a0${AUDIT_VIEWS[view]}\u00a0»${clientName ? ` pour ${clientName}` : ""}.`}
              action={
                view !== "all" || client ? (
                  <Link href={auditHref("all", null)} prefetch={false} className="inline-flex min-h-11 items-center text-[13px] font-medium text-brand hover:underline sm:min-h-0">
                    Voir tout le journal
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <ul className="divide-y divide-line" aria-label="Journal d'audit">
              {logs.map((l) => {
                const severity = auditSeverity(l.severity);
                const alert = l.severity === "warning" || l.severity === "critical";
                const author = auditActorLabel(l.actor_type);
                const account = l.actor_user_id ? actor.get(l.actor_user_id) : undefined;
                const meta = l.metadata && Object.keys(l.metadata).length ? JSON.stringify(l.metadata, null, 2) : null;
                return (
                  <li key={l.id}>
                    <details className="group">
                      <summary className="flex cursor-pointer list-none items-start gap-3 px-5 py-3 transition-colors hover:bg-white/[0.025] focus-visible:outline-offset-[-2px] [&::-webkit-details-marker]:hidden md:grid md:grid-cols-[16px_96px_84px_minmax(0,1fr)_minmax(0,180px)_110px] md:items-center md:gap-4">
                        <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-subtle transition-transform group-open:rotate-90 md:mt-0" />
                        {/* Téléphone : action et gravité, puis « heure · client · auteur » ; bureau : en colonnes */}
                        <span className="hidden whitespace-nowrap text-[12.5px] text-fg-muted md:block" title={dateTime(l.created_at)}>
                          {formatRelative(l.created_at)}
                        </span>
                        <span className="hidden md:block">
                          {alert ? <Badge tone={severity.tone}>{severity.label}</Badge> : <span className="text-[12.5px] text-fg-muted">{severity.label}</span>}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-start justify-between gap-3">
                            <span className="min-w-0 text-[13px] text-fg [overflow-wrap:anywhere]">{auditActionLabel(l.action)}</span>
                            {alert && (
                              <span className="shrink-0 md:hidden">
                                <Badge tone={severity.tone}>{severity.label}</Badge>
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-[12px] text-fg-muted md:hidden">
                            {formatRelative(l.created_at)} · {clientLabel(l.organization_id)} · {author}
                          </span>
                        </span>
                        <span className="hidden min-w-0 truncate text-[12.5px] text-fg-muted md:block" title={clientLabel(l.organization_id)}>
                          {clientLabel(l.organization_id)}
                        </span>
                        <span className="hidden truncate text-right text-[12.5px] text-fg-muted md:block">{author}</span>
                      </summary>
                      <dl className="mx-5 mb-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg border border-line bg-white/[0.02] px-4 py-3 text-[12px] md:ml-[52px]">
                        <dt className="text-fg-muted">Date</dt>
                        <dd className="num text-fg">{dateTime(l.created_at)}</dd>
                        <dt className="text-fg-muted">Gravité</dt>
                        <dd className="text-fg">{severity.label}</dd>
                        <dt className="text-fg-muted">Auteur</dt>
                        <dd className="text-fg [overflow-wrap:anywhere]">
                          {author}
                          {account ? ` · ${account}` : ""}
                        </dd>
                        <dt className="text-fg-muted">Code</dt>
                        <dd className="mono text-fg [overflow-wrap:anywhere]">{l.action}</dd>
                        {l.entity_type && (
                          <>
                            <dt className="text-fg-muted">Élément</dt>
                            <dd className="mono text-fg [overflow-wrap:anywhere]">
                              {l.entity_type}
                              {l.entity_id ? ` · ${l.entity_id}` : ""}
                            </dd>
                          </>
                        )}
                        <dt className="text-fg-muted">Adresse IP</dt>
                        <dd className="mono text-fg">{l.ip ?? "—"}</dd>
                        {l.organization_id && (
                          <>
                            <dt className="text-fg-muted">Client</dt>
                            <dd className="text-fg">
                              <Link href={auditHref(view, l.organization_id)} prefetch={false} className="text-brand hover:underline">
                                Voir le journal de {clientLabel(l.organization_id)}
                              </Link>
                            </dd>
                          </>
                        )}
                        {meta && (
                          <>
                            <dt className="text-fg-muted">Détails</dt>
                            <dd className="min-w-0">
                              <pre className="mono whitespace-pre-wrap text-[12px] text-fg [overflow-wrap:anywhere]">
                                {meta.length > METADATA_MAX ? `${meta.slice(0, METADATA_MAX)}…` : meta}
                              </pre>
                            </dd>
                          </>
                        )}
                      </dl>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Pagination
          page={page}
          pages={pages}
          total={total}
          noun="lignes"
          label="Pages du journal"
          href={(p) => auditHref(view, client, p)}
        />
        {total !== null && total > 0 && pages <= 1 && <p className="text-[12.5px] text-fg-muted">{plural(total, "ligne")}.</p>}
      </PageBody>
    </>
  );
}
