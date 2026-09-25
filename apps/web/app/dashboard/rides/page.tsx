import {
  RIDE_FILTER_STATUSES, RIDE_FILTERS, RIDE_SOURCE_LABELS, SETTLEMENT_STATUS_META, VEHICLE_CATEGORY_META, formatDistance, formatPrice, formatRideDate,
  settlementStatusLabel, shortAddress,
  type RideFilterKey, type RideSource, type SettlementDirection, type SettlementStatus, type VehicleCategory,
} from "@rydar/shared";
import { ChevronLeft, ChevronRight, Route, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { NewRideButton } from "@/components/rides/new-ride-button";
import { RouteGlyph } from "@/components/rides/route-glyph";
import { RideStatusBadge, RideTypeTag } from "@/components/rides/status";
import { toneDot, toneText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { requireOrg } from "@/lib/auth";
import { getPricing } from "@/lib/queries/pricing";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Courses" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;

type SettlementCell = { ride_id: string; status: SettlementStatus; direction: SettlementDirection; amount_cents: number; due_at: string; currency: string };

/** Mode centrale : règlement de fin de course, en une ligne sous le statut (« ● En retard 17,40 € »). */
function SettlementLine({ s, now }: { s: SettlementCell; now: number }) {
  const overdue = s.direction === "driver_owes" && s.status === "due" && Date.parse(s.due_at) <= now;
  const tone = overdue ? "red" : SETTLEMENT_STATUS_META[s.status].tone;
  // Libellés courts (colonne étroite) : « Déclaré » = payé selon le chauffeur, à confirmer
  const label = s.status === "declared" ? "Déclaré" : settlementStatusLabel(s.status, s.direction, overdue);
  const title = `${s.status === "declared" ? "Payé selon le chauffeur, à confirmer" : label} · ${s.direction === "driver_owes" ? "commission due par le chauffeur" : "part à verser au chauffeur"}`;
  return (
    <p className="mt-1 flex items-center gap-1.5 whitespace-nowrap text-[11.5px]" title={title}>
      <span className={cn("size-1.5 shrink-0 rounded-full", toneDot[tone])} />
      <span className={toneText[tone]}>{label}</span>
      <span className="mono text-fg-muted">{formatPrice(s.amount_cents, s.currency)}</span>
    </p>
  );
}

export default async function RidesPage({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string; page?: string }> }) {
  const ctx = await requireOrg();
  const centrale = ctx.org.dispatch_model === "centrale";
  const sp = await searchParams;
  const filter = (RIDE_FILTERS.some((f) => f.key === sp.filter) ? sp.filter : "all") as RideFilterKey;
  const q = (sp.q ?? "").trim().slice(0, 80);
  const page = Math.max(1, Number(sp.page) || 1);
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  let query = ctx.supabase
    .from("rides")
    .select(
      "id, number, type, status, source, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, route_polyline, estimated_distance_m, pickup_at, customer_name, customer_phone, vehicle_category, price_cents, driver_payout_cents, driver:drivers!rides_organization_id_driver_id_fkey(first_name, last_name, number)",
      { count: "exact" },
    )
    .eq("organization_id", ctx.org.id);
  if (filter === "instant" || filter === "scheduled") query = query.eq("type", filter);
  const statuses = RIDE_FILTER_STATUSES[filter];
  if (statuses) query = query.in("status", statuses as string[]);
  if (filter === "all" || filter === "completed" || filter === "cancelled") query = query.gte("pickup_at", since);
  if (q) {
    const safe = q.replace(/[%,()]/g, " ");
    const num = Number(q.replace("#", ""));
    query = Number.isInteger(num) && num > 0
      ? query.eq("number", num)
      : query.or(`customer_name.ilike.%${safe}%,customer_phone.ilike.%${safe}%,pickup_address.ilike.%${safe}%,dropoff_address.ilike.%${safe}%`);
  }
  const [{ data: rides, count }, { data: counts }, pricing] = await Promise.all([
    query.order("pickup_at", { ascending: false }).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
    ctx.supabase.rpc("org_ride_counts", { p_org: ctx.org.id, p_since: since }),
    getPricing(ctx.supabase, ctx.org.id),
  ]);
  // Mode centrale : règlements des courses affichées (une requête pour la page)
  const rideIds = (rides ?? []).map((r: { id: string }) => r.id);
  const { data: settlementRows } =
    centrale && rideIds.length
      ? await ctx.supabase.from("ride_settlements").select("ride_id, status, direction, amount_cents, due_at, currency").in("ride_id", rideIds)
      : { data: [] as SettlementCell[] };
  const settlementByRide = new Map(((settlementRows ?? []) as SettlementCell[]).map((x) => [x.ride_id, x]));
  const now = Date.now();
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const href = (f: string, p = 1) => `/dashboard/rides?filter=${f}${q ? `&q=${encodeURIComponent(q)}` : ""}${p > 1 ? `&page=${p}` : ""}`;

  return (
    <>
      <PageHeader
        eyebrow="Opérations"
        title="Courses"
        description="Toutes les réservations reçues par le dashboard, votre site (API) et le mini-site — 30 derniers jours et à venir."
        actions={<NewRideButton pricing={pricing} />}
      >
        <div className="-mb-px flex gap-1 overflow-x-auto">
          {RIDE_FILTERS.map((f) => {
            const n = (counts as Record<string, number> | null)?.[f.key];
            const active = f.key === filter;
            return (
              <Link
                key={f.key}
                href={href(f.key)}
                className={cn(
                  "flex shrink-0 items-center gap-2 border-b-2 px-3 pb-3 pt-1 text-[13px] font-medium transition-colors",
                  active ? "border-brand text-fg" : "border-transparent text-fg-muted hover:text-fg",
                )}
              >
                {f.label}
                {n != null && (
                  <span className={cn("num rounded-md px-1.5 text-[11px]", active ? "bg-brand/15 text-brand" : f.key === "no_driver" && n > 0 ? "bg-red/15 text-red" : "bg-white/[0.06] text-fg-subtle")}>
                    {n}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </PageHeader>
      <PageBody>
        <form className="mb-5 flex max-w-md items-center gap-2" action="/dashboard/rides">
          <input type="hidden" name="filter" value={filter} />
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
            <input
              name="q"
              defaultValue={q}
              placeholder="N° de course, client, téléphone, adresse…"
              className="h-10 w-full rounded-lg border border-line-strong bg-ink-850 pl-9 pr-3 text-sm outline-none placeholder:text-fg-subtle focus:border-brand/60"
            />
          </div>
          <Button type="submit" variant="secondary">Rechercher</Button>
        </form>

        <Card className="overflow-hidden">
          {!rides?.length ? (
            <EmptyState icon={<Route />} title="Aucune course" description="Aucune course ne correspond à ce filtre." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Course</TH>
                  <TH>Prise en charge</TH>
                  <TH>Trajet</TH>
                  <TH>Client</TH>
                  <TH>Chauffeur</TH>
                  <TH className="text-right">Prix</TH>
                  <TH>Statut</TH>
                </tr>
              </THead>
              <tbody>
                {rides.map((r: any) => (
                  <TR key={r.id} className="group relative">
                    <TD>
                      <Link href={`/dashboard/rides/${r.id}`} className="absolute inset-0 z-0" aria-label={`Course ${r.number}`} />
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-semibold tabular-nums text-fg">#{r.number}</span>
                        <RideTypeTag type={r.type} />
                      </div>
                      <span className="text-[11.5px] text-fg-subtle">{RIDE_SOURCE_LABELS[r.source as RideSource]}</span>
                    </TD>
                    <TD className="whitespace-nowrap text-[13px] text-fg-muted">{formatRideDate(r.pickup_at, ctx.org.timezone)}</TD>
                    <TD className={centrale ? "max-w-[300px]" : "max-w-[380px]"}>
                      <div className="flex items-center gap-3">
                        <RouteGlyph polyline={r.route_polyline} from={{ lat: r.pickup_lat, lng: r.pickup_lng }} to={{ lat: r.dropoff_lat, lng: r.dropoff_lng }} />
                        <div className="min-w-0">
                          <p className="truncate text-[13px] text-fg">{shortAddress(r.pickup_address)}</p>
                          <p className="truncate text-[12px] text-fg-subtle">→ {shortAddress(r.dropoff_address)}{r.estimated_distance_m ? ` · ${formatDistance(r.estimated_distance_m)}` : ""}</p>
                        </div>
                      </div>
                    </TD>
                    <TD className={centrale ? "max-w-[180px]" : "max-w-[220px]"}>
                      <p className="truncate text-[13px]">{r.customer_name}</p>
                      <p className="text-[12px] text-fg-subtle">{VEHICLE_CATEGORY_META[r.vehicle_category as VehicleCategory]?.label}</p>
                    </TD>
                    <TD className="text-[13px]">
                      {r.driver ? (
                        <span>
                          {r.driver.first_name} {r.driver.last_name?.charAt(0)}. <span className="num text-fg-subtle">#{r.driver.number}</span>
                        </span>
                      ) : (
                        <span className="text-fg-subtle">—</span>
                      )}
                    </TD>
                    <TD className="text-right text-[14px] font-semibold tabular-nums">
                      {formatPrice(r.price_cents)}
                      {centrale && r.driver_payout_cents != null && (
                        <span className="block whitespace-nowrap text-[11.5px] font-normal text-fg-subtle">
                          <span className="mono text-brand">{formatPrice(r.driver_payout_cents)}</span> chauffeur
                        </span>
                      )}
                      {centrale && r.price_cents == null && <span className="block whitespace-nowrap text-[11.5px] font-normal text-amber">prix à fixer</span>}
                    </TD>

                    <TD>
                      <RideStatusBadge status={r.status} />
                      {centrale && settlementByRide.has(r.id) && <SettlementLine s={settlementByRide.get(r.id)!} now={now} />}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between text-[13px] text-fg-muted">
            <span>
              Page <span className="num text-fg">{page}</span> / <span className="num">{totalPages}</span> · <span className="num">{count}</span> courses
            </span>
            <div className="flex gap-2">
              <Button asChild variant="outline" size="sm" className={cn(page <= 1 && "pointer-events-none opacity-40")}>
                <Link href={href(filter, page - 1)}>
                  <ChevronLeft /> Précédent
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm" className={cn(page >= totalPages && "pointer-events-none opacity-40")}>
                <Link href={href(filter, page + 1)}>
                  Suivant <ChevronRight />
                </Link>
              </Button>
            </div>
          </div>
        )}
      </PageBody>
    </>
  );
}
