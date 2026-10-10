import "server-only";
// Flotte Privée, Accueil (/dashboard, docs/FLOTTE-PRIVEE.md § 7.3) : lectures RLS de membre, en parallèle — fiche du
// propriétaire, réservations à traiter, prochaines courses et journée, chiffres du mois, clé du site, « Premiers pas ».
import { addDays, localIsoDay, zonedTimeToUtc, type PaymentMethod, type PricingRule } from "@rydar/shared";
import type { DocumentRow } from "@/components/drivers/documents";
import { DOCUMENT_COLUMNS, buildDocumentView } from "@/components/drivers/documents";
import { UPCOMING_STATUSES } from "@/components/private-fleet/booking-meta";
import { pendingFirstSteps, type FirstStep } from "@/components/private-fleet/first-steps";
import { BOOKING_COLUMNS, OFFER_EMBED, isToTreat, loadBookingQueue, sortQueue, toBooking, type Booking, type BookingRow } from "@/components/private-fleet/queue";
import { siteLink, type SiteKeyRow, type SiteLink } from "@/components/private-fleet/site-status";
import type { requireOrg } from "@/lib/auth";
import { getPricing } from "@/lib/queries/pricing";
import { statsPeriodStart } from "@/lib/stats-period";

type OrgCtx = Awaited<ReturnType<typeof requireOrg>>;

export type HomeDriver = {
  id: string;
  first_name: string;
  last_name: string;
  status: "invited" | "active" | "inactive" | "suspended";
  presence: "offline" | "available" | "offered" | "en_route" | "arrived" | "on_trip";
  last_seen_at: string | null;
};

export type PrivateHomeData = {
  timeZone: string;
  today: string;
  /** Prénom de l'en-tête (fiche, sinon nom du compte) */
  firstName: string;
  driver: HomeDriver | null;
  driverId: string | null;
  /** null : lecture impossible (bloc signalé) */
  queue: Booking[] | null;
  upcoming: Booking[];
  todayRides: Booking[];
  month: { siteBookings: number; completed: number; revenueCents: number; averageCents: number | null };
  site: SiteLink & { lastBooking: { id: string; number: number; created_at: string } | null };
  firstSteps: FirstStep[] | null;
  pricing: PricingRule[];
  defaultPayment: PaymentMethod;
};

const KEY_COLUMNS = "id, name, prefix, last4, scopes, allowed_origins, created_at, last_used_at, expires_at, revoked_at";

export async function loadPrivateHome(ctx: OrgCtx): Promise<PrivateHomeData> {
  const now = Date.now();
  const orgId = ctx.org.id;
  const tz = ctx.org.timezone || "Europe/Paris";
  const today = localIsoDay(new Date(now), tz);
  const dayStart = zonedTimeToUtc(today, "00:00", tz).toISOString();
  const dayEnd = zonedTimeToUtc(addDays(today, 1), "00:00", tz).toISOString();
  const monthStart = statsPeriodStart(new Date(now), "mtd", tz).toISOString();
  const driverId = ctx.driverId;
  const db = ctx.supabase;

  const [driverRes, queue, upcomingRes, todayRes, completedRes, siteCountRes, keysRes, lastApiRes, orgRes, docsRes, pricing, settingsRes] = await Promise.all([
    driverId
      ? db.from("drivers").select("id, first_name, last_name, status, presence, last_seen_at").eq("id", driverId).maybeSingle()
      : Promise.resolve({ data: null }),
    loadBookingQueue(db, orgId, driverId, { now }),
    db
      .from("rides")
      .select(BOOKING_COLUMNS)
      .eq("organization_id", orgId)
      .not("driver_id", "is", null)
      .in("status", [...UPCOMING_STATUSES])
      .order("pickup_at", { ascending: true })
      .limit(5),
    db
      .from("rides")
      .select(`${BOOKING_COLUMNS}, ${OFFER_EMBED}`)
      .eq("organization_id", orgId)
      .gte("pickup_at", dayStart)
      .lt("pickup_at", dayEnd)
      .order("pickup_at", { ascending: true })
      .limit(50),
    // Chiffres du mois (fuseau de l'organisation) : courses terminées et leurs prix
    db.from("rides").select("price_cents").eq("organization_id", orgId).eq("status", "COMPLETED").gte("pickup_at", monthStart).limit(5000),
    // Réservations reçues de son site ce mois-ci
    db.from("rides").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("source", "api").gte("created_at", monthStart),
    // Clés du site (RLS : owner / admin ; gérées par l'équipe Rydar, lecture seule)
    db.from("api_keys").select(KEY_COLUMNS).eq("organization_id", orgId).order("created_at", { ascending: false }),
    db.from("rides").select("id, number, created_at").eq("organization_id", orgId).eq("source", "api").order("created_at", { ascending: false }).limit(1),
    db.from("organizations").select("legal_name, siret, vtc_registration").eq("id", orgId).maybeSingle(),
    driverId ? db.from("driver_documents").select(DOCUMENT_COLUMNS).eq("organization_id", orgId).eq("driver_id", driverId) : Promise.resolve({ data: [] }),
    getPricing(db, orgId),
    db.from("organization_settings").select("default_payment_method").eq("organization_id", orgId).maybeSingle(),
  ]);

  const driver = (driverRes.data ?? null) as HomeDriver | null;
  const toBookings = (rows: unknown) => ((rows ?? []) as BookingRow[]).map((r) => toBooking(r, driverId, now));
  const prices = ((completedRes.data ?? []) as { price_cents: number | null }[]).map((r) => r.price_cents).filter((p): p is number => p != null);
  const completed = (completedRes.data ?? []).length;
  const revenueCents = prices.reduce((a, b) => a + b, 0);
  const keys = (keysRes.data ?? []) as SiteKeyRow[];
  const link = siteLink(keys, [], now);
  const lastBooking = ((lastApiRes.data ?? []) as { id: string; number: number; created_at: string }[])[0] ?? null;
  const docs = buildDocumentView((docsRes.data ?? []) as unknown as DocumentRow[], tz).items;
  const docValid = (type: string) => docs.some((d) => d.type === type && (d.status === "valid" || d.status === "expiring"));

  return {
    timeZone: tz,
    today,
    firstName: driver?.first_name || (ctx.profile.full_name ?? "").trim().split(/\s+/)[0] || "",
    driver,
    driverId,
    queue: queue ? sortQueue(queue.filter(isToTreat)) : null,
    upcoming: toBookings(upcomingRes.data),
    todayRides: toBookings(todayRes.data),
    month: { siteBookings: siteCountRes.count ?? 0, completed, revenueCents, averageCents: prices.length ? Math.round(revenueCents / prices.length) : null },
    site: { ...link, lastBooking },
    firstSteps: pendingFirstSteps({
      org: (orgRes.data ?? null) as { legal_name: string | null; siret: string | null; vtc_registration: string | null } | null,
      activePricingRules: pricing.length,
      vtcCardValid: docValid("vtc_card"),
      insuranceValid: docValid("insurance"),
      appSeenAt: driver?.last_seen_at ?? null,
      siteKeyActive: link.linked,
      siteBookings: lastBooking ? 1 : 0,
    }),
    pricing,
    defaultPayment: ((settingsRes.data as { default_payment_method?: PaymentMethod } | null)?.default_payment_method ?? "card") as PaymentMethod,
  };
}
