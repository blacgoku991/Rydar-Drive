import {
  DRIVER_STATUS_META, VEHICLE_CATEGORY_META, formatPercent, formatPhone, formatPrice, formatRelative, formatRideDate,
  shortAddress, type DriverStatus, type VehicleCategory,
} from "@rydar/shared";
import { ArrowLeft, Car, MapPin, MessageCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DriverControls } from "@/components/drivers/driver-controls";
import { DriverDocuments } from "@/components/drivers/driver-documents";
import { DriverEarningsCard } from "@/components/drivers/driver-earnings";
import { DriverMap } from "@/components/drivers/driver-map";
import { DOCUMENT_COLUMNS, buildDocumentView, fileKind, type DocumentRow, type DocumentView } from "@/components/drivers/documents";
import { computeDriverEarnings, earningsWindow, type EarningRide } from "@/components/drivers/earnings";
import { PageBody, StatCard } from "@/components/layout/page-header";
import { LiveRefresh } from "@/components/rides/live-refresh";
import { PresenceBadge, RideStatusBadge } from "@/components/rides/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Avatar, EmptyState } from "@/components/ui/misc";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { isAdminRole, requireOrg } from "@/lib/auth";
import type { LiveDriver } from "@/lib/queries/live";

export const metadata: Metadata = { title: "Chauffeur" };
export const dynamic = "force-dynamic";

/** URL signée d'un fichier du bucket privé driver-documents (null si le stockage n'est pas disponible). */
async function signedUrl(supabase: Awaited<ReturnType<typeof requireOrg>>["supabase"], path: string): Promise<string | null> {
  try {
    const res = await Promise.race([
      supabase.storage.from("driver-documents").createSignedUrl(path, 600),
      new Promise<null>((r) => setTimeout(() => r(null), 2500)),
    ]);
    return res && !res.error ? (res.data?.signedUrl ?? null) : null;
  } catch {
    return null;
  }
}

