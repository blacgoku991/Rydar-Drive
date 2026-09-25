// Chiffre d'affaires d'un chauffeur vu par la centrale (miroir de public.driver_earnings :
// courses COMPLETED, date = completed_at sinon pickup_at, semaine depuis lundi, fuseau de l'org).
import { zonedTimeToUtc } from "@rydar/shared";
import { orgToday } from "./documents";

export type EarningRide = { price_cents: number | null; completed_at: string | null; pickup_at: string; payment_method: string | null };
export type EarningPeriod = { rides: number; revenue_cents: number; net_cents: number | null; cash_cents: number; unpriced: number };
export type DriverEarningsView = {
  commission: number | null;
  week: EarningPeriod;
  month: EarningPeriod;
  /** 14 derniers jours, du plus ancien au plus récent */
  series: { date: string; label: string; rides: number; revenue_cents: number; today: boolean }[];
};

const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
};

/** Bornes (instants UTC) de la semaine, du mois et de la série. */
export function earningsWindow(timeZone: string, days = 14) {
  const today = orgToday(timeZone);
  const [y, m, d] = today.split("-").map(Number);
  const dow = (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7; // lundi = 0
  const weekStart = addDays(today, -dow);
  const monthStart = `${today.slice(0, 8)}01`;
  const seriesStart = addDays(today, -(days - 1));
  const at = (date: string) => zonedTimeToUtc(date, "00:00", timeZone);
  const from = [weekStart, monthStart, seriesStart].sort()[0]!;
  return { today, weekStart, monthStart, seriesStart, days, since: at(from).toISOString(), weekAt: at(weekStart), monthAt: at(monthStart) };
}

export function computeDriverEarnings(rides: EarningRide[], timeZone: string, commission: number | null, days = 14): DriverEarningsView {
  const w = earningsWindow(timeZone, days);
  const net = (c: number | null) => (commission != null && c != null ? Math.round((c * (100 - commission)) / 100) : 0);
  const empty = (): EarningPeriod => ({ rides: 0, revenue_cents: 0, net_cents: commission != null ? 0 : null, cash_cents: 0, unpriced: 0 });
  const week = empty();
  const month = empty();
  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const byDay = new Map<string, { rides: number; revenue_cents: number }>();

  for (const r of rides) {
    const at = new Date(r.completed_at ?? r.pickup_at);
    const price = r.price_cents ?? 0;
    for (const [p, since] of [[week, w.weekAt], [month, w.monthAt]] as const) {
      if (at < since) continue;
      p.rides += 1;
      p.revenue_cents += price;
      if (p.net_cents != null) p.net_cents += net(r.price_cents);
      if (r.payment_method === "cash") p.cash_cents += price;
      if (r.price_cents == null) p.unpriced += 1;
    }
    const k = dayKey.format(at);
    const cur = byDay.get(k) ?? { rides: 0, revenue_cents: 0 };
    byDay.set(k, { rides: cur.rides + 1, revenue_cents: cur.revenue_cents + price });
  }

  const weekday = new Intl.DateTimeFormat("fr-FR", { weekday: "narrow", timeZone: "UTC" });
  const series = Array.from({ length: days }, (_, i) => {
    const date = addDays(w.seriesStart, i);
    const v = byDay.get(date) ?? { rides: 0, revenue_cents: 0 };
    return { date, label: weekday.format(new Date(`${date}T12:00:00Z`)).toUpperCase(), ...v, today: date === w.today };
  });
  return { commission, week, month, series };
}
