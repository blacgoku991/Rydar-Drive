"use client";
// Sous-onglet « Courses confiées » (A) : bande d'indicateurs (à encaisser, à verser, en retard, à vérifier, en cours),
// filtres (état, partenaire, mois), liste des courses tenues par des chauffeurs partenaires et leurs règlements.
// Réutilise les éléments d'Encaissements (indicateurs, statut, échéance, moyens) ; données : org_network_summary et
// org_network_given ; temps réel : network.updated et settlement.updated (relecture de la page, rien onglet caché).
import {
  NETWORK_GIVEN_FILTERS, formatNumber, formatPrice, formatRideDate, shortAddress,
  type NetworkGivenFilter, type NetworkGivenItem, type OrgNetworkSummary,
} from "@rydar/shared";
import { ArrowDownLeft, ArrowUpRight, CheckCheck, Download, Hourglass, Route, ShieldAlert, Timer } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GivenActions } from "@/components/network-share/given-actions";
import { givenProgress, givenRowActions, givenToCheck, suspectText } from "@/components/network-share/given";
import { networkExportHref, networkShareHref, NETWORK_LIST_MAX, NETWORK_LIST_PAGE } from "@/components/network-share/paths";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { useLiveSync } from "@/components/realtime/use-live-sync";
import { DeclarationLine, SettlementBadge, SplitBar, dueInfo, fromNow } from "@/components/settlements/settlement-ui";
import { Kpi } from "@/components/settlements/settlements-view";
import { Badge, toneText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";

type Props = {
  summary: OrgNetworkSummary["given"] | null;
  currency: string;
  items: NetworkGivenItem[];
  filter: NetworkGivenFilter;
  partner: string | null;
  month: string | null;
  limit: number;
  hasMore: boolean;
  /** Organisations déjà rencontrées (network_partner_names), triées par nom */
  partners: { id: string; name: string }[];
  /** Organisations exclues par l'organisation (network_exclusions) */
  excludedPartners: string[];
  months: { value: string; label: string }[];
  canManage: boolean;
  orgName: string;
  timeZone: string;
  serverNow: number;
  failed: boolean;
};

const EMPTY: Record<NetworkGivenFilter, { title: string; description: string }> = {
  all: {
    title: "Aucune course confiée",
    description: "Quand aucun de vos chauffeurs n'accepte une course, elle peut être proposée aux chauffeurs des organisations partenaires : elle s'affichera ici.",
  },
  in_progress: { title: "Aucune course en cours", description: "Les courses tenues en ce moment par un chauffeur partenaire s'afficheront ici." },
  to_check: { title: "Rien à vérifier", description: "Une fin de course inhabituelle (position absente, durée très courte…) s'affiche ici pour contrôle." },
  to_confirm: { title: "Rien à confirmer", description: "Quand un chauffeur partenaire signale « J'ai payé », le paiement attend ici votre « Reçu »." },
  overdue: { title: "Aucun retard", description: "Aucun règlement n'a dépassé son échéance." },
  disputed: { title: "Aucune contestation", description: "Les paiements marqués « Pas reçu » et les courses contestées s'afficheront ici." },
  to_pay: { title: "Rien à verser", description: "Une course déjà payée par votre client crée ici la part à verser au chauffeur partenaire." },
  settled: { title: "Aucun règlement terminé", description: "Les règlements reçus, versés ou annulés s'afficheront ici." },
};

const plural = (n: number, one: string, many: string) => `${formatNumber(n)} ${n > 1 ? many : one}`;

export function GivenView(p: Props) {
  const router = useRouter();
  const now = useNow(30_000) ?? p.serverNow;
  const g = p.summary;
  const { schedule } = useLiveSync(() => router.refresh(), { pollMs: 15_000, maxPollMs: 120_000, livePollMs: 300_000, debounceMs: 450 });
  useRealtimeEvent("network.updated", schedule);
  useRealtimeEvent("settlement.updated", schedule);

  const href = (over: { filter?: string; partner?: string | null; month?: string | null; n?: number }) =>
    networkShareHref({
      tab: "confiees",
      filter: over.filter ?? p.filter,
      partner: "partner" in over ? over.partner : p.partner,
      month: "month" in over ? over.month : p.month,
      n: over.n,
    });
  const counts: Partial<Record<NetworkGivenFilter, number>> = g
    ? { in_progress: g.in_progress, to_check: g.to_check_count, to_confirm: g.to_confirm_count, overdue: g.overdue_count, disputed: g.disputed_count }
    : {};
  const exportMonth = p.month ?? p.months[0]?.value ?? null;
  const excluded = new Set(p.excludedPartners);

  return (
    <div className="space-y-6">
      {g && (
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-5" aria-label="Indicateurs des courses confiées">
          <Kpi
            label="À encaisser"
            value={formatPrice(g.to_collect_cents, p.currency)}
            sub={g.to_confirm_count ? plural(g.to_confirm_count, "paiement à confirmer", "paiements à confirmer") : "reversé par les chauffeurs"}
            href={href({ filter: "to_confirm" })}
            icon={<ArrowDownLeft />}
          />
          <Kpi
            label="À verser"
            value={formatPrice(g.to_pay_cents, p.currency)}
            tone={g.to_pay_cents > 0 ? "violet" : undefined}
            sub="courses déjà payées par vos clients"
            href={href({ filter: "to_pay" })}
            icon={<ArrowUpRight />}
          />
          <Kpi
            label="En retard"
            value={formatPrice(g.overdue_cents, p.currency)}
            tone={g.overdue_count > 0 ? "red" : undefined}
            sub={g.overdue_count ? plural(g.overdue_count, "règlement", "règlements") : "aucun retard"}
            href={href({ filter: "overdue" })}
            icon={<Hourglass />}
          />
          <Kpi
            label="À vérifier"
            value={formatNumber(g.to_check_count)}
            tone={g.to_check_count > 0 ? "amber" : undefined}
            sub={g.to_check_count ? "fins de course à contrôler" : "rien à contrôler"}
            href={href({ filter: "to_check" })}
            icon={<ShieldAlert />}
          />
          <Kpi
            label="En cours"
            value={formatNumber(g.in_progress)}
            sub={g.searching ? plural(g.searching, "course proposée au réseau", "courses proposées au réseau") : "courses tenues par un partenaire"}
            href={href({ filter: "in_progress" })}
            icon={<Route />}
          />
        </section>
      )}

      <section id="courses" className="scroll-mt-6 space-y-3">
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Filtrer les courses confiées">
          {NETWORK_GIVEN_FILTERS.map((f) => {
            const n = counts[f.key];
            const active = f.key === p.filter;
            const alarm = (f.key === "overdue" || f.key === "disputed") && !!n;
            return (
              <Link
                key={f.key}
                href={href({ filter: f.key, n: undefined })}
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
                {!!n && (
                  <span className={cn("mono rounded-md px-1.5 text-[11px] leading-[18px]", alarm ? "bg-red/15 text-red" : active ? "bg-violet/15 text-violet" : "bg-white/[0.06] text-fg-subtle")}>
                    {n}
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[180px] flex-1 sm:flex-none">
            <span className="sr-only">Partenaire</span>
            <NativeSelect
              value={p.partner ?? ""}
              onChange={(e) => router.push(href({ partner: e.target.value || null }), { scroll: false })}
              aria-label="Filtrer par organisation partenaire"
              className="h-9 text-[13px]"
            >
              <option value="">Tous les partenaires</option>
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
              <a href={networkExportHref({ view: "confiees", month: exportMonth, partner: p.partner })} download>
                <Download /> Relevé {p.months.find((m) => m.value === exportMonth)?.label ?? exportMonth} (CSV)
              </a>
            </Button>
          )}
        </div>

        {p.failed ? (
          <Card>
            <EmptyState icon={<Route />} title="Courses confiées indisponibles" description="La lecture a échoué. Réessayez dans un instant." />
          </Card>
        ) : p.items.length === 0 ? (
          <Card>
            <EmptyState icon={<CheckCheck />} title={EMPTY[p.filter].title} description={EMPTY[p.filter].description} />
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className={cn("hidden border-b border-line px-5 py-2.5 text-[12px] font-medium text-fg-subtle", ROW_GRID)}>
              <span>Course</span>
              <span>Chauffeur · organisation</span>
              <span>Montants</span>
              <span>Règlement</span>
              <span className="sr-only">Actions</span>
            </div>
            <ul className="divide-y divide-line">
              {p.items.map((item) => (
                <GivenRow
                  key={item.execution.id}
                  item={item}
                  now={now}
                  timeZone={p.timeZone}
                  orgName={p.orgName}
                  canManage={p.canManage}
                  partnerExcluded={excluded.has(item.execution.partner.id)}
                />
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

// ---------------------------------------------------------------------------- une course confiée
const ROW_GRID =
  "xl:grid xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(200px,auto)] xl:items-center xl:gap-4";

function GivenRow({
  item,
  now,
  timeZone,
  orgName,
  canManage,
  partnerExcluded,
}: {
  item: NetworkGivenItem;
  now: number;
  timeZone: string;
  orgName: string;
  canManage: boolean;
  partnerExcluded: boolean;
}) {
  const e = item.execution;
  const t = e.terms;
  const s = item.settlement;
  const currency = item.ride.currency;
  const owes = t.direction === "driver_owes";
  const can = givenRowActions(item, { canManage, now, partnerExcluded });
  const progress = givenProgress(item);
  const live = s ? { ...s, overdue: s.direction === "driver_owes" && s.status === "due" && Date.parse(s.due_at) <= now } : null;
  const due = live ? dueInfo(live, now, { blockUnpaid: false }) : null;
  const toCheck = givenToCheck(item);
  const DirIcon = owes ? ArrowDownLeft : ArrowUpRight;
  const at = item.ride.completed_at ?? item.ride.pickup_at;
  const vehicle = [e.vehicle.brand, e.vehicle.model].filter(Boolean).join(" ");

  return (
    <li className="px-4 py-3.5 transition-colors hover:bg-white/[0.015] sm:px-5">
      <div className={cn("flex flex-col gap-2.5", ROW_GRID)}>
        <div className="min-w-0">
          <p className="flex min-w-0 items-baseline gap-2 text-[13.5px]">
            <Link href={`/dashboard/rides/${item.ride.id}`} prefetch={false} className="mono shrink-0 font-semibold text-fg hover:text-brand">
              #{item.ride.number}
            </Link>
            <span className="truncate text-[12px] text-fg-subtle">{formatRideDate(at, timeZone, new Date(now))}</span>
          </p>
          <p className="truncate text-[12.5px] text-fg-muted" title={`${item.ride.pickup_address} → ${item.ride.dropoff_address}`}>
            {shortAddress(item.ride.pickup_address)} → {shortAddress(item.ride.dropoff_address)}
          </p>
        </div>

        <div className="min-w-0">
          <p className="truncate text-[13px]">
            {e.driver_label} <span className="text-violet">· {e.partner.name}</span>
          </p>
          <p className="truncate text-[11.5px] text-fg-subtle">
            {vehicle}
            {e.vehicle.plate ? <span className="mono"> · {e.vehicle.plate}</span> : null}
          </p>
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="mono shrink-0 text-[12.5px] text-fg">{formatPrice(t.price_cents, currency)}</span>
            <SplitBar split={{ price: t.price_cents, driver: t.driver_payout_cents, commission: t.commission_cents, platform: t.platform_fee_cents }} className="h-1.5 flex-1" />
          </div>
          <p className="mt-1 text-[11.5px] text-fg-subtle">
            part de {orgName} <span className="mono text-fg-muted">{formatPrice(t.giver_cut_cents, currency)}</span> · chauffeur{" "}
            <span className="mono text-brand">{formatPrice(t.driver_payout_cents, currency)}</span>
          </p>
        </div>

        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {live ? (
              <>
                <span className="mono text-[13.5px] font-semibold text-fg">{formatPrice(live.amount_cents, live.currency)}</span>
                <span className={cn("inline-flex items-center gap-1 text-[11.5px]", owes ? "text-fg-muted" : "text-violet")}>
                  <DirIcon className="size-3" /> {owes ? "à encaisser" : "à verser"}
                </span>
                <SettlementBadge settlement={live} />
              </>
            ) : progress ? (
              <Badge tone={progress.tone}>{progress.label}</Badge>
            ) : null}
            {toCheck && (
              <span title={suspectText(item)}>
                <Badge tone="amber" dot={false}>
                  <ShieldAlert className="size-3" /> À vérifier
                </Badge>
              </span>
            )}
            {e.contested_at && (
              <span title={e.contested_reason ?? undefined}>
                <Badge tone="red">Course contestée</Badge>
              </span>
            )}
            {e.driver_disputed_at && (
              <span title={e.driver_dispute_reason ?? undefined}>
                <Badge tone="red">Le chauffeur conteste</Badge>
              </span>
            )}
          </div>
          {s?.status === "declared" ? (
            <DeclarationLine settlement={s} now={now} />
          ) : e.on_hold && e.hold_until ? (
            <p className="flex items-center gap-1.5 text-[11.5px] text-amber">
              <Timer className="size-3 shrink-0" /> versement retenu, libéré {fromNow(e.hold_until, now)}
            </p>
          ) : due ? (
            <p className={cn("truncate text-[11.5px]", toneText[due.tone])}>{due.text}</p>
          ) : null}
          {s && (s.status === "disputed" || s.status === "waived") && s.note && (
            <p className="truncate text-[11.5px] text-fg-subtle" title={s.note}>« {s.note} »</p>
          )}
        </div>

        <GivenActions item={item} can={can} className="xl:flex-nowrap xl:justify-end" />
      </div>
    </li>
  );
}
