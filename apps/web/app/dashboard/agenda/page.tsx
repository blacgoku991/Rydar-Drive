import { AGENDA_VIEW_PARAMS, addDays, fetchWindow, localIsoDay, zonedTimeToUtc } from "@rydar/shared";
import type { Metadata } from "next";
import {
  agendaParams, dayTimeline, entriesByDay, listDays, monthCells, nextEntryLink, toEntries, weekColumns, weekPhoneRuns, type AgendaNoun, type AgendaRide,
} from "@/components/agenda/agenda-model";
import { AgendaLegend, AgendaToolbar, DayView, ListView, MonthView, WeekView } from "@/components/agenda/agenda-views";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { OFFER_EMBED, bookingStateOf, type BookingOffer } from "@/components/private-fleet/queue";
import { LiveRefresh } from "@/components/rides/live-refresh";
import { NewRideButton } from "@/components/rides/new-ride-button";
import { Callout } from "@/components/ui/callout";
import { requireOrg } from "@/lib/auth";
import { isPrivateFleet } from "@/lib/private-fleet";
import { getPricing } from "@/lib/queries/pricing";

export const metadata: Metadata = { title: "Agenda" };
export const dynamic = "force-dynamic";

const NB = " ";
/** Courses lues au plus sur la fenêtre de la vue (mois : 44 jours). */
const MAX_RIDES = 1000;
/** Fuseau par défaut : affiché seulement quand l'organisation en a un autre. */
const DEFAULT_TZ = "Europe/Paris";

const COLUMNS = "id, number, type, status, pickup_at, pickup_address, dropoff_address, customer_name, price_cents, currency, estimated_duration_s, driver_id";

/**
 * Agenda (docs/FLOTTE-PRIVEE.md § 7.3) — contrat d'URL : ?vue=mois|semaine|jour|liste (défaut : mois)
 * &date=AAAA-MM-JJ (défaut : aujourd'hui, fuseau de l'organisation). Courses de l'organisation sur la fenêtre de la vue
 * (fetchWindow de @rydar/shared : marge d'un jour), regroupées par jour dans le fuseau de l'organisation. Page valable
 * pour toute organisation ; seule la Flotte Privée a l'entrée de menu (décision du propriétaire pour les autres, § 16).
 * Vocabulaire « réservation » en Flotte Privée seulement ; « course » ailleurs.
 */
export default async function AgendaPage({ searchParams }: { searchParams: Promise<{ vue?: string; date?: string }> }) {
  const ctx = await requireOrg();
  const tz = ctx.org.timezone || DEFAULT_TZ;
  const now = Date.now();
  const today = localIsoDay(new Date(now), tz);
  const privateFleet = isPrivateFleet(ctx.org);
  const noun: AgendaNoun = privateFleet ? "booking" : "ride";
  const { view, day } = agendaParams(await searchParams, today, "month");
  const span = fetchWindow(view, day);

  const [{ data, error }, pricing, settings] = await Promise.all([
    ctx.supabase
      .from("rides")
      // Flotte Privée : offres du chauffeur pour l'état des réservations sans chauffeur (à confirmer, refusée…)
      .select(privateFleet ? `${COLUMNS}, ${OFFER_EMBED}` : COLUMNS)
      .eq("organization_id", ctx.org.id)
      .gte("pickup_at", span.from)
      .lt("pickup_at", span.to)
      .order("pickup_at", { ascending: true })
      .limit(MAX_RIDES),
    // Flotte Privée : « Nouvelle réservation » dans l'en-tête (grille tarifaire et paiement par défaut, comme l'Accueil)
    privateFleet ? getPricing(ctx.supabase, ctx.org.id) : Promise.resolve([]),
    privateFleet
      ? ctx.supabase.from("organization_settings").select("default_payment_method").eq("organization_id", ctx.org.id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const rows = (data ?? []) as unknown as (AgendaRide & { driver_id: string | null; offers?: BookingOffer[] | null })[];
  const rides: AgendaRide[] = rows.map(({ offers, driver_id, ...r }) => ({
    ...r,
    state: privateFleet ? bookingStateOf({ status: r.status, driver_id, offers }, ctx.driverId) : null,
  }));
  const entries = toEntries(rides, tz, now);
  const byDay = entriesByDay(entries, tz);

  // Vue Jour sans course : lien vers la prochaine (une lecture de plus, RLS du membre)
  let next: { label: string; href: string } | null = null;
  if (!error && view === "day" && !(byDay[day] ?? []).length) {
    const { data: upcoming } = await ctx.supabase
      .from("rides")
      .select("pickup_at")
      .eq("organization_id", ctx.org.id)
      .gte("pickup_at", zonedTimeToUtc(addDays(day, 1), "00:00", tz).toISOString())
      .neq("status", "CANCELLED")
      .order("pickup_at", { ascending: true })
      .limit(1);
    const first = (upcoming ?? [])[0] as { pickup_at: string } | undefined;
    if (first) next = nextEntryLink(first.pickup_at, tz, now, noun);
  }

  const words = privateFleet ? { many: "réservations", what: "Vos réservations" } : { many: "courses", what: "Vos courses" };
  const defaultPayment = (settings.data as { default_payment_method?: string } | null)?.default_payment_method ?? "card";

  return (
    <>
      {/* Relu au fil des réservations (rafales regroupées, rien onglet caché) */}
      <LiveRefresh events={["ride.updated", "offer.updated"]} pollMs={60_000} debounceMs={2000} />
      <PageHeader
        title="Agenda"
        description={`${words.what} jour par jour${tz !== DEFAULT_TZ ? `, à l'heure de votre organisation (${tz})` : ""}.`}
        actions={privateFleet ? <NewRideButton pricing={pricing} defaultPayment={defaultPayment} privateFleet /> : undefined}
      />
      <PageBody className="space-y-4">
        <AgendaToolbar view={view} day={day} today={today} />
        <AgendaLegend />
        {error ? (
          <Callout tone="danger" title={`Agenda illisible pour le moment${NB}: rechargez la page.`} />
        ) : (
          <>
            {rows.length >= MAX_RIDES && (
              <p className="text-[12.5px] text-fg-muted">
                Affichage limité aux {MAX_RIDES} premières {words.many} de la période{NB}: passez en vue {AGENDA_VIEW_PARAMS.week} ou {AGENDA_VIEW_PARAMS.day}.
              </p>
            )}
            {view === "month" && <MonthView cells={monthCells(day, byDay, today, now, noun)} />}
            {view === "week" &&
              (() => {
                const columns = weekColumns(day, byDay, today, now, noun);
                return <WeekView columns={columns} runs={weekPhoneRuns(columns)} noun={noun} />;
              })()}
            {view === "day" && (
              <DayView
                timeline={dayTimeline(byDay[day] ?? [], tz)}
                entries={byDay[day] ?? []}
                now={now}
                isToday={day === today}
                timeZone={tz}
                noun={noun}
                next={next}
              />
            )}
            {view === "list" && <ListView days={listDays(day, byDay, today, now)} timeZone={tz} noun={noun} />}
          </>
        )}
      </PageBody>
    </>
  );
}
