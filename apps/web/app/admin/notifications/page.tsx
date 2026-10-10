import { formatDate, formatNumber, formatRelative, formatTime } from "@rydar/shared";
import { ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import { notificationLine } from "@/components/admin/org-watch";
import { SupervisionTabs } from "@/components/admin/supervision-tabs";
import { PageBody, PageHeader, StatCard } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { PAGE_SIZE, Pagination, pageBounds } from "@/components/ui/pagination";
import { requireSuperAdmin } from "@/lib/auth";
import { plural } from "@/lib/wording";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

type Note = {
  id: string;
  organization_id: string;
  type: string;
  title: string;
  body: string;
  status: string;
  attempts: number;
  last_error: string | null;
  provider: string | null;
  created_at: string;
  sent_at: string | null;
  driver: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null;
};

const COLUMNS =
  "id, organization_id, type, title, body, status, attempts, last_error, provider, created_at, sent_at, driver:drivers!notifications_organization_id_driver_id_fkey(first_name, last_name)";
const dateTime = (d: string) => `${formatDate(d)} à ${formatTime(d)}`;

/**
 * Supervision › Notifications (docs/REFONTE-PANELS.md, R6) : notifications envoyées sur les téléphones des chauffeurs
 * pendant les dernières 24 heures. Statuts et erreurs en français ; le code brut (type, erreur, service d'envoi) reste
 * dans le détail replié de chaque ligne. 50 lignes par page, lignes empilées sur téléphone.
 */
export default async function AdminNotificationsPage({ searchParams }: { searchParams: Promise<{ page?: string | string[] }> }) {
  const session = await requireSuperAdmin();
  const sp = await searchParams;
  const db = session.supabase;
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  // Comptages exacts côté base (head) : lire les lignes serait tronqué à max_rows (1 000) au-delà de 1 000 envois / 24 h
  const statusCount = (status: "sent" | "queued" | "sending" | "failed" | "cancelled") =>
    db.from("notifications").select("id", { count: "exact", head: true }).eq("status", status).gte("created_at", since);
  const list = (page: number) =>
    db
      .from("notifications")
      .select(COLUMNS)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  const [all, sent, queued, sending, failed, cancelled, { data: orgs }] = await Promise.all([
    db.from("notifications").select("id", { count: "exact", head: true }).gte("created_at", since),
    statusCount("sent"),
    statusCount("queued"),
    statusCount("sending"),
    statusCount("failed"),
    statusCount("cancelled"),
    db.from("organizations").select("id, name"),
  ]);
  const total = all.error ? null : (all.count ?? 0);
  // Page demandée (`?page=`) ramenée dans les bornes : une adresse ancienne au-delà de la dernière page montre la dernière
  const { page, pages } = pageBounds(total, Array.isArray(sp.page) ? sp.page[0] : sp.page, PAGE_SIZE);
  const rows = await list(page);
  const notes = (rows.data ?? []) as Note[];

  const name = new Map(((orgs ?? []) as { id: string; name: string }[]).map((o) => [o.id, o.name]));
  /** Nombre exact, ou null si le comptage a échoué (affiché « — », jamais un faux 0). */
  const n = (r: { count: number | null; error: unknown }) => (r.error ? null : (r.count ?? 0));
  const inQueue = n(queued) === null || n(sending) === null ? null : n(queued)! + n(sending)!;
  const failures = n(failed);
  return (
    <>
      <PageHeader title="Notifications" description="Notifications envoyées sur les téléphones des chauffeurs (24 dernières heures).">
        <SupervisionTabs current="notifications" />
      </PageHeader>
      <PageBody className="space-y-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Envoyées" value={n(sent) === null ? "—" : formatNumber(n(sent)!)} />
          <StatCard label="En attente d'envoi" value={inQueue === null ? "—" : formatNumber(inQueue)} sub="rappels programmés compris" />
          <StatCard label="Échecs" value={failures === null ? "—" : formatNumber(failures)} tone={failures ? "red" : undefined} />
          <StatCard label="Annulées" value={n(cancelled) === null ? "—" : formatNumber(n(cancelled)!)} sub="course prise par un autre chauffeur" />
        </div>
        <Card className="overflow-hidden">
          <CardHeader
            title="Dernières notifications"
            description={
              total === null
                ? "Ouvrez une ligne pour voir son détail technique."
                : `${plural(total, "notification")} en 24 heures. Ouvrez une ligne pour voir son détail technique.`
            }
          />
          {rows.error ? (
            <CardBody className="text-[13px] text-fg-muted">Lecture impossible, réessayez dans un instant.</CardBody>
          ) : notes.length === 0 ? (
            <EmptyState size="compact" title="Aucune notification." description="Rien n'a été envoyé aux chauffeurs ces dernières 24 heures." />
          ) : (
            <ul className="divide-y divide-line">
              {notes.map((note) => {
                const line = notificationLine(note);
                const driver = Array.isArray(note.driver) ? note.driver[0] : note.driver;
                const who = [name.get(note.organization_id) ?? "Client inconnu", driver ? `${driver.first_name} ${driver.last_name}`.trim() : null].filter(Boolean).join(" · ");
                return (
                  <li key={note.id}>
                    <details className="group">
                      <summary className="flex cursor-pointer list-none items-start gap-3 px-5 py-3 transition-colors hover:bg-white/[0.025] focus-visible:outline-offset-[-2px] [&::-webkit-details-marker]:hidden md:grid md:grid-cols-[16px_minmax(0,1fr)_minmax(0,180px)_96px_auto] md:items-center md:gap-4">
                        <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-subtle transition-transform group-open:rotate-90 md:mt-0" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-start justify-between gap-3">
                            <span className="min-w-0 truncate text-[13px] font-medium text-fg">{note.title}</span>
                            <span className="shrink-0 md:hidden">
                              <Badge tone={line.status.tone}>{line.status.label}</Badge>
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-[12.5px] text-fg-muted">{line.reason ?? note.body}</span>
                          <span className="mt-0.5 block truncate text-[12px] text-fg-muted md:hidden">
                            {who} · {formatRelative(note.created_at)}
                          </span>
                        </span>
                        <span className="hidden min-w-0 truncate text-[12.5px] text-fg-muted md:block" title={who}>
                          {who}
                        </span>
                        <span className="hidden whitespace-nowrap text-[12.5px] text-fg-muted md:block" title={dateTime(note.created_at)}>
                          {formatRelative(note.created_at)}
                        </span>
                        <span className="hidden md:block">
                          <Badge tone={line.status.tone}>{line.status.label}</Badge>
                        </span>
                      </summary>
                      <dl className="mx-5 mb-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-lg border border-line bg-white/[0.02] px-4 py-3 text-[12px] md:ml-[52px]">
                        <dt className="text-fg-muted">Code technique</dt>
                        <dd className="mono text-fg [overflow-wrap:anywhere]">{line.code}</dd>
                        <dt className="text-fg-muted">Essais</dt>
                        <dd className="num text-fg">{formatNumber(note.attempts)}</dd>
                        {note.provider && (
                          <>
                            <dt className="text-fg-muted">Service d&apos;envoi</dt>
                            <dd className="mono text-fg">{note.provider}</dd>
                          </>
                        )}
                        <dt className="text-fg-muted">Créée le</dt>
                        <dd className="num text-fg">{dateTime(note.created_at)}</dd>
                        {note.sent_at && (
                          <>
                            <dt className="text-fg-muted">Envoyée le</dt>
                            <dd className="num text-fg">{dateTime(note.sent_at)}</dd>
                          </>
                        )}
                        <dt className="text-fg-muted">Message</dt>
                        <dd className="text-fg [overflow-wrap:anywhere]">{note.body}</dd>
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
          noun="notifications"
          label="Pages des notifications"
          href={(p) => (p <= 1 ? "/admin/notifications" : `/admin/notifications?page=${p}`)}
        />
      </PageBody>
    </>
  );
}
