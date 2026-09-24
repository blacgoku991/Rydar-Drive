import { formatRelative } from "@rydar/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { requireSuperAdmin } from "@/lib/auth";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Sécurité & audit" };
export const dynamic = "force-dynamic";

export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<{ severity?: string }> }) {
  const session = await requireSuperAdmin();
  const { severity } = await searchParams;
  let q = session.supabase.from("audit_logs").select("id, organization_id, actor_type, action, entity_type, entity_id, severity, ip, metadata, created_at").order("id", { ascending: false }).limit(200);
  if (severity === "security") q = q.in("severity", ["warning", "critical"]);
  const [{ data: logs }, { data: orgs }] = await Promise.all([q, session.supabase.from("organizations").select("id, name")]);
  const name = new Map((orgs ?? []).map((o) => [o.id, o.name]));
  return (
    <>
      <PageHeader eyebrow="Supervision" title="Sécurité & audit" description="Toute action sensible est tracée : création, suspension, clés API, tentatives d'accès inter-tenant." />
      <PageBody className="space-y-4">
        <div className="flex gap-1 rounded-xl border border-line bg-ink-850 p-1 sm:w-fit">
          {[["all", "Tout"], ["security", "Alertes de sécurité"]].map(([k, l]) => (
            <Link key={k} href={`/admin/audit${k === "all" ? "" : "?severity=security"}`} className={cn("rounded-lg px-3 py-1.5 text-[12.5px]", (severity ?? "all") === k ? "bg-ink-600 text-fg" : "text-fg-muted")}>{l}</Link>
          ))}
        </div>
        <Card className="overflow-hidden">
          <div className="divide-y divide-line font-mono text-[12px]">
            {(logs ?? []).map((l) => (
              <div key={l.id} className="grid grid-cols-[110px_90px_160px_1fr_110px] items-center gap-3 px-5 py-2">
                <span className="text-fg-subtle">{formatRelative(l.created_at)}</span>
                <Badge tone={l.severity === "critical" ? "red" : l.severity === "warning" ? "amber" : "neutral"}>{l.severity}</Badge>
                <span className="truncate text-fg-muted">{l.organization_id ? name.get(l.organization_id) : "plateforme"}</span>
                <span className="truncate text-fg">{l.action} <span className="text-fg-subtle">{l.entity_type ? `· ${l.entity_type}` : ""}</span></span>
                <span className="truncate text-right text-fg-subtle">{l.actor_type}{l.ip ? ` · ${l.ip}` : ""}</span>
              </div>
            ))}
          </div>
        </Card>
      </PageBody>
    </>
  );
}
