// Flotte Privée, « Réservations » (/dashboard/rides, docs/FLOTTE-PRIVEE.md § 7.3) : filtres À traiter, À venir,
// Terminées, Annulées, Toutes ; pas de colonne chauffeur (un seul chauffeur, le propriétaire) ; états des réservations
// sans chauffeur (PRIVATE_FLEET_BOOKING_STATES). Composant serveur ; contrat d'URL :
//   ?filter=todo|upcoming|completed|cancelled|all  (défaut : À traiter s'il y en a, sinon À venir)  &q=…  &page=N
import { VEHICLE_CATEGORY_META, formatDistance, formatRideDate, shortAddress, type PricingRule } from "@rydar/shared";
import { ChevronLeft, ChevronRight, Route, Search } from "lucide-react";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { bookingKind, bookingKindMeta, bookingPrice, PRIVATE_SOURCE_LABELS, responseDeadline, UPCOMING_STATUSES } from "@/components/private-fleet/booking-meta";
import { BOOKING_COLUMNS, OFFER_EMBED, isToTreat, loadBookingQueue, sortQueue, toBooking, type Booking, type BookingRow } from "@/components/private-fleet/queue";
import { ActiveFilterIntoView } from "@/components/rides/active-filter-into-view";
import { LiveRefresh } from "@/components/rides/live-refresh";
import { NewRideButton } from "@/components/rides/new-ride-button";
import { RouteGlyph } from "@/components/rides/route-glyph";
import { rideMatches, rideSearch } from "@/components/rides/ride-search";
import { RideTypeTag } from "@/components/rides/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import type { requireOrg } from "@/lib/auth";
import { cn } from "@/lib/utils";

type OrgCtx = Awaited<ReturnType<typeof requireOrg>>;

export const PRIVATE_RIDE_FILTERS = [
  { key: "todo", label: "À traiter" },
  { key: "upcoming", label: "À venir" },
  { key: "completed", label: "Terminées" },
  { key: "cancelled", label: "Annulées" },
  { key: "all", label: "Toutes" },
] as const;
export type PrivateRideFilter = (typeof PRIVATE_RIDE_FILTERS)[number]["key"];

const PAGE_SIZE = 30;
const CLOSED = "(COMPLETED,CANCELLED,NO_DRIVER_FOUND)";

