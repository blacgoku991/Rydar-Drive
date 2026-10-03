"use client";
// Sous-onglet « Courses reçues » (B, lecture seule) : courses faites par vos chauffeurs pour d'autres organisations.
// Jamais le client, l'adresse exacte, le commentaire ni le détail de la part de l'organisation qui confie (spec §11.4) ;
// position de vos chauffeurs masquée pendant ces courses (« En course partenaire ({A}) »).
// Données : org_network_received, org_network_activity ; temps réel : network.updated (identifiants seulement).
import {
  NETWORK_RECEIVED_FILTERS, RIDE_STATUS_META, formatPhone, formatPrice, formatRideDate,
  type NetworkReceivedFilter, type NetworkReceivedItem, type OrgNetworkActivity, type OrgNetworkSummary,
} from "@rydar/shared";
import { CalendarClock, Download, Info, Phone, Route, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { networkExportHref, networkShareHref, NETWORK_LIST_MAX, NETWORK_LIST_PAGE } from "@/components/network-share/paths";
import { SETTINGS_ANCHORS } from "@/components/network-share/readiness";
import { receivedMoneyLine, receivedRoute, receivedState, sinceText } from "@/components/network-share/received";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { useLiveSync } from "@/components/realtime/use-live-sync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";

type Props = {
  received: OrgNetworkSummary["received"] | null;
  activity: OrgNetworkActivity | null;
  items: NetworkReceivedItem[];
  filter: NetworkReceivedFilter;
  partner: string | null;
  month: string | null;
  limit: number;
  hasMore: boolean;
  partners: { id: string; name: string }[];
  months: { value: string; label: string }[];
  shareIn: boolean;
  /** Réseau fermé par Rydar (sommes en cours) : ni rappel de la réception, ni lien vers les Réglages */
  closed?: boolean;
  timeZone: string;
  serverNow: number;
  failed: boolean;
};

const EMPTY: Record<NetworkReceivedFilter, { title: string; description: string }> = {
  all: {
    title: "Aucune course reçue",
    description: "Les courses que vos chauffeurs acceptent pour des organisations partenaires s'afficheront ici.",
  },
  in_progress: { title: "Aucune course en cours", description: "Vos chauffeurs ne font aucune course partenaire en ce moment." },
  open: { title: "Aucun règlement en cours", description: "Les montants à reverser ou à recevoir par vos chauffeurs s'afficheront ici." },
  overdue: { title: "Aucun retard", description: "Aucun règlement de vos chauffeurs n'a dépassé son échéance." },
  to_check: { title: "Rien à vérifier", description: "Les courses signalées « à vérifier » par l'organisation qui les confie s'afficheront ici." },
  settled: { title: "Aucun règlement terminé", description: "Les règlements réglés ou annulés s'afficheront ici." },
};

const driverName = (d: { first_name: string; last_name: string }) => `${d.first_name} ${d.last_name}`;

export function ReceivedView(p: Props) {
  const router = useRouter();
  const now = useNow(30_000) ?? p.serverNow;
  const { schedule } = useLiveSync(() => router.refresh(), { pollMs: 15_000, maxPollMs: 120_000, livePollMs: 300_000, debounceMs: 450 });
  useRealtimeEvent("network.updated", schedule);
  useRealtimeEvent("driver.updated", schedule);

  const href = (over: { filter?: string; partner?: string | null; month?: string | null; n?: number }) =>
    networkShareHref({
      tab: "recues",
      filter: over.filter ?? p.filter,
      partner: "partner" in over ? over.partner : p.partner,
      month: "month" in over ? over.month : p.month,
      n: over.n,
    });
  const exportMonth = p.month ?? p.months[0]?.value ?? null;
  const onRide = p.activity?.on_ride ?? [];
  const scheduled = p.activity?.scheduled ?? [];

  return (
    <div className="space-y-6">
      {!p.shareIn && !p.closed && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-white/[0.02] px-4 py-3 text-[13px] text-fg-muted">
          <Info className="size-4 shrink-0 text-fg-subtle" />
          Réception désactivée&nbsp;: vos chauffeurs ne reçoivent plus les courses du réseau. Historique ci-dessous.
          <Link href={networkShareHref({ tab: "reglages" }, SETTINGS_ANCHORS.receive)} prefetch={false} className="text-brand hover:underline">
            Réglages
          </Link>
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            icon={<Route />}
            title="En course partenaire maintenant"
            description="Pendant une course partenaire, la position du chauffeur n'est pas affichée : vous pouvez l'appeler."
          />
          {onRide.length === 0 ? (
            <p className="px-5 py-4 text-[13px] text-fg-muted">Aucun de vos chauffeurs n&apos;est en course partenaire.</p>
          ) : (
            <ul className="divide-y divide-line">
              {onRide.map((r) => (
                <li key={`${r.driver.id}-${r.since}`} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-medium">
                      <Link href={`/dashboard/drivers/${r.driver.id}`} prefetch={false} className="hover:text-brand">
                        {driverName(r.driver)}
                      </Link>{" "}
                      <span className="mono font-normal text-fg-subtle">#{r.driver.number}</span>
                    </p>
                    <p className="truncate text-[12px] text-violet">En course partenaire ({r.giver.name})</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Badge tone={RIDE_STATUS_META[r.phase]?.tone ?? "neutral"}>{RIDE_STATUS_META[r.phase]?.short ?? r.phase}</Badge>
                    <p className="mt-1 text-[11.5px] text-fg-subtle">{sinceText(r.since, now)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader icon={<CalendarClock />} title="Créneaux pris" description="Courses partenaires planifiées : vos chauffeurs ne sont pas disponibles pour vous à ces heures." />
          {scheduled.length === 0 ? (
            <p className="px-5 py-4 text-[13px] text-fg-muted">Aucune course partenaire planifiée.</p>
          ) : (
            <ul className="divide-y divide-line">
              {scheduled.map((r) => (
                <li key={`${r.driver.id}-${r.pickup_at}`} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13.5px] font-medium">
                      {driverName(r.driver)} <span className="mono font-normal text-fg-subtle">#{r.driver.number}</span>
                    </p>
                    <p className="truncate text-[12px] text-fg-muted">pour {r.giver.name}</p>
                  </div>
                  <p className="shrink-0 text-right text-[12.5px] text-fg">{formatRideDate(r.pickup_at, p.timeZone, new Date(now))}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-[16px] font-semibold tracking-tight">Courses de vos chauffeurs pour d&apos;autres organisations</h2>
            <p className="mt-0.5 max-w-3xl text-[12.5px] text-fg-muted">
              Vous voyez les communes, le chauffeur, le prix et sa part. Le client et l&apos;adresse exacte restent chez l&apos;organisation qui
              confie la course&nbsp;: pour un incident (amende, sinistre, objet perdu), demandez-lui les faits précis.
            </p>
          </div>
        </div>

        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Filtrer les courses reçues">
          {NETWORK_RECEIVED_FILTERS.map((f) => {
            const active = f.key === p.filter;
            const n = f.key === "in_progress" ? (p.received?.in_progress ?? 0) : 0;
            return (
              <Link
                key={f.key}
                href={href({ filter: f.key })}
                prefetch={false}
                scroll={false}
                role="tab"
                aria-selected={active}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium transition-colors",
                  active ? "bg-white/[0.08] text-fg" : "text-fg-muted hover:bg-white/[0.04] hover:text-fg",
                )}
              >
                {f.label}
                {!!n && <span className="mono rounded-md bg-violet/15 px-1.5 text-[11px] leading-[18px] text-violet">{n}</span>}
              </Link>
            );
          })}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[180px] flex-1 sm:flex-none">
            <span className="sr-only">Organisation qui confie</span>
            <NativeSelect
              value={p.partner ?? ""}
              onChange={(e) => router.push(href({ partner: e.target.value || null }), { scroll: false })}
              aria-label="Filtrer par organisation qui confie"
              className="h-9 text-[13px]"
            >
              <option value="">Toutes les organisations</option>
              {p.partners.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </NativeSelect>
          </label>
          <label className="min-w-[160px] flex-1 sm:flex-none">
            <span className="sr-only">Mois</span>
            <NativeSelect
              value={p.month ?? ""}
              onChange={(e) => router.push(href({ month: e.target.value || null }), { scroll: false })}
              aria-label="Filtrer par mois"
              className="h-9 text-[13px]"
            >
              <option value="">Tous les mois</option>
              {p.months.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </NativeSelect>
          </label>
          {exportMonth && (
            <Button asChild variant="outline" size="sm" className="ml-auto">
              <a href={networkExportHref({ view: "recues", month: exportMonth, partner: p.partner })} download>
                <Download /> Relevé {p.months.find((m) => m.value === exportMonth)?.label ?? exportMonth} (CSV)
              </a>
            </Button>
          )}
        </div>

        {p.failed ? (
          <Card>
            <EmptyState icon={<Route />} title="Courses reçues indisponibles" description="La lecture a échoué. Réessayez dans un instant." />
          </Card>
        ) : p.items.length === 0 ? (
          <Card>
            <EmptyState icon={<Route />} title={EMPTY[p.filter].title} description={EMPTY[p.filter].description} />
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className={cn("hidden border-b border-line px-5 py-2.5 text-[12px] font-medium text-fg-subtle", ROW_GRID)}>
              <span>Course</span>
              <span>Chauffeur</span>
              <span>Organisation qui confie</span>
              <span>Montants</span>
              <span>Règlement</span>
            </div>
            <ul className="divide-y divide-line">
              {p.items.map((item) => (
                <ReceivedRow key={item.execution_id} item={item} now={now} timeZone={p.timeZone} />
              ))}
            </ul>
          </Card>
        )}

        {p.hasMore && (
          <div className="flex justify-center">
            <Button asChild variant="outline" size="sm">
              <Link href={href({ n: Math.min(NETWORK_LIST_MAX, p.limit + NETWORK_LIST_PAGE) })} scroll={false} prefetch={false}>
                Afficher plus
              </Link>
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

const ROW_GRID =
  "xl:grid xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.1fr)] xl:items-center xl:gap-4";

function ReceivedRow({ item, now, timeZone }: { item: NetworkReceivedItem; now: number; timeZone: string }) {
  const state = receivedState(item);
  const at = item.ride.completed_at ?? item.ride.pickup_at;
  const m = item.money;
  return (
    <li className="px-4 py-3.5 sm:px-5">
      <div className={cn("flex flex-col gap-2.5", ROW_GRID)}>
        <div className="min-w-0">
          <p className="flex min-w-0 items-baseline gap-2 text-[13.5px]">
            <span className="mono shrink-0 font-semibold text-fg">{item.reference}</span>
            <span className="truncate text-[12px] text-fg-subtle">{formatRideDate(at, timeZone, new Date(now))}</span>
          </p>
          <p className="truncate text-[12.5px] text-fg-muted">{receivedRoute(item)}</p>
        </div>
        <div className="min-w-0">
          <p className="truncate text-[13px]">
            {item.driver ? (
              <Link href={`/dashboard/drivers/${item.driver.id}`} prefetch={false} className="hover:text-brand">
                {driverName(item.driver)} <span className="mono text-fg-subtle">#{item.driver.number}</span>
              </Link>
            ) : (
              <span className="text-fg-muted">Chauffeur supprimé</span>
            )}
          </p>
          <p className="mono truncate text-[11.5px] text-fg-subtle">{item.vehicle.plate}</p>
        </div>
        <div className="min-w-0">
          <p className="truncate text-[13px] text-violet">{item.giver.name}</p>
          {item.giver.phone && (
            <a href={`tel:${item.giver.phone}`} className="mono inline-flex items-center gap-1 text-[11.5px] text-fg-subtle hover:text-fg">
              <Phone className="size-3" /> {formatPhone(item.giver.phone)}
            </a>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-[12.5px]">
            <span className="mono text-fg">{formatPrice(m.price_cents, m.currency)}</span>
            <span className="text-fg-subtle"> · part du chauffeur </span>
            <span className="mono text-brand">{formatPrice(m.driver_part_cents, m.currency)}</span>
          </p>
          <p className="truncate text-[11.5px] text-fg-subtle" title={receivedMoneyLine(item)}>{receivedMoneyLine(item)}</p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge tone={state.tone}>{state.label}</Badge>
          {item.to_check && (
            <Badge tone="amber" dot={false}>
              <ShieldAlert className="size-3" /> À vérifier
            </Badge>
          )}
          {item.contested && <Badge tone="red">Course contestée</Badge>}
          {item.settlement?.driver_disputed && <Badge tone="red">Le chauffeur conteste</Badge>}
        </div>
      </div>
    </li>
  );
}
