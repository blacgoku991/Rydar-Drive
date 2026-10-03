import { normalizePhone, type DriverStatus, type OrgDocumentAlerts } from "@rydar/shared";
import { Link2, Search, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DocumentAlertsCard } from "@/components/drivers/document-alerts";
import { DriverFormSheet } from "@/components/drivers/driver-form-sheet";
import { DriversTable, type DriverTableRow } from "@/components/drivers/drivers-table";
import { FleetOverviewMap } from "@/components/drivers/fleet-overview-map";
import { PageBody, PageHeader, StatCard } from "@/components/layout/page-header";
import { LiveRefresh } from "@/components/rides/live-refresh";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
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
  const serverNow = Date.now();
  const all = (drivers ?? []) as any[];
  const busy = new Set(["en_route", "arrived", "on_trip"]);
  const one = <T,>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? (x[0] ?? null) : (x ?? null));
  // Téléphone saisi comme on le lit (« 06 12… », « 0612… ») comparé au format enregistré (E.164) ; plaque sans espaces ni tirets
  const qPhone = normalizePhone(q);
  const qCompact = q.replace(/[\s.\-]/g, "");
  const qDigits = /^\+?\d{4,15}$/.test(qCompact) ? qCompact.replace(/^\+/, "").replace(/^0/, "") : null;
  const matches = (d: any) => {
    const plate = String(one<any>(d.vehicle)?.plate ?? "").toLowerCase();
    if (`${d.first_name} ${d.last_name} ${d.phone} ${d.email} ${plate} ${d.number}`.toLowerCase().includes(q)) return true;
    if (qPhone && d.phone === qPhone) return true;
    if (qDigits && String(d.phone ?? "").includes(qDigits)) return true;
    return qCompact.length >= 2 && plate.replace(/[\s.\-]/g, "").includes(qCompact);
  };
  const list = all.filter((d) => {
    if (q && !matches(d)) return false;
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
  // Lignes compactes pour le tableau (composant client) : seuls les champs affichés quittent le serveur
  const rows: DriverTableRow[] = list.map((d) => {
    const x = m.get(d.id);
    const vehicle = one<any>(d.vehicle);
    return {
      id: d.id,
      number: d.number,
      first_name: d.first_name,
      last_name: d.last_name,
      phone: d.phone,
      photo_url: d.photo_url,
      status: d.status as DriverStatus,
      presence: d.presence,
      vehicle: vehicle ? { brand: vehicle.brand, model: vehicle.model, plate: vehicle.plate, category: vehicle.category } : null,
      seen_at: one<any>(d.location)?.updated_at ?? null,
      rate: x?.acceptance_rate != null ? Number(x.acceptance_rate) : null,
      offers: x?.offers ?? 0,
      completed: x?.completed ?? 0,
      cancelled: x?.cancelled ?? 0,
      revenue_cents: Number(x?.revenue_cents ?? 0),
    };
  });

  return (
    <>
      {/* Présence et statuts relus au fil des changements (rafales regroupées, rien onglet caché) */}
      <LiveRefresh events={["driver.updated"]} pollMs={30_000} debounceMs={2000} />
      <PageHeader
        eyebrow="Flotte"
        title="Chauffeurs"
        description="Comptes chauffeurs, véhicules, présence temps réel et performance sur 30 jours."
        actions={
          <div className="flex flex-wrap gap-2">
            {/* Lien d'inscription à partager (flotte : « Inscriptions », centrale : « Réseau ») */}
            <Button variant="secondary" asChild>
              <Link href="/dashboard/network" prefetch={false}>
                <Link2 /> Lien d&apos;inscription
              </Link>
            </Button>
            {isAdminRole(ctx.role) && <DriverFormSheet />}
          </div>
        }
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
          {/* Carte : seulement ce qu'elle affiche (position, présence, nom, plaque) */}
          <FleetOverviewMap
            drivers={active
              .filter((d) => d.presence !== "offline")
              .map((d) => {
                const vehicle = one<any>(d.vehicle);
                const loc = one<any>(d.location);
                return {
                  id: d.id,
                  number: d.number,
                  first_name: d.first_name,
                  last_name: d.last_name,
                  presence: d.presence,
                  vehicle: vehicle ? { plate: vehicle.plate } : null,
                  location: loc ? { lat: loc.lat, lng: loc.lng, heading: loc.heading, speed_mps: loc.speed_mps, updated_at: loc.updated_at } : null,
                };
              })}
          />
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1 rounded-xl border border-line bg-ink-850 p-1">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={`/dashboard/drivers?filter=${f.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                prefetch={false}
                className={cn("rounded-lg px-3 py-1.5 text-[12.5px] font-medium", filter === f.key ? "bg-ink-600 text-fg" : "text-fg-muted hover:text-fg")}
              >
                {f.label}
              </Link>
            ))}
          </div>
          <form action="/dashboard/drivers" className="relative w-full max-w-xs">
            <input type="hidden" name="filter" value={filter} />
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
            <input type="search" name="q" defaultValue={q} placeholder="Nom, téléphone, plaque…" aria-label="Rechercher un chauffeur" title="Rechercher un chauffeur" className="h-9 w-full rounded-lg border border-line-field bg-ink-850 pl-9 pr-3 text-sm outline-none placeholder:text-fg-subtle focus:border-brand/60 focus-visible:ring-2 focus-visible:ring-brand/40" />
          </form>
        </div>

        <Card className="overflow-hidden">
          {!list.length ? (
            <EmptyState icon={<Users />} title="Aucun chauffeur" description="Ajoutez vos chauffeurs : ils recevront les courses dans l'application Rydar Drive." />
          ) : (
            <DriversTable rows={rows} serverNow={serverNow} />
          )}
        </Card>
      </PageBody>
    </>
  );
}
