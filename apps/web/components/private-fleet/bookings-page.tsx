// Flotte Privée, « Réservations » (/dashboard/rides, docs/FLOTTE-PRIVEE.md § 7.3) : filtres À traiter, À venir,
// Terminées, Annulées, Toutes ; pas de colonne chauffeur (un seul chauffeur, le propriétaire) ; états des réservations
// sans chauffeur (PRIVATE_FLEET_BOOKING_STATES). Sous 768 px, une carte par réservation (état et « Réponse avant … »
// d'abord) ; à partir de 768 px, le tableau. Composant serveur ; contrat d'URL :
//   ?filter=todo|upcoming|completed|cancelled|all  (défaut : À traiter s'il y en a, sinon À venir)  &q=…  &page=N
import { VEHICLE_CATEGORY_META, formatDistance, formatRideDate, shortAddress, type PricingRule } from "@rydar/shared";
import { Route } from "lucide-react";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { bookingKind, bookingKindMeta, bookingPrice, bookingRoute, PRIVATE_SOURCE_LABELS, responseDeadline, UPCOMING_STATUSES } from "@/components/private-fleet/booking-meta";
import { BOOKING_COLUMNS, OFFER_EMBED, isToTreat, loadBookingQueue, sortQueue, toBooking, type Booking, type BookingRow } from "@/components/private-fleet/queue";
import { LiveRefresh } from "@/components/rides/live-refresh";
import { NewRideButton } from "@/components/rides/new-ride-button";
import { RouteGlyph } from "@/components/rides/route-glyph";
import { rideMatches, rideSearch } from "@/components/rides/ride-search";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { FilterTabs } from "@/components/ui/filter-tabs";
import { EmptyState } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { SearchField } from "@/components/ui/search-field";
import { DesktopTable, ListCard, MobileList, Table, TD, TH, THead, TR } from "@/components/ui/table";
import type { requireOrg } from "@/lib/auth";
import { plural } from "@/lib/wording";

type OrgCtx = Awaited<ReturnType<typeof requireOrg>>;

const NB = " ";
const PATH = "/dashboard/rides";

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