export async function PrivateBookingsPage({
  ctx,
  searchParams,
  pricing,
  defaultPayment,
}: {
  ctx: OrgCtx;
  searchParams: { filter?: string; q?: string; page?: string };
  pricing: PricingRule[];
  defaultPayment: string;
}) {
  const now = Date.now();
  const tz = ctx.org.timezone || "Europe/Paris";
  const q = (searchParams.q ?? "").trim().slice(0, 80);
  const page = Math.max(1, Number(searchParams.page) || 1);
  const since = new Date(now - 30 * 86_400_000).toISOString();
  const driverId = ctx.driverId;

  // Réservations à traiter (lues dans tous les cas : compteur de l'onglet, filtre par défaut)
  const [queueAll, countsRes] = await Promise.all([
    loadBookingQueue(ctx.supabase, ctx.org.id, driverId, { now }),
    // Mêmes compteurs que l'écran Courses (30 derniers jours et courses non closes), regroupés par onglet
    ctx.supabase.rpc("org_ride_counts", { p_org: ctx.org.id, p_since: since }),
  ]);
  const queue = sortQueue((queueAll ?? []).filter(isToTreat));
  const requested = PRIVATE_RIDE_FILTERS.find((f) => f.key === searchParams.filter)?.key;
  const filter: PrivateRideFilter = requested ?? (queue.length ? "todo" : "upcoming");
  const c = (countsRes.data ?? null) as Record<string, number> | null;
  const counts: Partial<Record<PrivateRideFilter, number>> = {
    todo: queue.length,
    ...(c
      ? {
          upcoming: (c.assigned ?? 0) + (c.ongoing ?? 0),
          completed: c.completed ?? 0,
          cancelled: (c.cancelled ?? 0) + (c.no_driver ?? 0),
          all: c.all ?? 0,
        }
      : {}),
  };

  let rows: Booking[] = [];
  let total = 0;
  let failed = false;
  if (filter === "todo") {
    failed = queueAll === null;
    rows = q ? queue.filter((b) => rideMatches(b, q)) : queue;
    total = rows.length;
  } else {
    let query = ctx.supabase.from("rides").select(`${BOOKING_COLUMNS}, ${OFFER_EMBED}`, { count: "exact" }).eq("organization_id", ctx.org.id);
    if (filter === "upcoming") query = query.in("status", [...UPCOMING_STATUSES]);
    else if (filter === "completed") query = query.eq("status", "COMPLETED").gte("pickup_at", since);
    else if (filter === "cancelled") query = query.in("status", ["CANCELLED", "NO_DRIVER_FOUND"]).gte("pickup_at", since);
    else query = query.or(`pickup_at.gte."${since}",status.not.in.${CLOSED}`);
    if (q) {
      const search = rideSearch(q);
      query = "number" in search ? query.eq("number", search.number) : query.or(search.or);
    }
    const { data, count, error } = await query
      .order("pickup_at", { ascending: filter === "upcoming" })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    failed = !!error;
    rows = ((data ?? []) as unknown as BookingRow[]).map((r) => toBooking(r, driverId, now));
    total = count ?? 0;
  }

  const totalPages = filter === "todo" ? 1 : Math.max(1, Math.ceil(total / PAGE_SIZE));
  const href = (f: string, p = 1) => `/dashboard/rides?filter=${f}${q ? `&q=${encodeURIComponent(q)}` : ""}${p > 1 ? `&page=${p}` : ""}`;

  return (
    <>
      {/* États relus au fil des changements (rafales regroupées, rien onglet caché) */}
      <LiveRefresh events={["ride.updated", "offer.updated"]} pollMs={30_000} debounceMs={2000} />
      <PageHeader
        eyebrow="Mon activité"
        title="Réservations"
        description="Les réservations de votre site et celles prises par téléphone : 30 derniers jours et à venir."
        actions={<NewRideButton pricing={pricing} defaultPayment={defaultPayment} privateFleet />}
      >
        <div className="-mb-px flex gap-1 overflow-x-auto">
          {PRIVATE_RIDE_FILTERS.map((f) => {
            const n = counts[f.key];
            const active = f.key === filter;
            return (
              <Link
                key={f.key}
                href={href(f.key)}
                prefetch={false}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-2 border-b-2 px-3 pb-3 pt-1 text-[13px] font-medium transition-colors",
                  active ? "border-brand text-fg" : "border-transparent text-fg-muted hover:text-fg",
                )}
              >
                {f.label}
                {n != null && (
                  <span
                    className={cn(
                      "num rounded-md px-1.5 text-[11px]",
                      active ? "bg-brand/15 text-brand" : f.key === "todo" && n > 0 ? "bg-amber/15 text-amber" : "bg-white/[0.06] text-fg-subtle",
                    )}
                  >
                    {n}
                  </span>
                )}
              </Link>
            );
          })}
          <ActiveFilterIntoView activeKey={filter} />
        </div>
      </PageHeader>
      <PageBody>
        <form className="mb-5 flex max-w-md items-center gap-2" action="/dashboard/rides">
          <input type="hidden" name="filter" value={filter} />
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="#N° de réservation, client, téléphone, adresse…"
              aria-label="Rechercher une réservation"
              title="Rechercher une réservation"
              className="h-10 w-full rounded-lg border border-line-field bg-ink-850 pl-9 pr-3 text-sm outline-none placeholder:text-fg-subtle focus:border-brand/60 focus-visible:ring-2 focus-visible:ring-brand/40"
            />
          </div>
          <Button type="submit" variant="secondary">Rechercher</Button>
        </form>

        <Card className="overflow-hidden">
          {failed ? (
            <EmptyState icon={<Route />} title="Réservations illisibles" description="Lecture impossible pour le moment : rechargez la page." />
          ) : !rows.length ? (
            <EmptyState
              icon={<Route />}
              title={filter === "todo" ? "Rien à traiter" : "Aucune réservation"}
              description={filter === "todo" ? "Les nouvelles réservations de votre site apparaissent ici." : "Aucune réservation ne correspond à ce filtre."}
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Réservation</TH>
                  <TH>Prise en charge</TH>
                  <TH>Trajet</TH>
                  <TH>Client</TH>
                  <TH className="text-right">Prix</TH>
                  <TH>État</TH>
                </tr>
              </THead>
              <tbody>
                {rows.map((b) => {
                  const meta = bookingKindMeta(bookingKind(b, now));
                  const deadline = b.state === "to_confirm" ? responseDeadline(b.offerExpiresAt, tz, now) : null;
                  return (
                    <TR key={b.id} className="group relative">
                      <TD>
                        <Link href={`/dashboard/rides/${b.id}`} prefetch={false} className="absolute inset-0 z-0" aria-label={`Réservation ${b.number}`} />
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold tabular-nums text-fg">#{b.number}</span>
                          <RideTypeTag type={b.type} />
                        </div>
                        <span className="text-[11.5px] text-fg-subtle">{PRIVATE_SOURCE_LABELS[b.source] ?? b.source}</span>
                      </TD>
                      <TD className="whitespace-nowrap text-[13px] text-fg-muted">{formatRideDate(b.pickup_at, tz, new Date(now))}</TD>
                      <TD className="max-w-[380px]">
                        <div className="flex items-center gap-3">
                          <RouteGlyph polyline={b.route_polyline} from={{ lat: b.pickup_lat, lng: b.pickup_lng }} to={{ lat: b.dropoff_lat, lng: b.dropoff_lng }} />
                          <div className="min-w-0">
                            <p className="truncate text-[13px] text-fg">{shortAddress(b.pickup_address)}</p>
                            <p className="truncate text-[12px] text-fg-subtle">
                              → {shortAddress(b.dropoff_address)}
                              {b.estimated_distance_m ? ` · ${formatDistance(b.estimated_distance_m)}` : ""}
                            </p>
                          </div>
                        </div>
                      </TD>
                      <TD className="max-w-[220px]">
                        <p className="truncate text-[13px]">{b.customer_name || "Client"}</p>
                        <p className="text-[12px] text-fg-subtle">{VEHICLE_CATEGORY_META[b.vehicle_category]?.label}</p>
                      </TD>
                      <TD className="text-right text-[14px] font-semibold tabular-nums">
                        {b.price_cents == null ? <span className="text-[12.5px] font-normal text-amber">{bookingPrice(null)}</span> : bookingPrice(b.price_cents, b.currency)}
                      </TD>
                      <TD>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                        {deadline && <p className="mt-1 whitespace-nowrap text-[11.5px] text-amber">{deadline}</p>}
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between text-[13px] text-fg-muted">
            <span>
              Page <span className="num text-fg">{page}</span> / <span className="num">{totalPages}</span> · <span className="num">{total}</span> réservations
            </span>
            <div className="flex gap-2">
              {page <= 1 ? (
                <Button variant="outline" size="sm" disabled>
                  <ChevronLeft /> Précédent
                </Button>
              ) : (
                <Button asChild variant="outline" size="sm">
                  <Link href={href(filter, page - 1)} prefetch={false}>
                    <ChevronLeft /> Précédent
                  </Link>
                </Button>
              )}
              {page >= totalPages ? (
                <Button variant="outline" size="sm" disabled>
                  Suivant <ChevronRight />
                </Button>
              ) : (
                <Button asChild variant="outline" size="sm">
                  <Link href={href(filter, page + 1)} prefetch={false}>
                    Suivant <ChevronRight />
                  </Link>
                </Button>
              )}
            </div>
          </div>
        )}
      </PageBody>
    </>
  );
}
