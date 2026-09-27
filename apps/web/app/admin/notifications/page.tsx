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
  const [{ data: recent }, { data: last24 }, { data: orgs }] = await Promise.all([
    session.supabase.from("notifications").select("id, organization_id, type, title, body, status, attempts, last_error, provider, created_at, sent_at").order("created_at", { ascending: false }).limit(120),
    session.supabase.from("notifications").select("status").gte("created_at", since),
    session.supabase.from("organizations").select("id, name"),
  ]);
  const name = new Map((orgs ?? []).map((o) => [o.id, o.name]));
  const count = (s: string) => (last24 ?? []).filter((n) => n.status === s).length;
  return (
    <>
      <PageHeader eyebrow="Supervision" title="Notifications push" description="File d'envoi (outbox transactionnelle) livrée par le worker : Expo / FCM / APNs." />
      <PageBody className="space-y-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Envoyées 24 h" value={count("sent")} tone="brand" />
          <StatCard label="En file" value={count("queued") + count("sending")} tone="amber" />
          <StatCard label="Échecs 24 h" value={count("failed")} tone={count("failed") ? "red" : undefined} />
          <StatCard label="Annulées" value={count("cancelled")} sub="course prise par un autre" />
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