/** Prix d'une réservation : jamais coupé ; « prix à fixer » en ambre (demande du site sans prix). */
function Price({ b }: { b: Booking }) {
  return b.price_cents == null ? (
    <span className="whitespace-nowrap text-[12.5px] font-normal text-amber">{bookingPrice(null)}</span>
  ) : (
    <span className="num whitespace-nowrap">{bookingPrice(b.price_cents, b.currency)}</span>
  );
}

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
  const href = (f: string, p = 1) => `${PATH}?filter=${f}${q ? `&q=${encodeURIComponent(q)}` : ""}${p > 1 ? `&page=${p}` : ""}`;
  const filterLabel = PRIVATE_RIDE_FILTERS.find((f) => f.key === filter)!.label;

  return (
    <>
      {/* États relus au fil des changements (rafales regroupées, rien onglet caché) */}
      <LiveRefresh events={["ride.updated", "offer.updated"]} pollMs={30_000} debounceMs={2000} />
      <PageHeader
        title="Réservations"
        description={`Les réservations de votre site et celles prises par téléphone${NB}: 30 derniers jours et à venir.`}
        actions={<NewRideButton pricing={pricing} defaultPayment={defaultPayment} privateFleet />}
      />
      <PageBody className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <FilterTabs
            label="Filtrer les réservations"
            items={PRIVATE_RIDE_FILTERS.map((f) => {
              const n = counts[f.key];
              return { href: href(f.key), label: f.label, active: f.key === filter, count: n ?? null, countLabel: n != null ? plural(n, "réservation") : undefined };
            })}
          />
          <SearchField
            action={PATH}
            defaultValue={q}
            label="Rechercher une réservation"
            placeholder={`ex.${NB}: #1001, client, téléphone, adresse`}
            params={{ filter }}
            className="lg:w-[26rem]"
          />
        </div>

        {failed ? (
          <Card>
            <EmptyState icon={<Route />} title="Réservations illisibles" description={`Lecture impossible pour le moment${NB}: rechargez la page.`} />
          </Card>
        ) : !rows.length ? (
          <Card>
            <EmptyState
              size="compact"
              title={
                q
                  ? `Aucune réservation ne correspond à «${NB}${q}${NB}» dans «${NB}${filterLabel}${NB}».`
                  : filter === "todo"
                    ? "Rien à traiter."
                    : `Aucune réservation dans «${NB}${filterLabel}${NB}».`
              }
              description={!q && filter === "todo" ? "Les nouvelles réservations de votre site apparaissent ici." : undefined}
              action={
                q || filter !== "all" ? (
                  <Link href={`${PATH}?filter=all`} prefetch={false} className="inline-flex min-h-11 items-center text-[13px] font-medium text-brand hover:underline sm:min-h-8">
                    Voir toutes les réservations
                  </Link>
                ) : undefined
              }
            />
          </Card>
        ) : (
          <Card className="overflow-hidden">
            {/* Téléphone : une carte par réservation, état et échéance de réponse en premier */}
            <MobileList>
              {rows.map((b) => {
                const meta = bookingKindMeta(bookingKind(b, now));
                const deadline = b.state === "to_confirm" ? responseDeadline(b.offerExpiresAt, tz, now) : null;
                return (
                  <ListCard
                    key={b.id}
                    href={`${PATH}/${b.id}`}
                    aria-label={`Réservation ${b.number}, ${meta.label}${deadline ? `, ${deadline}` : ""}`}
                    title={
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                        {deadline && <span className="text-[12.5px] font-medium text-amber">{deadline}</span>}
                      </span>
                    }
                    status={<Price b={b} />}
                    lines={[
                      <span className="tabular-nums text-fg">
                        {formatRideDate(b.pickup_at, tz, new Date(now))} · #{b.number}
                      </span>,
                      <span title={`${b.pickup_address} → ${b.dropoff_address}`}>{bookingRoute(b)}</span>,
                      <span>
                        {b.customer_name || "Client"} · {VEHICLE_CATEGORY_META[b.vehicle_category]?.label ?? b.vehicle_category} ·{" "}
                        {PRIVATE_SOURCE_LABELS[b.source] ?? b.source}
                      </span>,
                    ]}
                  />
                );
              })}
            </MobileList>
            {/* À partir de 768 px : le tableau (sans étiquette « Planifiée » : toutes les réservations le sont presque) */}
            <DesktopTable>
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
                        <TD className="whitespace-nowrap">
                          <Link href={`${PATH}/${b.id}`} prefetch={false} className="absolute inset-0 z-0" aria-label={`Réservation ${b.number}`} />
                          <span className="text-[13px] font-semibold tabular-nums text-fg">#{b.number}</span>
                          <span className="block text-[12px] text-fg-muted">{PRIVATE_SOURCE_LABELS[b.source] ?? b.source}</span>
                        </TD>
                        <TD className="whitespace-nowrap text-[13px] text-fg-muted">{formatRideDate(b.pickup_at, tz, new Date(now))}</TD>
                        <TD className="max-w-[240px] xl:max-w-[340px]">
                          <div className="flex items-center gap-3" title={`${b.pickup_address} → ${b.dropoff_address}`}>
                            {/* Tracé seulement sur grand écran : il prenait la place du texte */}
                            <span className="hidden xl:block">
                              <RouteGlyph polyline={b.route_polyline} from={{ lat: b.pickup_lat, lng: b.pickup_lng }} to={{ lat: b.dropoff_lat, lng: b.dropoff_lng }} />
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-[13px] text-fg">{shortAddress(b.pickup_address)}</p>
                              <p className="truncate text-[12px] text-fg-muted">
                                → {shortAddress(b.dropoff_address)}
                                {b.estimated_distance_m ? ` · ${formatDistance(b.estimated_distance_m)}` : ""}
                              </p>
                            </div>
                          </div>
                        </TD>
                        <TD className="max-w-[200px]">
                          <p className="truncate text-[13px]" title={b.customer_name ?? undefined}>
                            {b.customer_name || "Client"}
                          </p>
                          <p className="text-[12px] text-fg-muted">{VEHICLE_CATEGORY_META[b.vehicle_category]?.label}</p>
                        </TD>
                        <TD className="text-right text-[14px] font-semibold">
                          <Price b={b} />
                        </TD>
                        <TD>
                          <Badge tone={meta.tone}>{meta.label}</Badge>
                          {deadline && <p className="mt-1 whitespace-nowrap text-[12px] text-amber">{deadline}</p>}
                        </TD>
                      </TR>
                    );
                  })}
                </tbody>
              </Table>
            </DesktopTable>
          </Card>
        )}
        <Pagination page={page} pages={totalPages} href={(p) => href(filter, p)} total={total} noun="réservations" />
      </PageBody>
    </>
  );
}
