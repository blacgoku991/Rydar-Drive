import { VEHICLE_CATEGORY_META, formatDate, formatNumber, formatRelative, formatRideDate, formatTime, shortAddress, type VehicleCategory } from "@rydar/shared";
import { CircleAlert, Route } from "lucide-react";
import type { Metadata } from "next";
import { SupervisionTabs } from "@/components/admin/supervision-tabs";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { toneDot, toneText } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FilterTabs } from "@/components/ui/filter-tabs";
import { EmptyState } from "@/components/ui/misc";
import { requireSuperAdmin } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { dispatchLevel, groupRepeats, plural } from "@/lib/wording";

export const metadata: Metadata = { title: "Dispatch & erreurs" };
export const dynamic = "force-dynamic";

/** Alertes lues, les plus récentes d'abord (regroupées ensuite) ; courses sans chauffeur lues. */
const EVENTS_LIMIT = 150;
const NO_DRIVER_LIMIT = 60;

type DispatchEvent = { id: number; organization_id: string; level: string; type: string; message: string; created_at: string };
type NoDriverRide = {
  id: string;
  organization_id: string;
  number: number;
  pickup_address: string;
  dropoff_address: string;
  pickup_at: string | null;
  vehicle_category: string;
};

const dateTime = (d: string) => `${formatDate(d)} à ${formatTime(d)}`;
/** Texte lu par les lecteurs d'écran seulement, sans position absolue (dans une zone qui défile). */
const hidden = "-m-px inline-block size-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]";

/**
 * Supervision › Dispatch & erreurs (docs/REFONTE-PANELS.md, R6) : alertes du dispatch de tous les clients sur 7 jours,
 * en français (niveau en mots, messages identiques qui se suivent regroupés : « … × 6 »), filtre « Erreurs seulement »
 * (?niveau=erreurs), et courses restées sans chauffeur. Lignes empilées sur téléphone, en colonnes à partir de md.
 */
