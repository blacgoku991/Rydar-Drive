"use client";
import {
  RIDE_SOURCE_LABELS, VEHICLE_CATEGORY_META, formatCompactPrice, formatDistance, formatDuration, formatNumber, formatPercent, formatPrice,
  type RideSource, type VehicleCategory,
} from "@rydar/shared";
import { ChartNoAxesColumn, Lock } from "lucide-react";
import Link from "next/link";
import { BarList, Columns, DataTable, TrendArea } from "@/components/charts/charts";
import { ShowMoreList } from "@/components/drivers/show-more-list";
import { PRIVATE_SOURCE_LABELS } from "@/components/private-fleet/booking-meta";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Avatar, EmptyState } from "@/components/ui/misc";
import { DesktopTable, ListCard } from "@/components/ui/table";
import { plural } from "@/lib/wording";

const NB = " ";
const WEEKDAYS = ["", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const dayLabel = (v: string) => {
  const d = new Date(v);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
};

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="surface rounded-xl p-4">
      <p className="text-[12.5px] text-fg-muted">{label}</p>
      <p className="mt-2 text-[24px] font-semibold leading-none tracking-tight text-fg">{value}</p>
      {sub && <p className="mt-1.5 text-[12px] text-fg-muted">{sub}</p>}
    </div>
  );
}

/**
 * Sans l'offre avancée : UNE carte (au lieu d'un cadenas par graphique) qui dit ce qu'elle apporterait, « Non compris
 * dans votre offre » et, pour qui peut la changer, le lien vers l'abonnement (aucun nom d'offre écrit en dur).
 */
