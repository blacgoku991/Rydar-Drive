"use client";
import {
  RIDE_SOURCE_LABELS, VEHICLE_CATEGORY_META, formatCompactPrice, formatDistance, formatDuration, formatNumber, formatPercent, formatPrice,
  type RideSource, type VehicleCategory,
} from "@rydar/shared";
import { Lock } from "lucide-react";
import Link from "next/link";
import { BarList, Columns, DataTable, TrendArea } from "@/components/charts/charts";
import { PRIVATE_SOURCE_LABELS } from "@/components/private-fleet/booking-meta";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Avatar } from "@/components/ui/misc";

const WEEKDAYS = ["", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const dayLabel = (v: string) => {
  const d = new Date(v);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
};

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="surface rounded-xl p-4">
      <p className="text-[12.5px] text-fg-subtle">{label}</p>
      <p className="mt-2 text-[26px] font-semibold leading-none tracking-tight text-fg">{value}</p>
      {sub && <p className="mt-1.5 text-[12px] text-fg-subtle">{sub}</p>}
    </div>
  );
}

function Upsell({ privateFleet }: { privateFleet?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <Lock className="mb-3 size-5 text-fg-subtle" />
      <p className="text-[13px] font-medium">Statistiques avancées</p>
      {privateFleet ? (
        // Flotte Privée : offre attribuée par l'équipe Rydar (aucun changement d'offre en ligne)
        <p className="mt-1 max-w-xs text-[12.5px] text-fg-subtle">Heures et jours les plus actifs : non compris dans votre offre.</p>
      ) : (
        <>
          <p className="mt-1 max-w-xs text-[12.5px] text-fg-subtle">Heures et jours les plus actifs, performance par chauffeur : disponibles avec l&apos;offre Pro.</p>
          <Link href="/dashboard/settings?tab=billing" prefetch={false} className="mt-4 text-[12.5px] font-medium text-brand hover:underline">Voir les offres</Link>
        </>
      )}
    </div>
  );
}

/**
 * `privateFleet` (Flotte Privée, « Activité ») : vocabulaire « réservation », blocs propres aux chauffeurs d'une flotte
 * masqués (distance au départ des vagues GPS, courses par chauffeur).
 */
