import {
  DRIVER_STATUS_META, VEHICLE_CATEGORY_META, formatPercent, formatPhone, formatPrice, formatRelative,
  type DriverStatus, type OrgDocumentAlerts, type VehicleCategory,
} from "@rydar/shared";
import { Search, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DocumentAlertsCard } from "@/components/drivers/document-alerts";
import { DriverFormSheet } from "@/components/drivers/driver-form-sheet";
import { FleetOverviewMap } from "@/components/drivers/fleet-overview-map";
import { PageBody, PageHeader, StatCard } from "@/components/layout/page-header";
import { PresenceBadge } from "@/components/rides/status";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Avatar, EmptyState } from "@/components/ui/misc";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Chauffeurs" };
export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "all", label: "Tous" },
  { key: "online", label: "En ligne" },
  { key: "available", label: "Disponibles" },
  { key: "busy", label: "En course" },
  { key: "offline", label: "Hors ligne" },
  { key: "inactive", label: "Désactivés / suspendus" },
] as const;

export default async function DriversPage({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string }> }) {
  const ctx = await requireOrg();
  const sp = await searchParams;
  const filter = FILTERS.some((f) => f.key === sp.filter) ? sp.filter! : "all";
  const q = (sp.q ?? "").trim().toLowerCase();

  const [{ data: drivers }, { data: metrics }, { data: docAlerts }] = await Promise.all([
    ctx.supabase
      .from("drivers")
      .select("id, number, first_name, last_name, phone, email, photo_url, status, presence, current_ride_id, online_since, last_seen_at, vehicle:vehicles(model, brand, plate, category, color, seats), location:driver_locations(lat, lng, heading, speed_mps, updated_at)")
      .eq("organization_id", ctx.org.id)
      .order("number"),
    ctx.supabase.rpc("org_driver_metrics", { p_org: ctx.org.id, p_days: 30 }),
    ctx.supabase.rpc("org_document_alerts", { p_org: ctx.org.id }),
  ]);
  const m = new Map(((metrics ?? []) as any[]).map((x) => [x.driver_id, x]));
  const all = (drivers ?? []) as any[];
  const busy = new Set(["en_route", "arrived", "on_trip"]);
  const list = all.filter((d) => {
    if (q && !`${d.first_name} ${d.last_name} ${d.phone} ${d.email} ${d.vehicle?.plate ?? ""} ${d.number}`.toLowerCase().includes(q)) return false;
    switch (filter) {
      case "online": return d.status === "active" && d.presence !== "offline";
      case "available": return d.status === "active" && d.presence === "available";
      case "busy": return busy.has(d.presence);
      case "offline": return d.status === "active" && d.presence === "offline";
      case "inactive": return d.status !== "active";
      default: return true;
    }
  });
  const active = all.filter((d) => d.status === "active");

  return (
    <>
      <PageHeader
        eyebrow="Flotte"
        title="Chauffeurs"
        description="Comptes chauffeurs, véhicules, présence temps réel et performance sur 30 jours."
        actions={isAdminRole(ctx.role) ? <DriverFormSheet /> : undefined}
      />
      <PageBody className="space-y-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <StatCard label="Chauffeurs actifs" value={active.length} />
          <StatCard label="En ligne" value={active.filter((d) => d.presence !== "offline").length} tone="brand" />
          <StatCard label="Disponibles" value={active.filter((d) => d.presence === "available").length} tone="brand" />
          <StatCard label="En course" value={active.filter((d) => busy.has(d.presence)).length} tone="cyan" />
          <StatCard label="Suspendus" value={all.filter((d) => d.status === "suspended").length} tone={all.some((d) => d.status === "suspended") ? "red" : undefined} />
        </div>

        {docAlerts && <DocumentAlertsCard alerts={docAlerts as OrgDocumentAlerts} />}

        <Card className="relative h-[320px] overflow-hidden">
          <FleetOverviewMap
            drivers={active
              .filter((d) => d.presence !== "offline")
              .map((d) => ({
                ...d,
                vehicle: Array.isArray(d.vehicle) ? (d.vehicle[0] ?? null) : d.vehicle,
                location: Array.isArray(d.location) ? (d.location[0] ?? null) : d.location,
              }))}
          />
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1 rounded-xl border border-line bg-ink-850 p-1">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={`/dashboard/drivers?filter=${f.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                className={cn("rounded-lg px-3 py-1.5 text-[12.5px] font-medium", filter === f.key ? "bg-ink-600 text-fg" : "text-fg-muted hover:text-fg")}
              >
                {f.label}
              </Link>
            ))}
          </div>
          <form action="/dashboard/drivers" className="relative w-full max-w-xs">
            <input type="hidden" name="filter" value={filter} />
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
            <input name="q" defaultValue={q} placeholder="Nom, téléphone, plaque…" className="h-9 w-full rounded-lg border border-line-strong bg-ink-850 pl-9 pr-3 text-sm outline-none placeholder:text-fg-subtle focus:border-brand/60" />
          </form>
        </div>

        <Card className="overflow-hidden">
          {!list.length ? (
            <EmptyState icon={<Users />} title="Aucun chauffeur" description="Ajoutez vos chauffeurs : ils recevront les courses dans l'application Rydar Drive." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Chauffeur</TH>
                  <TH>Véhicule</TH>
                  <TH>Présence</TH>
                  <TH className="text-right">Acceptation</TH>
                  <TH className="text-right">Terminées</TH>
                  <TH className="text-right">Annulées</TH>
                  <TH className="text-right">CA 30 j</TH>
                  <TH>Compte</TH>
                </tr>
              </THead>
              <tbody>
                {list.map((d) => {
                  const x = m.get(d.id);
                  const rate = x?.acceptance_rate != null ? Number(x.acceptance_rate) : null;
                  const loc = Array.isArray(d.location) ? d.location[0] : d.location;
                  return (
                    <TR key={d.id} className="relative">
                      <TD>
                        <Link href={`/dashboard/drivers/${d.id}`} className="absolute inset-0" aria-label={`${d.first_name} ${d.last_name}`} />
                        <div className="flex items-center gap-3">
                          <Avatar name={`${d.first_name} ${d.last_name}`} src={d.photo_url} size={34} />
                          <div className="min-w-0">
                            <p className="truncate text-[13.5px] font-medium">
                              {d.first_name} {d.last_name} <span className="num text-[11.5px] text-fg-subtle">#{d.number}</span>
                            </p>
                            <p className="text-[12px] text-fg-subtle">{formatPhone(d.phone)}</p>
                          </div>
                        </div>
                      </TD>
                      <TD>
                        <p className="text-[13px]">{d.vehicle ? `${d.vehicle.brand ?? ""} ${d.vehicle.model}` : "—"}</p>
                        <p className="text-[12px] text-fg-subtle">
                          <span className="num">{d.vehicle?.plate}</span> · {d.vehicle ? VEHICLE_CATEGORY_META[d.vehicle.category as VehicleCategory]?.label : ""}
                        </p>
                      </TD>
                      <TD>
                        <PresenceBadge presence={d.presence} />
                        <p className="mt-1 text-[11px] text-fg-subtle">{loc?.updated_at ? `vu ${formatRelative(loc.updated_at)}` : "jamais connecté"}</p>
                      </TD>
                      <TD className="text-right">
                        <span className={cn("num text-[13.5px] font-semibold", rate == null ? "text-fg-subtle" : rate >= 0.6 ? "text-brand" : rate >= 0.35 ? "text-amber" : "text-red")}>
                          {formatPercent(rate)}
                        </span>
                        <p className="num text-[11px] text-fg-subtle">{x?.offers ?? 0} offres</p>
                      </TD>
                      <TD className="num text-right text-[13.5px]">{x?.completed ?? 0}</TD>
                      <TD className="num text-right text-[13.5px] text-fg-muted">{x?.cancelled ?? 0}</TD>
                      <TD className="num text-right text-[13.5px] font-semibold">{formatPrice(Number(x?.revenue_cents ?? 0))}</TD>
                      <TD>
                        <Badge tone={DRIVER_STATUS_META[d.status as DriverStatus].tone}>{DRIVER_STATUS_META[d.status as DriverStatus].label}</Badge>
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  );
}