function AdvancedUpsell({ privateFleet, offersHref }: { privateFleet: boolean; offersHref: string | null }) {
  return (
    <Card>
      <CardHeader title="Statistiques avancées" icon={<Lock />} />
      <CardBody className="space-y-3 text-[13.5px]">
        <p className="text-fg-muted">
          {privateFleet
            ? "Heures et jours les plus actifs, canaux de réservation et catégories demandées."
            : "Heures et jours les plus actifs, canaux de réservation, catégories demandées et résultats par chauffeur."}
        </p>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="font-medium text-fg">Non compris dans votre offre.</span>
          {offersHref && (
            <Link href={offersHref} prefetch={false} className="inline-flex min-h-11 items-center font-medium text-brand hover:underline sm:min-h-0">
              {privateFleet ? "Voir votre abonnement" : "Voir les offres"}
            </Link>
          )}
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * `privateFleet` (Flotte Privée, « Activité ») : vocabulaire « réservation », blocs propres aux chauffeurs d'une flotte
 * masqués (distance au départ des vagues GPS, courses par chauffeur), canaux et catégories masqués s'ils sont vides.
 * Période sans course : une carte qui le dit au lieu de graphiques vides (`longerHref` : période plus longue).
 * `offersHref` : lien « Voir les offres » de la carte des statistiques avancées (propriétaire et administrateur).
 */
export function StatsView({
  stats,
  privateFleet = false,
  offersHref = null,
  longerHref = null,
}: {
  stats: any;
  privateFleet?: boolean;
  offersHref?: string | null;
  longerHref?: string | null;
}) {
  const s = stats.summary ?? {};
  const o = stats.offers ?? {};
  const noun = privateFleet ? "réservation" : "course";
  const daily = (stats.daily ?? []).map((d: any) => ({ ...d, revenue: (d.revenue_cents ?? 0) / 100 }));
  const byHour = (stats.by_hour ?? []).map((h: any) => ({ ...h, label: `${String(h.hour).padStart(2, "0")}${NB}h` }));
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
  const total = Number(s.rides_total ?? 0);
  const ridesLabel = privateFleet ? "Réservations" : "Courses";
  // « 52 terminées · 87 % » ; sans taux (aucune course), pas de « · — » orphelin
  const completedSub = `${plural(s.completed ?? 0, "terminée")}${s.completion_rate != null ? ` · ${formatPercent(s.completion_rate)}` : ""}`;

  const tiles = privateFleet ? (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <Tile label="Chiffre d'affaires" value={formatCompactPrice(s.revenue_cents)} sub={`panier moyen ${formatPrice(s.avg_price_cents)}`} />
      <Tile label="Réservations" value={formatNumber(s.rides_total ?? 0)} sub={completedSub} />
      <Tile label="Taux de confirmation" value={formatPercent(o.acceptance_rate)} sub={plural(o.offers_sent ?? 0, "réservation proposée", "réservations proposées")} />
      <Tile label="Confirmation moyenne" value={s.avg_assign_seconds != null ? formatDuration(s.avg_assign_seconds) : "—"} sub={`immédiates${NB}: réception → confirmation`} />
      <Tile label="Non confirmées ou refusées" value={formatNumber(s.no_driver ?? 0)} sub={plural(s.cancelled ?? 0, "annulée")} />
    </div>
  ) : (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Tile label="Chiffre d'affaires" value={formatCompactPrice(s.revenue_cents)} sub={`panier moyen ${formatPrice(s.avg_price_cents)}`} />
      <Tile label="Courses" value={formatNumber(s.rides_total ?? 0)} sub={completedSub} />
      <Tile label="Taux d'acceptation" value={formatPercent(o.acceptance_rate)} sub={plural(o.offers_sent ?? 0, "proposition aux chauffeurs", "propositions aux chauffeurs")} />
      <Tile label="Attribution moyenne" value={s.avg_assign_seconds != null ? formatDuration(s.avg_assign_seconds) : "—"} sub="création → acceptation" />
      <Tile label="Sans chauffeur" value={formatNumber(s.no_driver ?? 0)} sub={plural(s.cancelled ?? 0, "annulée")} />
      <Tile label="Distance au départ" value={formatDistance(o.avg_pickup_distance_m)} sub="chauffeur → client (moy.)" />
    </div>
  );

  // Période sans course : une carte utile au lieu de graphiques vides
  if (!total) {
    return (
      <div className="space-y-6">
        {tiles}
        <Card>
          <EmptyState
            icon={<ChartNoAxesColumn />}
            title={`Pas encore de ${noun} terminée sur cette période`}
            description={
              privateFleet
                ? "Les graphiques apparaissent dès la première réservation de la période (votre site ou téléphone)."
                : "Les graphiques apparaissent dès la première course de la période."
            }
            action={
              longerHref ? (
                <Link href={longerHref} prefetch={false} className="inline-flex min-h-11 items-center text-[13px] font-medium text-brand hover:underline">
                  Voir les 90 derniers jours
                </Link>
              ) : undefined
            }
          />
        </Card>
        {!stats.advanced && <AdvancedUpsell privateFleet={privateFleet} offersHref={offersHref} />}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {tiles}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader title="Chiffre d'affaires par jour" description={`${privateFleet ? "Réservations" : "Courses"} terminées, en euros.`} />
          <CardBody>
            <TrendArea data={daily} x="date" y="revenue" name="Chiffre d'affaires" format={(v) => formatPrice(Math.round(v * 100))} labelFormat={dayLabel} tickFormat={(v) => formatCompactPrice(v * 100)} />
            <DataTable rows={daily} columns={[{ key: "date", label: "Jour", format: dayLabel }, { key: "revenue_cents", label: "Chiffre d'affaires", format: (v) => formatPrice(v) }]} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={`${ridesLabel} par jour`} description="Toutes origines confondues." />
          <CardBody>
            <Columns data={daily} x="date" y="rides" name={ridesLabel} labelFormat={dayLabel} height={240} />
            <DataTable rows={daily} columns={[{ key: "date", label: "Jour", format: dayLabel }, { key: "rides", label: ridesLabel }, { key: "completed", label: "Terminées" }]} />
          </CardBody>
        </Card>
      </div>

      {stats.advanced ? (
        <>
          <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
            <Card>
              {/* « Pic à … » seulement avec au moins une course */}
              <CardHeader
                title="Heures les plus actives"
                description={peakHour?.rides ? `Pic à ${peakHour.label} (${plural(peakHour.rides, noun)})` : "Heure de prise en charge."}
              />
              <CardBody>
                <Columns data={byHour} x="label" y="rides" name={ridesLabel} highlight={(d) => !!peakHour?.rides && d === peakHour} />
                <DataTable rows={byHour} columns={[{ key: "label", label: "Heure" }, { key: "rides", label: ridesLabel }]} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader
                title="Jours les plus actifs"
                description={peakDay?.rides ? `${peakDay.label}. en tête (${plural(peakDay.rides, noun)})` : "Jour de prise en charge."}
              />
              <CardBody>
                <Columns data={byWeekday} x="label" y="rides" name={ridesLabel} highlight={(d) => !!peakDay?.rides && d === peakDay} />
                <DataTable rows={byWeekday} columns={[{ key: "label", label: "Jour" }, { key: "rides", label: ridesLabel }]} />
              </CardBody>
            </Card>
          </div>

          <div className={privateFleet ? "grid gap-6 xl:grid-cols-2" : "grid gap-6 xl:grid-cols-[1fr_1fr_1.6fr]"}>
            {/* Flotte Privée : canaux et catégories masqués s'ils sont vides */}
            {(!privateFleet || sources.length > 0) && (
              <Card>
                <CardHeader
                  title="Canaux de réservation"
                  description={privateFleet ? "Votre site, réservations prises par téléphone." : "Saisie manuelle, votre site, mini-site."}
                />
                <CardBody>
                  {sources.length ? <BarList items={sources} /> : <p className="text-[13px] text-fg-muted">Aucune course sur la période.</p>}
                </CardBody>
              </Card>
            )}
            {(!privateFleet || categories.length > 0) && (
              <Card>
                <CardHeader title="Catégories demandées" />
                <CardBody>
                  {categories.length ? <BarList items={categories} /> : <p className="text-[13px] text-fg-muted">Aucune course sur la période.</p>}
                </CardBody>
              </Card>
            )}
            {!privateFleet && (
              <Card className="overflow-hidden">
                <CardHeader title="Courses par chauffeur" description="Terminées, chiffre d'affaires et taux d'acceptation sur la période." />
                {!perDriver.length ? (
                  <EmptyState size="compact" title="Aucun chauffeur sollicité sur la période." />
                ) : (
                  <>
                    {/* Téléphone : une carte par chauffeur (toute la carte mène à sa fiche), 10 d'abord puis « Afficher les N
                        chauffeurs » ; le tableau du grand écran défile dans sa carte */}
                    <ShowMoreList initial={10} moreLabel={`Afficher les ${perDriver.length} chauffeurs`}>
                      {perDriver.map((d) => (
                        <ListCard
                          key={d.driver_id}
                          href={`/dashboard/drivers/${d.driver_id}`}
                          aria-label={`${d.name}, n° ${d.number}`}
                          title={
                            <span>
                              {d.name} <span className="num text-[12px] font-normal text-fg-muted">#{d.number}</span>
                            </span>
                          }
                          status={<span className="num text-[13px] font-semibold text-fg">{formatCompactPrice(d.revenue_cents)}</span>}
                          lines={[`${plural(d.rides ?? 0, "course terminée", "courses terminées")} · acceptation ${formatPercent(d.acceptance_rate)}`]}
                        />
                      ))}
                    </ShowMoreList>
                    <DesktopTable className="max-h-[360px] overflow-y-auto">
                      <table className="w-full text-[13px]">
                        <thead className="sticky top-0 bg-ink-800">
                          <tr className="border-b border-line text-[12px] text-fg-muted">
                            <th className="px-5 py-2.5 text-left font-medium">Chauffeur</th>
                            <th className="px-3 py-2.5 text-right font-medium">Courses</th>
                            <th className="px-3 py-2.5 text-right font-medium">Chiffre d&apos;affaires</th>
                            <th className="px-5 py-2.5 text-left font-medium">Acceptation</th>
                          </tr>
                        </thead>
                        <tbody>
                          {perDriver.map((d) => (
                            <tr key={d.driver_id} className="border-b border-line/60 last:border-0">
                              <td className="px-5 py-2.5">
                                <Link href={`/dashboard/drivers/${d.driver_id}`} prefetch={false} className="flex items-center gap-2.5 hover:text-brand">
                                  <Avatar name={d.name} size={26} />
                                  {d.name} <span className="num text-[12px] text-fg-muted">#{d.number}</span>
                                </Link>
                              </td>
                              <td className="num px-3 py-2.5 text-right">{d.rides}</td>
                              <td className="num whitespace-nowrap px-3 py-2.5 text-right">{formatCompactPrice(d.revenue_cents)}</td>
                              <td className="px-5 py-2.5">
                                <div className="flex items-center gap-2.5">
                                  <div aria-hidden className="h-1.5 w-20 overflow-hidden rounded-full bg-white/[0.06]">
                                    <div className="h-full rounded-full bg-brand" style={{ width: `${(d.acceptance_rate ?? 0) * 100}%` }} />
                                  </div>
                                  <span className="num text-[12px] text-fg-muted">{formatPercent(d.acceptance_rate)}</span>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </DesktopTable>
                  </>
                )}
              </Card>
            )}
          </div>
        </>
      ) : (
        <AdvancedUpsell privateFleet={privateFleet} offersHref={offersHref} />
      )}
    </div>
  );
}
