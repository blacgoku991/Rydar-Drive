import { AGENDA_VIEW_PARAMS, fetchWindow, localIsoDay } from "@rydar/shared";
import type { Metadata } from "next";
import { agendaParams, dayTimeline, entriesByDay, listDays, monthCells, toEntries, weekColumns, type AgendaRide } from "@/components/agenda/agenda-model";
import { AgendaLegend, AgendaToolbar, DayView, ListView, MonthView, WeekView } from "@/components/agenda/agenda-views";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { OFFER_EMBED, bookingStateOf, type BookingOffer } from "@/components/private-fleet/queue";
import { LiveRefresh } from "@/components/rides/live-refresh";
import { requireOrg } from "@/lib/auth";
import { isPrivateFleet } from "@/lib/private-fleet";

export const metadata: Metadata = { title: "Agenda" };
export const dynamic = "force-dynamic";

/** Courses lues au plus sur la fenêtre de la vue (mois : 44 jours). */
const MAX_RIDES = 1000;

const COLUMNS = "id, number, type, status, pickup_at, pickup_address, dropoff_address, customer_name, price_cents, currency, estimated_duration_s, driver_id";

/**
 * Agenda (docs/FLOTTE-PRIVEE.md § 7.3) — contrat d'URL : ?vue=mois|semaine|jour|liste (défaut : mois)
 * &date=AAAA-MM-JJ (défaut : aujourd'hui, fuseau de l'organisation). Courses de l'organisation sur la fenêtre de la vue
 * (fetchWindow de @rydar/shared : marge d'un jour), regroupées par jour dans le fuseau de l'organisation. Page valable
 * pour toute organisation ; seule la Flotte Privée a l'entrée de menu (décision du propriétaire pour les autres, § 16).
 */
export default async function AgendaPage({ searchParams }: { searchParams: Promise<{ vue?: string; date?: string }> }) {
  const ctx = await requireOrg();
  const tz = ctx.org.timezone || "Europe/Paris";
  const now = Date.now();
  const today = localIsoDay(new Date(now), tz);
  const privateFleet = isPrivateFleet(ctx.org);
  const { view, day } = agendaParams(await searchParams, today, "month");
  const span = fetchWindow(view, day);

  const { data, error } = await ctx.supabase
    .from("rides")
    // Flotte Privée : offres du chauffeur pour l'état des réservations sans chauffeur (à confirmer, refusée…)
    .select(privateFleet ? `${COLUMNS}, ${OFFER_EMBED}` : COLUMNS)
    .eq("organization_id", ctx.org.id)
    .gte("pickup_at", span.from)
    .lt("pickup_at", span.to)
    .order("pickup_at", { ascending: true })
    .limit(MAX_RIDES);
  const rows = (data ?? []) as unknown as (AgendaRide & { driver_id: string | null; offers?: BookingOffer[] | null })[];
  const rides: AgendaRide[] = rows.map(({ offers, driver_id, ...r }) => ({
    ...r,
    state: privateFleet ? bookingStateOf({ status: r.status, driver_id, offers }, ctx.driverId) : null,
  }));
  const entries = toEntries(rides, tz, now);
  const byDay = entriesByDay(entries, tz);

  return (
    <>
      {/* Relu au fil des réservations (rafales regroupées, rien onglet caché) */}
      <LiveRefresh events={["ride.updated", "offer.updated"]} pollMs={60_000} debounceMs={2000} />
      <PageHeader
        eyebrow={privateFleet ? "Mon activité" : "Opérations"}
        title="Agenda"
        description={`Réservations jour par jour, à l'heure de votre organisation (${tz}).`}
      />
      <PageBody className="space-y-4">
        <AgendaToolbar view={view} day={day} today={today} />
        <AgendaLegend />
        {error ? (
          <p role="alert" className="rounded-xl border border-red/30 bg-red/[0.07] px-4 py-3 text-[13px] text-fg">
            Agenda illisible pour le moment : rechargez la page.
          </p>
        ) : (
          <>
            {rows.length >= MAX_RIDES && (
              <p className="text-[12.5px] text-fg-muted">
                Affichage limité aux {MAX_RIDES} premières courses de la période : passez en vue {AGENDA_VIEW_PARAMS.week} ou {AGENDA_VIEW_PARAMS.day}.
              </p>
            )}
            {view === "month" && <MonthView cells={monthCells(day, byDay, today, now)} />}
            {view === "week" && <WeekView columns={weekColumns(day, byDay, today, now)} />}
            {view === "day" && (
              <DayView timeline={dayTimeline(byDay[day] ?? [], tz)} entries={byDay[day] ?? []} now={now} isToday={day === today} timeZone={tz} />
            )}
            {view === "list" && <ListView days={listDays(day, byDay, today, now)} timeZone={tz} />}
          </>
        )}
      </PageBody>
    </>
  );
}
