import {
  RIDE_FILTER_STATUSES, RIDE_FILTERS, RIDE_SOURCE_LABELS, SETTLEMENT_STATUS_META, VEHICLE_CATEGORY_META, formatDistance, formatPrice, formatRideDate,
  settlementStatusLabel, shortAddress,
  type NetworkPartnerNames, type RideFilterKey, type RideSource, type SettlementDirection, type SettlementStatus, type VehicleCategory,
} from "@rydar/shared";
import { ArrowLeftRight, Route } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { NETWORK_RIDES_FILTER, networkRidesOrFilter, partnerOrgOf, rideListNetworkCell } from "@/components/network-share/ride-network";
import { LiveRefresh } from "@/components/rides/live-refresh";
import { NewRideButton } from "@/components/rides/new-ride-button";
import { RouteGlyph } from "@/components/rides/route-glyph";
import { rideSearch } from "@/components/rides/ride-search";
import { RideStatusBadge, RideTypeTag } from "@/components/rides/status";
import { toneDot, toneText } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { FilterTabs } from "@/components/ui/filter-tabs";
import { EmptyState } from "@/components/ui/misc";
import { Pagination } from "@/components/ui/pagination";
import { SearchField } from "@/components/ui/search-field";
import { DesktopTable, ListCard, MobileList, Table, TD, TH, THead, TR } from "@/components/ui/table";
import { PrivateBookingsPage } from "@/components/private-fleet/bookings-page";
import { requireOrg } from "@/lib/auth";
import { isPrivateFleet } from "@/lib/private-fleet";
import { getPricing } from "@/lib/queries/pricing";
import { sharedNetworkEnabled } from "@/lib/shared-network";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/wording";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const ctx = await requireOrg();
  return { title: isPrivateFleet(ctx.org) ? "Réservations" : "Courses" };
}

const PAGE_SIZE = 30;
const PATH = "/dashboard/rides";
/** Second groupe de filtres (type de course) ; les autres clés sont des statuts. Mêmes clés `?filter=` qu'avant. */
const TYPE_KEYS = new Set<string>(["instant", "scheduled"]);

type SettlementCell = { ride_id: string; status: SettlementStatus; direction: SettlementDirection; amount_cents: number; due_at: string; currency: string };

/** Mode centrale : règlement de fin de course, en une ligne sous le statut (« ● En retard 17,40 € »). */
function SettlementLine({ s, now, partner, className }: { s: SettlementCell; now: number; partner?: boolean; className?: string }) {
  const overdue = s.direction === "driver_owes" && s.status === "due" && Date.parse(s.due_at) <= now;
  const tone = overdue ? "red" : SETTLEMENT_STATUS_META[s.status].tone;
  // Libellés courts (colonne étroite) : « Déclaré » = payé selon le chauffeur, à confirmer
  const label = s.status === "declared" ? "Déclaré" : settlementStatusLabel(s.status, s.direction, overdue);
  const who = partner ? "chauffeur partenaire" : "chauffeur";
  const title = `${s.status === "declared" ? `Payé selon le ${who}, à confirmer` : label} · ${s.direction === "driver_owes" ? (partner ? "part reversée par le chauffeur partenaire" : "commission due par le chauffeur") : `part à verser au ${who}`}`;
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-[12px]", className)} title={title}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", toneDot[tone])} />
      <span className={toneText[tone]}>{label}</span>
      <span className="mono text-fg-muted">{formatPrice(s.amount_cents, s.currency)}</span>
    </span>
  );
}

/**
 * Centre de l'activité (médiane des départs des courses affichées) : les raccourcis d'adresses de « Nouvelle course »
 * (aéroports et gares de Paris) ne s'affichent que pour une activité en Île-de-France. Aucune lecture de plus.
 */
function activityCenter(rows: { pickup_lat: number | null; pickup_lng: number | null }[]): { lat: number; lng: number } | null {
  const pts = rows.filter((r) => Number.isFinite(r.pickup_lat) && Number.isFinite(r.pickup_lng)) as { pickup_lat: number; pickup_lng: number }[];
  if (!pts.length) return null;
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  return { lat: median(pts.map((p) => p.pickup_lat)), lng: median(pts.map((p) => p.pickup_lng)) };
}