export function StatsView({ stats, privateFleet = false }: { stats: any; privateFleet?: boolean }) {
  const s = stats.summary ?? {};
  const o = stats.offers ?? {};
  const daily = (stats.daily ?? []).map((d: any) => ({ ...d, revenue: (d.revenue_cents ?? 0) / 100 }));
  const byHour = (stats.by_hour ?? []).map((h: any) => ({ ...h, label: `${String(h.hour).padStart(2, "0")} h` }));
  const byWeekday = (stats.by_weekday ?? []).map((w: any) => ({ ...w, label: WEEKDAYS[w.weekday] }));
  const peakHour = byHour.reduce((a: any, b: any) => (b.rides > (a?.rides ?? -1) ? b : a), null);
  const peakDay = byWeekday.reduce((a: any, b: any) => (b.rides > (a?.rides ?? -1) ? b : a), null);
  // Flotte Privée : « Votre site », « Téléphone »
  const sourceLabel = (k: string) => (privateFleet ? PRIVATE_SOURCE_LABELS[k] : undefined) ?? RIDE_SOURCE_LABELS[k as RideSource] ?? k;
  const sources = Object.entries(stats.by_source ?? {}).map(([k, v]) => ({ label: sourceLabel(k), value: Number(v) }));
  const categories = Object.entries(stats.by_category ?? {})
    .map(([k, v]) => ({ label: VEHICLE_CATEGORY_META[k as VehicleCategory]?.label ?? k, value: Number(v) }))
    .sort((a, b) => b.value - a.value);
  const perDriver = (stats.per_driver ?? []) as any[];

  return (
    <div className="space-y-6">
      {privateFleet ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <Tile label="Chiffre d'affaires" value={formatCompactPrice(s.revenue_cents)} sub={`panier moyen ${formatPrice(s.avg_price_cents)}`} />
          <Tile label="Réservations" value={formatNumber(s.rides_total)} sub={`${formatNumber(s.completed)} terminées · ${formatPercent(s.completion_rate)}`} />
          <Tile label="Taux de confirmation" value={formatPercent(o.acceptance_rate)} sub={`${formatNumber(o.offers_sent)} réservations proposées`} />
          <Tile label="Confirmation moyenne" value={s.avg_assign_seconds != null ? formatDuration(s.avg_assign_seconds) : "—"} sub="immédiates : réception → confirmation" />
          <Tile label="Non confirmées ou refusées" value={formatNumber(s.no_driver)} sub={`${formatNumber(s.cancelled)} annulées`} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Tile label="Chiffre d'affaires" value={formatCompactPrice(s.revenue_cents)} sub={`panier moyen ${formatPrice(s.avg_price_cents)}`} />
          <Tile label="Courses" value={formatNumber(s.rides_total)} sub={`${formatNumber(s.completed)} terminées · ${formatPercent(s.completion_rate)}`} />
          <Tile label="Taux d'acceptation" value={formatPercent(o.acceptance_rate)} sub={`${formatNumber(o.offers_sent)} offres envoyées`} />
          <Tile label="Attribution moyenne" value={s.avg_assign_seconds != null ? formatDuration(s.avg_assign_seconds) : "—"} sub="création → acceptation" />
          <Tile label="Distance au départ" value={formatDistance(o.avg_pickup_distance_m)} sub="chauffeur → client (moy.)" />
          <Tile label="Sans chauffeur" value={formatNumber(s.no_driver)} sub={`${formatNumber(s.cancelled)} annulées`} />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Chiffre d'affaires par jour" description="Courses terminées, en euros." />
          <CardBody>
            <TrendArea data={daily} x="date" y="revenue" name="CA" format={(v) => formatPrice(Math.round(v * 100))} labelFormat={dayLabel} tickFormat={(v) => formatCompactPrice(v * 100)} />
            <DataTable rows={daily} columns={[{ key: "date", label: "Jour", format: dayLabel }, { key: "revenue_cents", label: "CA", format: (v) => formatPrice(v) }]} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={privateFleet ? "Réservations par jour" : "Courses par jour"} description="Toutes sources confondues." />
          <CardBody>
            <Columns data={daily} x="date" y="rides" name={privateFleet ? "Réservations" : "Courses"} labelFormat={dayLabel} height={240} />
            <DataTable
              rows={daily}
              columns={[{ key: "date", label: "Jour", format: dayLabel }, { key: "rides", label: privateFleet ? "Réservations" : "Courses" }, { key: "completed", label: "Terminées" }]}
            />
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader title="Heures les plus actives" description={peakHour ? `Pic à ${peakHour.label} (${peakHour.rides} courses)` : "Heure de prise en charge"} />
          <CardBody>
            {stats.advanced ? (
              <>
                <Columns data={byHour} x="label" y="rides" name="Courses" highlight={(d) => d === peakHour} />
                <DataTable rows={byHour} columns={[{ key: "label", label: "Heure" }, { key: "rides", label: "Courses" }]} />
              </>
            ) : (
              <Upsell privateFleet={privateFleet} />
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Jours les plus actifs" description={peakDay ? `${peakDay.label}. en tête (${peakDay.rides} courses)` : undefined} />
          <CardBody>
            {stats.advanced ? (
              <>
                <Columns data={byWeekday} x="label" y="rides" name="Courses" highlight={(d) => d === peakDay} />
                <DataTable rows={byWeekday} columns={[{ key: "label", label: "Jour" }, { key: "rides", label: "Courses" }]} />
              </>
            ) : (
              <Upsell privateFleet={privateFleet} />
            )}
          </CardBody>
        </Card>
      </div>

      <div className={privateFleet ? "grid gap-6 xl:grid-cols-2" : "grid gap-6 xl:grid-cols-[1fr_1fr_1.6fr]"}>
        <Card>
          <CardHeader title="Canaux de réservation" description={privateFleet ? "Votre site, réservations prises par téléphone." : "Dashboard, site (API), mini-site."} />
          <CardBody>{stats.advanced ? <BarList items={sources} /> : <Upsell privateFleet={privateFleet} />}</CardBody>
        </Card>
        <Card>
          <CardHeader title="Catégories demandées" />
          <CardBody>{stats.advanced ? <BarList items={categories} /> : <Upsell privateFleet={privateFleet} />}</CardBody>
        </Card>
        {!privateFleet && (
        <Card className="overflow-hidden">
          <CardHeader title="Courses par chauffeur" description="Terminées, CA et taux d'acceptation sur la période." />
          {stats.advanced ? (
            <div className="max-h-[360px] overflow-y-auto">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-ink-800">
                  <tr className="border-b border-line text-[12px] text-fg-subtle">
                    <th className="px-5 py-2.5 text-left font-medium">Chauffeur</th>
                    <th className="px-3 py-2.5 text-right font-medium">Courses</th>
                    <th className="px-3 py-2.5 text-right font-medium">CA</th>
                    <th className="px-5 py-2.5 text-left font-medium">Acceptation</th>
                  </tr>
                </thead>
                <tbody>
                  {perDriver.map((d) => (
                    <tr key={d.driver_id} className="border-b border-line/60 last:border-0">
                      <td className="px-5 py-2.5">
                        <Link href={`/dashboard/drivers/${d.driver_id}`} prefetch={false} className="flex items-center gap-2.5 hover:text-brand">
                          <Avatar name={d.name} size={26} />
                          {d.name} <span className="num text-[11px] text-fg-subtle">#{d.number}</span>
                        </Link>
                      </td>
                      <td className="num px-3 py-2.5 text-right">{d.rides}</td>
                      <td className="num px-3 py-2.5 text-right">{formatCompactPrice(d.revenue_cents)}</td>
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-brand/15">
                            <div className="h-full rounded-full bg-brand" style={{ width: `${(d.acceptance_rate ?? 0) * 100}%` }} />
                          </div>
                          <span className="num text-[12px] text-fg-muted">{formatPercent(d.acceptance_rate)}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Upsell privateFleet={privateFleet} />
          )}
        </Card>
        )}
      </div>
    </div>
  );
}