export default async function DriverPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireOrg();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { data: d } = await ctx.supabase
    .from("drivers")
    .select("*, vehicle:vehicles(brand, model, color, plate, category, seats, luggage_capacity), location:driver_locations(lat, lng, heading, speed_mps, updated_at, battery_level)")
    .eq("id", id)
    .eq("organization_id", ctx.org.id)
    .maybeSingle();
  if (!d) notFound();
  const tz = ctx.org.timezone;
  const since = earningsWindow(tz).since;
  const [{ data: stats }, { data: rides }, { data: docs }, { data: trail }, { data: done }, { data: settings }] = await Promise.all([
    ctx.supabase.rpc("driver_stats", { p_driver: id, p_days: 30 }),
    ctx.supabase
      .from("rides")
      .select("id, number, status, pickup_at, pickup_address, dropoff_address, price_cents")
      .eq("organization_id", ctx.org.id)
      .eq("driver_id", id)
      .order("pickup_at", { ascending: false })
      .limit(25),
    ctx.supabase.from("driver_documents").select(DOCUMENT_COLUMNS).eq("organization_id", ctx.org.id).eq("driver_id", id),
    // Trajet des 3 dernières heures (historique échantillonné)
    ctx.supabase
      .from("driver_location_history")
      .select("lat, lng, recorded_at")
      .eq("driver_id", id)
      .gte("recorded_at", new Date(Date.now() - 3 * 3600_000).toISOString())
      .order("recorded_at", { ascending: true })
      .limit(1500),
    // Chiffre d'affaires : courses terminées depuis le début de la semaine / du mois / 14 jours
    ctx.supabase
      .from("rides")
      .select("price_cents, completed_at, pickup_at, payment_method")
      .eq("organization_id", ctx.org.id)
      .eq("driver_id", id)
      .eq("status", "COMPLETED")
      .or(`completed_at.gte."${since}",and(completed_at.is.null,pickup_at.gte."${since}")`)
      .limit(5000),
    ctx.supabase.from("organization_settings").select("driver_commission_percent").eq("organization_id", ctx.org.id).maybeSingle(),
  ]);
  const vehicle = Array.isArray(d.vehicle) ? d.vehicle[0] : d.vehicle;
  const location = Array.isArray(d.location) ? d.location[0] : d.location;
  const live: LiveDriver = { ...d, vehicle, location } as LiveDriver;
  const s = stats as any;
  const commission = settings?.driver_commission_percent != null ? Number(settings.driver_commission_percent) : null;
  const earnings = computeDriverEarnings((done ?? []) as EarningRide[], tz, commission);
  const docView = buildDocumentView((docs ?? []) as unknown as DocumentRow[], tz);
  const documents: DocumentView[] = await Promise.all(
    docView.items.map(async (doc) => ({
      ...doc,
      kind: fileKind(doc.file_path),
      url: doc.file_path ? await signedUrl(ctx.supabase, doc.file_path) : null,
    })),
  );

  return (
    <>
      <LiveRefresh events={["driver.updated"]} pollMs={15000} />
      <div className="border-b border-line">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-end justify-between gap-4 px-6 pb-6 pt-6 lg:px-10">
          <div>
            <Link href="/dashboard/drivers" className="mb-3 inline-flex items-center gap-1.5 text-[12.5px] text-fg-subtle hover:text-fg">
              <ArrowLeft className="size-3.5" /> Chauffeurs
            </Link>
            <div className="flex items-center gap-4">
              <Avatar name={`${d.first_name} ${d.last_name}`} src={d.photo_url} size={56} />
              <div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="text-[26px] font-semibold tracking-tight">{d.first_name} {d.last_name}</h1>
                  <span className="num text-[14px] text-fg-subtle">#{d.number}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <PresenceBadge presence={d.presence} />
                  <Badge tone={DRIVER_STATUS_META[d.status as DriverStatus].tone}>{DRIVER_STATUS_META[d.status as DriverStatus].label}</Badge>
                  <span className="text-[12.5px] text-fg-subtle">{formatPhone(d.phone)} · {d.email}</span>
                </div>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" asChild>
              <Link href={`/dashboard/messages?driver=${d.id}`}>
                <MessageCircle /> Message
              </Link>
            </Button>
            <DriverControls driver={{ ...d, vehicle }} canManage={isAdminRole(ctx.role)} />
          </div>
        </div>
      </div>

      <PageBody className="space-y-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <StatCard label="Taux d'acceptation" value={formatPercent(s?.offers?.acceptance_rate)} sub={`${s?.offers?.offers ?? 0} offres · 30 j`} tone="brand" />
          <StatCard label="Courses terminées" value={s?.rides?.completed ?? 0} sub={`${s?.rides?.completed_all_time ?? 0} au total`} />
          <StatCard label="Annulées" value={s?.rides?.cancelled ?? 0} sub="30 derniers jours" />
          <StatCard label="CA généré" value={formatPrice(s?.rides?.revenue_cents ?? 0)} sub="30 derniers jours" tone="cyan" />
          <StatCard label="Réponse moyenne" value={s?.offers?.avg_response_ms != null ? `${(s.offers.avg_response_ms / 1000).toFixed(1)} s` : "—"} sub="pour accepter" />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1fr_1.2fr]">
          <Card className="flex flex-col overflow-hidden">
            <CardHeader title="Position et trajet des 3 dernières heures" icon={<MapPin />} description={location ? `Mise à jour ${formatRelative(location.updated_at)}${location.battery_level != null ? ` · batterie ${Math.round(location.battery_level * 100)} %` : ""}` : "Jamais connecté"} />
            <div className="relative min-h-[340px] flex-1">{location ? <DriverMap driver={live} trail={((trail ?? []) as { lat: number; lng: number }[]).map((p) => [p.lng, p.lat] as [number, number])} /> : <EmptyState icon={<MapPin />} title="Pas encore de position" description="La position apparaît dès que le chauffeur passe EN LIGNE." />}</div>
          </Card>
          <div className="grid gap-6">
            <Card>
              <CardHeader title="Véhicule" icon={<Car />} />
              <CardBody className="grid grid-cols-2 gap-4 text-[13.5px] sm:grid-cols-3">
                <div><p className="text-[11.5px] text-fg-subtle">Modèle</p><p>{vehicle ? `${vehicle.brand ?? ""} ${vehicle.model}` : "—"}</p></div>
                <div><p className="text-[11.5px] text-fg-subtle">Plaque</p><p className="num">{vehicle?.plate ?? "—"}</p></div>
                <div><p className="text-[11.5px] text-fg-subtle">Couleur</p><p>{vehicle?.color ?? "—"}</p></div>
                <div><p className="text-[11.5px] text-fg-subtle">Catégorie</p><p>{vehicle ? VEHICLE_CATEGORY_META[vehicle.category as VehicleCategory]?.label : "—"}</p></div>
                <div><p className="text-[11.5px] text-fg-subtle">Places</p><p className="num">{vehicle?.seats ?? "—"}</p></div>
                <div><p className="text-[11.5px] text-fg-subtle">Bagages</p><p className="num">{vehicle?.luggage_capacity ?? "—"}</p></div>
              </CardBody>
            </Card>
            <DriverEarningsCard data={earnings} firstName={d.first_name} />
          </div>
        </div>

        <DriverDocuments
          driverId={d.id}
          firstName={d.first_name}
          items={documents}
          missing={docView.missing}
          canReview={["owner", "admin", "dispatcher"].includes(ctx.role)}
        />

        <Card className="overflow-hidden">
          <CardHeader title="Historique des courses" description="25 dernières courses attribuées." />
          {!rides?.length ? (
            <EmptyState title="Aucune course" description="Les courses acceptées apparaîtront ici." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Course</TH>
                  <TH>Date</TH>
                  <TH>Trajet</TH>
                  <TH className="text-right">Prix</TH>
                  <TH>Statut</TH>
                </tr>
              </THead>
              <tbody>
                {rides.map((r: any) => (
                  <TR key={r.id} className="relative">
                    <TD><Link href={`/dashboard/rides/${r.id}`} className="absolute inset-0" aria-label={`Course ${r.number}`} /><span className="num font-semibold">#{r.number}</span></TD>
                    <TD className="text-[13px] text-fg-muted">{formatRideDate(r.pickup_at, tz)}</TD>
                    <TD className="max-w-[360px] truncate text-[13px]">{shortAddress(r.pickup_address)} → {shortAddress(r.dropoff_address)}</TD>
                    <TD className="num text-right font-semibold">{formatPrice(r.price_cents)}</TD>
                    <TD><RideStatusBadge status={r.status} /></TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </PageBody>
    </>
  );
}
