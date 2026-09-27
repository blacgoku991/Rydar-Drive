import { formatRelative } from "@rydar/shared";
import type { Metadata } from "next";
import { PageBody, PageHeader, StatCard } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { requireSuperAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

export default async function AdminNotificationsPage() {
  const session = await requireSuperAdmin();
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  // Comptages exacts côté base (head) : lire les lignes serait tronqué à max_rows (1 000) au-delà de 1 000 envois / 24 h
  const statusCount = (status: "sent" | "queued" | "sending" | "failed" | "cancelled") =>
    session.supabase.from("notifications").select("id", { count: "exact", head: true }).eq("status", status).gte("created_at", since);
  const [{ data: recent }, sent, queued, sending, failed, cancelled, { data: orgs }] = await Promise.all([
    session.supabase.from("notifications").select("id, organization_id, type, title, body, status, attempts, last_error, provider, created_at, sent_at").order("created_at", { ascending: false }).limit(120),
    statusCount("sent"),
    statusCount("queued"),
    statusCount("sending"),
    statusCount("failed"),
    statusCount("cancelled"),
    session.supabase.from("organizations").select("id, name"),
  ]);
  const name = new Map((orgs ?? []).map((o) => [o.id, o.name]));
  /** Nombre exact, ou null si le comptage a échoué (affiché « — », jamais un faux 0). */
  const n = (r: { count: number | null; error: unknown }) => (r.error ? null : (r.count ?? 0));
  const inQueue = n(queued) === null || n(sending) === null ? null : n(queued)! + n(sending)!;
  const failures = n(failed);
  return (
    <>
      <PageHeader eyebrow="Supervision" title="Notifications push" description="File d'envoi (outbox transactionnelle) livrée par le worker : Expo / FCM / APNs." />
      <PageBody className="space-y-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Envoyées 24 h" value={n(sent) ?? "—"} tone="brand" />
          <StatCard label="En file" value={inQueue ?? "—"} tone="amber" />
          <StatCard label="Échecs 24 h" value={failures ?? "—"} tone={failures !== 0 ? "red" : undefined} />
          <StatCard label="Annulées" value={n(cancelled) ?? "—"} sub="course prise par un autre" />
        </div>
        <Card className="overflow-hidden">
          <CardHeader title="Dernières notifications" />
          <div className="divide-y divide-line">
            {(recent ?? []).map((n) => (
              <div key={n.id} className="grid grid-cols-[1fr_160px_110px_90px] items-center gap-4 px-5 py-2.5 text-[12.5px]">
                <span className="min-w-0"><span className="block truncate font-medium">{n.title}</span><span className="block truncate text-fg-subtle">{n.last_error ?? n.body}</span></span>
                <span className="truncate text-fg-muted">{name.get(n.organization_id)}</span>
                <span className="text-fg-subtle">{formatRelative(n.created_at)}</span>
                <Badge tone={n.status === "sent" ? "green" : n.status === "failed" ? "red" : n.status === "queued" || n.status === "sending" ? "amber" : "neutral"}>{n.status}</Badge>
              </div>
            ))}
          </div>
        </Card>
      </PageBody>
    </>
  );
}