export default async function AdminDispatchPage({ searchParams }: { searchParams: Promise<{ niveau?: string | string[] }> }) {
  const session = await requireSuperAdmin();
  const { niveau } = await searchParams;
  const errorsOnly = niveau === "erreurs";
  const db = session.supabase;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const levels: ("warning" | "error")[] = errorsOnly ? ["error"] : ["warning", "error"];
  // Comptages exacts côté base (index partiel ride_events_level_idx) : jamais déduits d'une liste tronquée
  const count = (lv: ("warning" | "error")[]) => db.from("ride_events").select("id", { count: "exact", head: true }).in("level", lv).gte("created_at", since);
  const [eventsRes, allCount, errorCount, noDriverRes, { data: orgs }] = await Promise.all([
    db
      .from("ride_events")
      .select("id, organization_id, level, type, message, created_at")
      .in("level", levels)
      .gte("created_at", since)
      .order("id", { ascending: false })
      .limit(EVENTS_LIMIT),
    count(["warning", "error"]),
    count(["error"]),
    db
      .from("rides")
      .select("id, organization_id, number, pickup_address, dropoff_address, pickup_at, vehicle_category")
      .eq("status", "NO_DRIVER_FOUND")
      .gte("no_driver_at", since)
      .order("no_driver_at", { ascending: false })
      .limit(NO_DRIVER_LIMIT),
    db.from("organizations").select("id, name"),
  ]);
  const name = new Map(((orgs ?? []) as { id: string; name: string }[]).map((o) => [o.id, o.name]));
  const clientName = (id: string) => name.get(id) ?? "Client inconnu";
  /** Nombre exact, ou null si le comptage a échoué (rien d'affiché, jamais un faux 0). */
  const n = (r: { count: number | null; error: unknown }) => (r.error ? null : (r.count ?? 0));
  const total = n(allCount);
  const errors = n(errorCount);
  const shownTotal = errorsOnly ? errors : total;
  const events = (eventsRes.data ?? []) as DispatchEvent[];
  // Même client, même niveau, même type, même message, à la suite : une ligne « × N » (heure de la plus récente)
  const groups = groupRepeats(events, (e) => `${e.organization_id}|${e.level}|${e.type}|${e.message}`);
  const noDriver = (noDriverRes.data ?? []) as NoDriverRide[];

  const eventsDescription =
    shownTotal === null
      ? "7 derniers jours"
      : `${errorsOnly ? plural(shownTotal, "erreur") : plural(shownTotal, "alerte")} sur 7 jours${
          shownTotal > EVENTS_LIMIT ? ` (les ${formatNumber(EVENTS_LIMIT)} plus récentes)` : ""
        }${groups.length < events.length ? "\u00a0; messages identiques regroupés" : ""}.`;

  return (
    <>
      <PageHeader title="Dispatch & erreurs" description="Tous les clients, sur les 7 derniers jours.">
        <SupervisionTabs current="dispatch" />
      </PageHeader>
      <PageBody className="grid items-start gap-6 xl:grid-cols-[1.2fr_1fr]">
        <Card className="overflow-hidden">
          <CardHeader
            icon={<CircleAlert />}
            title="Alertes du dispatch"
            description={eventsDescription}
            action={
              <FilterTabs
                label="Filtrer les alertes"
                items={[
                  {
                    href: "/admin/dispatch",
                    label: "Toutes",
                    active: !errorsOnly,
                    count: total,
                    countLabel: total === null ? undefined : plural(total, "alerte"),
                  },
                  {
                    href: "/admin/dispatch?niveau=erreurs",
                    label: "Erreurs seulement",
                    active: errorsOnly,
                    count: errors,
                    alert: true,
                    countLabel: errors === null ? undefined : plural(errors, "erreur"),
                  },
                ]}
              />
            }
          />
          {eventsRes.error ? (
            <CardBody className="text-[13px] text-fg-muted">Lecture impossible, réessayez dans un instant.</CardBody>
          ) : groups.length === 0 ? (
            <EmptyState
              size="compact"
              title={errorsOnly ? "Aucune erreur." : "Aucune alerte."}
              description="Rien à signaler sur les 7 derniers jours."
            />
          ) : (
            // Zone défilante atteignable au clavier (flèches) et nommée (WCAG 2.1.1) : la région est un div qui CONTIENT la
            // liste (jamais <ul role="region"> : la liste disparaîtrait et ses <li> seraient orphelins, WCAG 1.3.1)
            // Colonnes seulement quand la carte est assez large (requête de conteneur, posée sur la zone : la carte partage
            // la page en deux sur un grand écran) ; sinon, lignes empilées
            <div className="@container max-h-[70vh] overflow-y-auto" tabIndex={0} role="region" aria-label="Alertes du dispatch">
              <ul className="divide-y divide-line">
                {groups.map(({ item: e, count: times }) => {
                  const level = dispatchLevel(e.level);
                  return (
                    <li
                      key={e.id}
                      className="flex flex-wrap items-baseline gap-x-1.5 px-5 py-2.5 text-[12px] text-fg-muted @2xl:grid @2xl:grid-cols-[96px_minmax(0,150px)_88px_minmax(0,1fr)] @2xl:gap-x-3"
                    >
                      {/* Carte étroite : le message d'abord, puis « heure · client · niveau » ; carte large : en colonnes */}
                      <p className="mb-0.5 w-full text-[13px] text-fg [overflow-wrap:anywhere] @2xl:order-4 @2xl:mb-0 @2xl:w-auto">
                        {e.message}
                        {times > 1 && (
                          <span className="num ml-1.5 whitespace-nowrap text-fg-muted">
                            <span aria-hidden>× {formatNumber(times)}</span>
                            <span className={hidden}> ({formatNumber(times)} fois de suite)</span>
                          </span>
                        )}
                      </p>
                      <span className="whitespace-nowrap @2xl:order-1" title={dateTime(e.created_at)}>
                        {formatRelative(e.created_at)}
                      </span>
                      <span aria-hidden className="@2xl:hidden">
                        ·
                      </span>
                      <span className="min-w-0 @2xl:order-2 @2xl:truncate" title={clientName(e.organization_id)}>
                        {clientName(e.organization_id)}
                      </span>
                      <span aria-hidden className="@2xl:hidden">
                        ·
                      </span>
                      <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap @2xl:order-3", toneText[level.tone])}>
                        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", toneDot[level.tone])} />
                        {level.label}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader
            icon={<Route />}
            title="Courses sans chauffeur"
            description={
              noDriverRes.error
                ? "À analyser\u00a0: couverture de flotte, catégories, horaires."
                : `${plural(noDriver.length, "course")} sur 7 jours${noDriver.length >= NO_DRIVER_LIMIT ? ` (les ${formatNumber(NO_DRIVER_LIMIT)} plus récentes)` : ""}, à analyser\u00a0: couverture de flotte, catégories, horaires.`
            }
          />
          {noDriverRes.error ? (
            <CardBody className="text-[13px] text-fg-muted">Lecture impossible, réessayez dans un instant.</CardBody>
          ) : noDriver.length === 0 ? (
            <EmptyState size="compact" title="Aucune course sans chauffeur." description="Toutes les courses des 7 derniers jours ont trouvé un chauffeur." />
          ) : (
            <div className="max-h-[70vh] overflow-y-auto" tabIndex={0} role="region" aria-label="Courses sans chauffeur">
              <ul className="divide-y divide-line">
                {noDriver.map((r) => (
                  <li key={r.id} className="px-5 py-2.5 text-[13px]">
                    <p className="[overflow-wrap:anywhere]">
                      <span className="num font-semibold">#{r.number}</span> · {shortAddress(r.pickup_address)} → {shortAddress(r.dropoff_address)}
                    </p>
                    <p className="mt-0.5 text-[12px] text-fg-muted">
                      {clientName(r.organization_id)} · {formatRideDate(r.pickup_at)} ·{" "}
                      {VEHICLE_CATEGORY_META[r.vehicle_category as VehicleCategory]?.label ?? "Catégorie inconnue"}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </PageBody>
    </>
  );
}
