import { normalizePhone, type DriverStatus, type OrgDocumentAlerts } from "@rydar/shared";
import { Link2, Users } from "lucide-react";
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
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/misc";
import { SearchField } from "@/components/ui/search-field";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { privateFleetPage } from "@/lib/private-fleet";
import { plural } from "@/lib/wording";

export const metadata: Metadata = { title: "Chauffeurs" };
export const dynamic = "force-dynamic";

const PATH = "/dashboard/drivers";
const NB = "\u00a0";

/** Chiffres de la page = filtres de la liste (mêmes clés `?filter=` qu'avant ; la rangée de puces a disparu). */
const FILTERS = [
  { key: "all", label: "Tous" },
  { key: "online", label: "En ligne" },
  { key: "available", label: "Disponibles" },
  { key: "busy", label: "En course" },
  { key: "offline", label: "Hors ligne" },
  { key: "inactive", label: "Désactivés ou suspendus" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

const BUSY = new Set(["en_route", "arrived", "on_trip"]);

/** Règle de chaque filtre (et de son chiffre) : présence en direct des chauffeurs actifs, statut du compte sinon. */
const MATCH: Record<FilterKey, (d: { status: string; presence: string }) => boolean> = {
  all: () => true,
  online: (d) => d.status === "active" && d.presence !== "offline",
  available: (d) => d.status === "active" && d.presence === "available",
  busy: (d) => BUSY.has(d.presence),
  offline: (d) => d.status === "active" && d.presence === "offline",
  inactive: (d) => d.status !== "active",
};

export default async function DriversPage({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string }> }) {
  const ctx = await requireOrg();
  // Flotte Privée : un seul chauffeur, le propriétaire → « Mon profil chauffeur »
  privateFleetPage(ctx, { redirect: "/dashboard/profil" });
  const sp = await searchParams;
  const filter: FilterKey = FILTERS.find((f) => f.key === sp.filter)?.key ?? "all";
  const rawQ = (sp.q ?? "").trim().slice(0, 80);
  const q = rawQ.toLowerCase();

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
  const list = all.filter((d) => (!q || matches(d)) && MATCH[filter](d));
  const online = all.filter(MATCH.online);
  const count = (key: FilterKey) => all.filter(MATCH[key]).length;
  const suspended = all.some((d) => d.status === "suspended");
  const href = (key: FilterKey) => `${PATH}?filter=${key}${rawQ ? `&q=${encodeURIComponent(rawQ)}` : ""}`;
  const filterLabel = FILTERS.find((f) => f.key === filter)!.label;

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
      offers: Number(x?.offers ?? 0),
      completed: Number(x?.completed ?? 0),
      cancelled: Number(x?.cancelled ?? 0),
      revenue_cents: Number(x?.revenue_cents ?? 0),
    };
  });

  return (
    <>
      {/* Présence et statuts relus au fil des changements (rafales regroupées, rien onglet caché) */}
      <LiveRefresh events={["driver.updated"]} pollMs={30_000} debounceMs={2000} />
      <PageHeader
        title="Chauffeurs"
        description="Vos chauffeurs, leur présence en direct et leurs résultats sur 30 jours."
        actions={
          <>
            {/* Lien d'inscription à partager (flotte : « Inscriptions », centrale : « Réseau ») */}
            <Button variant="secondary" asChild>
              <Link href="/dashboard/network" prefetch={false}>
                <Link2 /> Lien d&apos;inscription
              </Link>
            </Button>
            {isAdminRole(ctx.role) && <DriverFormSheet />}
          </>
        }
      />
      <PageBody className="space-y-6">
        {/* Chiffres = filtres de la liste : un clic affiche les chauffeurs comptés (aria-current sur le filtre affiché) */}
        <nav aria-label="Filtrer les chauffeurs" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {FILTERS.map((f) => (
            <StatCard
              key={f.key}
              href={href(f.key)}
              active={f.key === filter}
              label={f.label}
              value={count(f.key)}
              tone={f.key === "inactive" && suspended ? "red" : undefined}
            />
          ))}
        </nav>

        {docAlerts && <DocumentAlertsCard alerts={docAlerts as OrgDocumentAlerts} />}

        {all.length > 0 && (
          <Disclosure
            title="Voir sur la carte"
            hint={plural(online.length, "chauffeur en ligne", "chauffeurs en ligne")}
            lazy
            className="surface rounded-xl px-4 sm:px-5"
            contentClassName="pb-4 pt-1"
          >
            <div className="relative h-[320px] overflow-hidden rounded-lg border border-line">
              {/* Carte : seulement ce qu'elle affiche (position, présence, nom, plaque) ; chargée à l'ouverture du repli */}
              <FleetOverviewMap
                drivers={online.map((d) => {
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
            </div>
          </Disclosure>
        )}

        <SearchField
          action={PATH}
          defaultValue={rawQ}
          label="Rechercher un chauffeur"
          placeholder={`ex.${NB}: nom, téléphone, plaque`}
          params={{ filter: filter === "all" ? null : filter }}
        />

        {!all.length ? (
          <Card>
            <EmptyState
              icon={<Users />}
              title="Aucun chauffeur pour l'instant"
              description={
                isAdminRole(ctx.role)
                  ? `Ajoutez vos chauffeurs ou partagez votre lien d'inscription${NB}: ils reçoivent ensuite les courses dans l'application Rydar Drive.`
                  : "Les chauffeurs ajoutés par un administrateur apparaîtront ici."
              }
            />
          </Card>
        ) : !list.length ? (
          <Card>
            <EmptyState
              size="compact"
              title={
                rawQ
                  ? `Aucun chauffeur ne correspond à «${NB}${rawQ}${NB}»${filter === "all" ? "" : ` dans «${NB}${filterLabel}${NB}»`}.`
                  : `Aucun chauffeur dans «${NB}${filterLabel}${NB}».`
              }
              action={
                <Link href={PATH} prefetch={false} className="inline-flex min-h-11 items-center text-[13px] font-medium text-brand hover:underline sm:min-h-8">
                  Voir tous les chauffeurs
                </Link>
              }
            />
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <DriversTable rows={rows} serverNow={serverNow} />
          </Card>
        )}
      </PageBody>
    </>
  );
}