export default async function RidesPage({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string; page?: string }> }) {
  const ctx = await requireOrg();
  const sp = await searchParams;
  // Flotte Privée (docs/FLOTTE-PRIVEE.md § 7.3) : réservations à traiter, à venir, terminées, annulées ; pas de colonne
  // chauffeur, ni réseau partagé, ni encaissements
  if (isPrivateFleet(ctx.org)) {
    const [pricing, settings] = await Promise.all([
      getPricing(ctx.supabase, ctx.org.id),
      ctx.supabase.from("organization_settings").select("default_payment_method").eq("organization_id", ctx.org.id).maybeSingle(),
    ]);
    return (
      <PrivateBookingsPage
        ctx={ctx}
        searchParams={sp}
        pricing={pricing}
        defaultPayment={(settings.data as { default_payment_method?: string } | null)?.default_payment_method ?? "card"}
      />
    );
  }
  const centrale = ctx.org.dispatch_model === "centrale";
  // Réseau partagé ouvert par la plateforme (même lecture que la mise en page, mémorisée par requête) : filtre
  // « Réseau partagé » en plus. Attendu avant la requête seulement quand ce filtre est demandé ; sinon en parallèle.
  const networkOnP = sharedNetworkEnabled();
  const networkFilter = sp.filter === NETWORK_RIDES_FILTER.key && (await networkOnP) ? networkRidesOrFilter(ctx.org.id) : null;
  const filter = (networkFilter ? NETWORK_RIDES_FILTER.key : RIDE_FILTERS.some((f) => f.key === sp.filter) ? sp.filter : "all") as RideFilterKey | typeof NETWORK_RIDES_FILTER.key;
  const q = (sp.q ?? "").trim().slice(0, 80);
  const page = Math.max(1, Number(sp.page) || 1);
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  // Mode centrale : règlement de fin de course embarqué dans la même requête (ride_settlements.ride_id unique ; clé
  // étrangère (organization_id, ride_id) → renvoyé en tableau par PostgREST), sans second aller-retour
  let query = ctx.supabase
    .from("rides")
    .select(
      `id, number, type, status, source, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, route_polyline, estimated_distance_m, pickup_at, customer_name, customer_phone, vehicle_category, price_cents, driver_payout_cents, driver_id, driver_org_id, network_at, driver:drivers!rides_organization_id_driver_id_fkey(first_name, last_name, number)${
        centrale ? ", settlement:ride_settlements(ride_id, status, direction, amount_cents, due_at, currency)" : ""
      }`,
      { count: "exact" },
    )
    .eq("organization_id", ctx.org.id);
  if (filter === "instant" || filter === "scheduled") query = query.eq("type", filter);
  const statuses = networkFilter ? null : RIDE_FILTER_STATUSES[filter as RideFilterKey];
  if (statuses) query = query.in("status", statuses as string[]);
  if (networkFilter) query = query.or(networkFilter);
  // Même règle que les compteurs des onglets (org_ride_counts) : 30 derniers jours, plus toute course non terminée
  // (filtre « Réseau partagé » compris : plusieurs or() se cumulent)
  if (filter === "completed" || filter === "cancelled" || filter === "no_driver") query = query.gte("pickup_at", since);
  else if (!statuses) query = query.or(`pickup_at.gte."${since}",status.not.in.(COMPLETED,CANCELLED,NO_DRIVER_FOUND)`);
  if (q) {
    // Numéro exact (« #1678 ») ou client, téléphone et adresses (components/rides/ride-search.ts)
    const search = rideSearch(q);
    query = "number" in search ? query.eq("number", search.number) : query.or(search.or);
  }
  const [{ data: rides, count }, { data: counts }, pricing, networkOn] = await Promise.all([
    query.order("pickup_at", { ascending: false }).range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
    ctx.supabase.rpc("org_ride_counts", { p_org: ctx.org.id, p_since: since }),
    getPricing(ctx.supabase, ctx.org.id),
    networkOnP,
  ]);
  const settlementOf = (r: { settlement?: SettlementCell | SettlementCell[] | null }): SettlementCell | null =>
    (Array.isArray(r.settlement) ? r.settlement[0] : r.settlement) ?? null;
  // Courses tenues par des chauffeurs partenaires sur cette page : noms des organisations (« Réseau · Flotte B »),
  // lus seulement s'il y en a (jamais pour une organisation qui n'a pas touché le réseau)
  const partnerRides = (rides ?? []).some((r: any) => partnerOrgOf(r, ctx.org.id));
  const partners = partnerRides
    ? (((await ctx.supabase.rpc("network_partner_names", { p_org: ctx.org.id })).data ?? null) as NetworkPartnerNames | null)
    : null;
  const now = Date.now();
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const href = (f: string, p = 1) => `${PATH}?filter=${f}${q ? `&q=${encodeURIComponent(q)}` : ""}${p > 1 ? `&page=${p}` : ""}`;
  const n = (key: string) => (counts as Record<string, number> | null)?.[key] ?? null;
  const tab = (f: { key: string; label: string }) => {
    const c = n(f.key);
    return {
      href: href(f.key),
      label: f.label,
      active: f.key === filter,
      count: c,
      countLabel: c != null ? plural(c, "course") : undefined,
      // « Sans chauffeur » au-dessus de zéro : à traiter (rouge)
      alert: f.key === "no_driver",
    };
  };
  const statusTabs = RIDE_FILTERS.filter((f) => !TYPE_KEYS.has(f.key)).map(tab);
  const typeTabs = [...RIDE_FILTERS.filter((f) => TYPE_KEYS.has(f.key)), ...(networkOn ? [NETWORK_RIDES_FILTER] : [])].map(tab);
  const filterLabel = [...RIDE_FILTERS, NETWORK_RIDES_FILTER].find((f) => f.key === filter)?.label ?? "Toutes";
  const list = (rides ?? []) as any[];
  const nothingYet = !list.length && !q && filter === "all";

  return (
    <>
      {/* Statuts relus au fil des changements (rafales regroupées, rien onglet caché) */}
      <LiveRefresh events={["ride.updated"]} pollMs={30_000} debounceMs={2000} />
      <PageHeader
        title="Courses"
        description="Vos courses des 30 derniers jours et à venir."
        actions={<NewRideButton pricing={pricing} center={activityCenter(list)} />}
      />
      <PageBody className="space-y-4">
        <div data-tour="rides-filters" className="space-y-3">
          <FilterTabs label="Filtrer par statut" items={statusTabs} />
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-center gap-2.5">
              <span aria-hidden className="shrink-0 text-[13px] text-fg-muted">
                Type
              </span>
              <FilterTabs label="Filtrer par type" items={typeTabs} />
            </div>
            <SearchField
              action={PATH}
              defaultValue={q}
              label="Rechercher une course"
              placeholder={"ex. : #1678, client, téléphone, adresse"}
              params={{ filter }}
              className="lg:w-[26rem]"
            />
          </div>
        </div>

        {nothingYet ? (
          <Card>
            <EmptyState
              icon={<Route />}
              title="Aucune course pour l'instant"
              description={"Créez votre première course avec « Nouvelle course », ou reliez votre site dans « API & site web »."}
            />
          </Card>
        ) : !list.length ? (
          <Card>
            <EmptyState
              size="compact"
              title={
                q
                  ? `Aucune course ne correspond à « ${q} »${filter === "all" ? "" : ` dans « ${filterLabel} »`}.`
                  : `Aucune course dans « ${filterLabel} ».`
              }
              action={
                <Link href={PATH} prefetch={false} className="inline-flex min-h-11 items-center text-[13px] font-medium text-brand hover:underline sm:min-h-8">
                  Voir toutes les courses
                </Link>
              }
            />
          </Card>
        ) : (
          <Card className="overflow-hidden">
            {/* Téléphone : une carte par course (toute la carte est un lien vers la fiche) */}
            <MobileList>
              {list.map((r) => {
                const net = rideListNetworkCell(r, ctx.org.id, partners);
                const s = centrale ? settlementOf(r) : null;
                const route = `${shortAddress(r.pickup_address)} → ${shortAddress(r.dropoff_address)}`;
                const who = net ? (
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-violet">
                    <ArrowLeftRight aria-hidden className="size-3.5 shrink-0" />
                    <span className="truncate">{net.title}</span>
                  </span>
                ) : r.driver ? (
                  <span>
                    {r.driver.first_name} {r.driver.last_name?.charAt(0)}. <span className="num text-fg-subtle">#{r.driver.number}</span>
                  </span>
                ) : null;
                return (
                  <ListCard
                    key={r.id}
                    href={`${PATH}/${r.id}`}
                    aria-label={`Course ${r.number}, ${formatRideDate(r.pickup_at, ctx.org.timezone)}`}
                    title={
                      <span className="tabular-nums">
                        #{r.number} · {formatRideDate(r.pickup_at, ctx.org.timezone)}
                      </span>
                    }
                    status={<RideStatusBadge status={r.status} />}
                    lines={[
                      <span title={`${r.pickup_address} → ${r.dropoff_address}`}>{route}</span>,
                      // Le client se tronque, jamais le prix
                      <span className="flex min-w-0 items-baseline gap-1">
                        <span className="min-w-0 truncate" title={r.customer_name}>
                          {r.customer_name} · {VEHICLE_CATEGORY_META[r.vehicle_category as VehicleCategory]?.label ?? r.vehicle_category}
                        </span>
                        <span className="shrink-0 whitespace-nowrap">
                          ·{" "}
                          {centrale && r.price_cents == null ? (
                            <span className="text-amber">prix à fixer</span>
                          ) : (
                            <span className="font-medium text-fg">{formatPrice(r.price_cents)}</span>
                          )}
                        </span>
                      </span>,
                      who || s ? (
                        <span className="inline-flex max-w-full items-center gap-2">
                          {who}
                          {who && s && <span aria-hidden className="text-fg-subtle">·</span>}
                          {s && <SettlementLine s={s} now={now} partner={!!partnerOrgOf(r, ctx.org.id)} />}
                        </span>
                      ) : null,
                    ]}
                  />
                );
              })}
            </MobileList>
            {/* À partir de 768 px : le tableau */}
            <DesktopTable>
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
                  {list.map((r) => {
                    const net = rideListNetworkCell(r, ctx.org.id, partners);
                    const s = centrale ? settlementOf(r) : null;
                    return (
                      <TR key={r.id} className="group relative">
                        <TD className="whitespace-nowrap">
                          <Link href={`${PATH}/${r.id}`} prefetch={false} className="absolute inset-0 z-0" aria-label={`Course ${r.number}`} />
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-semibold tabular-nums text-fg">#{r.number}</span>
                            <RideTypeTag type={r.type} />
                          </div>
                          <span className="text-[12px] text-fg-muted">{RIDE_SOURCE_LABELS[r.source as RideSource] ?? r.source}</span>
                        </TD>
                        <TD className="whitespace-nowrap text-[13px] text-fg-muted">{formatRideDate(r.pickup_at, ctx.org.timezone)}</TD>
                        <TD className="max-w-[240px] xl:max-w-[300px]">
                          <div className="flex items-center gap-3" title={`${r.pickup_address} → ${r.dropoff_address}`}>
                            {/* Tracé seulement sur grand écran : il prenait la place du texte */}
                            <span className="hidden xl:block">
                              <RouteGlyph polyline={r.route_polyline} from={{ lat: r.pickup_lat, lng: r.pickup_lng }} to={{ lat: r.dropoff_lat, lng: r.dropoff_lng }} />
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-[13px] text-fg">{shortAddress(r.pickup_address)}</p>
                              <p className="truncate text-[12px] text-fg-muted">
                                → {shortAddress(r.dropoff_address)}
                                {r.estimated_distance_m ? ` · ${formatDistance(r.estimated_distance_m)}` : ""}
                              </p>
                            </div>
                          </div>
                        </TD>
                        <TD className="max-w-[180px]">
                          <p className="truncate text-[13px]" title={r.customer_name}>
                            {r.customer_name}
                          </p>
                          <p className="text-[12px] text-fg-muted">{VEHICLE_CATEGORY_META[r.vehicle_category as VehicleCategory]?.label}</p>
                        </TD>
                        <TD className="text-[13px]">
                          {net ? (
                            // Réseau partagé : organisation du chauffeur partenaire, jamais sa fiche
                            <span className="flex min-w-0 items-start gap-1.5 text-violet">
                              <ArrowLeftRight aria-hidden className="mt-[3px] size-3.5 shrink-0" />
                              <span className="min-w-0">
                                <span className="block max-w-[150px] truncate whitespace-nowrap">{net.title}</span>
                                {net.sub && <span className="block whitespace-nowrap text-[12px] text-fg-muted">{net.sub}</span>}
                              </span>
                            </span>
                          ) : r.driver ? (
                            <span className="whitespace-nowrap">
                              {r.driver.first_name} {r.driver.last_name?.charAt(0)}. <span className="num text-fg-subtle">#{r.driver.number}</span>
                            </span>
                          ) : (
                            <span className="text-fg-subtle">—</span>
                          )}
                        </TD>
                        <TD className="whitespace-nowrap text-right text-[14px] font-semibold tabular-nums">
                          {formatPrice(r.price_cents)}
                          {centrale && r.driver_payout_cents != null && (
                            <span className="block text-[12px] font-normal text-fg-muted">
                              <span className="mono text-fg">{formatPrice(r.driver_payout_cents)}</span> chauffeur
                            </span>
                          )}
                          {centrale && r.price_cents == null && <span className="block text-[12px] font-normal text-amber">prix à fixer</span>}
                        </TD>
                        <TD className="whitespace-nowrap">
                          <RideStatusBadge status={r.status} />
                          {s && <SettlementLine s={s} now={now} partner={!!partnerOrgOf(r, ctx.org.id)} className="mt-1 flex" />}
                        </TD>
                      </TR>
                    );
                  })}
                </tbody>
              </Table>
            </DesktopTable>
          </Card>
        )}
        <Pagination page={page} pages={totalPages} href={(p) => href(filter, p)} total={count} noun={(count ?? 0) >= 2 ? "courses" : "course"} label="Pages des courses" />
      </PageBody>
    </>
  );
}
