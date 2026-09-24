import { formatRelative, formatRideDate, shortAddress } from "@rydar/shared";
import type { Metadata } from "next";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { requireSuperAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Dispatch & erreurs" };
export const dynamic = "force-dynamic";

export default async function AdminDispatchPage() {
  const session = await requireSuperAdmin();
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [{ data: events }, { data: noDriver }, { data: orgs }] = await Promise.all([
    session.supabase.from("ride_events").select("id, organization_id, level, type, message, created_at").in("level", ["warning", "error"]).gte("created_at", since).order("id", { ascending: false }).limit(150),
    session.supabase.from("rides").select("id, organization_id, number, pickup_address, dropoff_address, pickup_at, vehicle_category, no_driver_at").eq("status", "NO_DRIVER_FOUND").gte("no_driver_at", since).order("no_driver_at", { ascending: false }).limit(60),
    session.supabase.from("organizations").select("id, name"),
  ]);
  const name = new Map((orgs ?? []).map((o) => [o.id, o.name]));
  return (
    <>
      <PageHeader eyebrow="Supervision" title="Dispatch & erreurs" description="Tous tenants confondus — 7 derniers jours." />
      <PageBody className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
        <Card className="overflow-hidden">
          <CardHeader title="Avertissements & erreurs" description={`${events?.length ?? 0} événements`} />
          <div className="max-h-[70vh] divide-y divide-line overflow-y-auto font-mono text-[12px]">
            {(events ?? []).map((e) => (
              <div key={e.id} className="grid grid-cols-[110px_150px_1fr] gap-3 px-5 py-2">
                <span className="text-fg-subtle">{formatRelative(e.created_at)}</span>
                <span className="truncate text-fg-muted">{name.get(e.organization_id)}</span>
                <span className={e.level === "error" ? "text-red" : "text-amber"}>{e.message}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title="Courses sans chauffeur" description="À analyser : couverture de flotte, catégories, horaires." />
          <div className="max-h-[70vh] divide-y divide-line overflow-y-auto">
            {(noDriver ?? []).map((r) => (
              <div key={r.id} className="px-5 py-2.5 text-[13px]">
                <p><span className="num font-semibold">#{r.number}</span> · {shortAddress(r.pickup_address)} → {shortAddress(r.dropoff_address)}</p>
                <p className="text-[12px] text-fg-subtle">{name.get(r.organization_id)} · {formatRideDate(r.pickup_at)} · {r.vehicle_category}</p>
              </div>
            ))}
          </div>
        </Card>
      </PageBody>
    </>
  );
}
