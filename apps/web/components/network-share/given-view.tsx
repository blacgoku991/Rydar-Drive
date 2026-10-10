"use client";
// Sous-onglet « Courses confiées » (A) : trois chiffres (à encaisser, à verser, à vérifier), filtres (Toutes et Réglées
// toujours visibles, comme les onglets d'Encaissements ; les autres puces seulement quand elles comptent quelque chose),
// partenaire, mois et relevé CSV (repliés sur téléphone), puis la liste des courses tenues par des chauffeurs
// partenaires et leurs règlements. Réutilise les éléments d'Encaissements (statut, échéance, moyens) ; données :
// org_network_summary et org_network_given ; temps réel : network.updated et settlement.updated (relecture de la page,
// rien onglet caché).
import {
  NETWORK_GIVEN_FILTERS, formatNumber, formatPrice, formatRideDate, shortAddress,
  type NetworkGivenFilter, type NetworkGivenItem, type OrgNetworkSummary,
} from "@rydar/shared";
import { ArrowDownLeft, ArrowUpRight, CheckCheck, Download, Route, ShieldAlert, Timer } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatCard } from "@/components/layout/page-header";
import { GivenActions } from "@/components/network-share/given-actions";
import { givenProgress, givenRowActions, givenToCheck, suspectText } from "@/components/network-share/given";
import { networkExportHref, networkShareHref, NETWORK_LIST_MAX, NETWORK_LIST_PAGE, NETWORK_SUSPENDED_PATH } from "@/components/network-share/paths";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { useLiveSync } from "@/components/realtime/use-live-sync";
import { OPEN_STATUSES } from "@/components/settlements/settlement-list";
import { DeclarationLine, SettlementBadge, dueInfo, fromNow } from "@/components/settlements/settlement-ui";
import { Badge, toneText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { NativeSelect } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { useNow } from "@/hooks/use-now";
import { plural } from "@/lib/wording";
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
  /**
   * Organisation SUSPENDUE (C12, /suspended/reseau-partage) : décisions d'argent seulement (owner / admin) — ni relance,
   * ni exclusion, ni export, ni lien vers la fiche course (tableau de bord fermé).
   */
  suspended?: boolean;
  /** Réseau fermé par Rydar (sommes en cours) : plus d'exclusion (aucune course n'est plus partagée) */
  closed?: boolean;
};

const EMPTY: Record<NetworkGivenFilter, { title: string; description: string }> = {
  all: {
    title: "Aucune course confiée",
    description: "Quand aucun de vos chauffeurs n'accepte une course, elle peut être proposée aux chauffeurs des organisations partenaires : elle s'affichera ici.",
  },
  in_progress: { title: "Aucune course en cours", description: "Les courses tenues en ce moment par un chauffeur partenaire s'afficheront ici." },
  to_check: { title: "Rien à vérifier", description: "Une fin de course inhabituelle (position absente, durée très courte…) s'affiche ici pour contrôle." },
  to_collect: { title: "Rien à encaisser", description: "La part à vous reverser par les chauffeurs partenaires (courses payées à bord) s'affichera ici jusqu'à son règlement." },
  to_confirm: { title: "Rien à confirmer", description: "Quand un chauffeur partenaire signale « J'ai payé », le paiement attend ici votre « Reçu »." },
  overdue: { title: "Aucun retard", description: "Aucun règlement n'a dépassé son échéance." },
  disputed: { title: "Aucune contestation", description: "Les paiements marqués « Pas reçu » et les courses contestées s'afficheront ici." },
  to_pay: { title: "Rien à verser", description: "Une course déjà payée par votre client crée ici la part à verser au chauffeur partenaire." },
  settled: { title: "Aucune course réglée", description: "Les règlements reçus, versés ou annulés s'afficheront ici." },
};

const CLOSED_EMPTY = "Le réseau partagé est fermé : plus aucune course n'est proposée aux organisations partenaires.";

const NB = " ";

export function GivenView(p: Props) {
  const router = useRouter();
  const now = useNow(30_000) ?? p.serverNow;
  const g = p.summary;
  const { schedule } = useLiveSync(() => router.refresh(), { pollMs: 15_000, maxPollMs: 120_000, livePollMs: 300_000, debounceMs: 450 });
  useRealtimeEvent("network.updated", schedule);
  useRealtimeEvent("settlement.updated", schedule);

  const href = (over: { filter?: string; partner?: string | null; month?: string | null; n?: number }) =>
    networkShareHref(
      {
        tab: "confiees",
        filter: over.filter ?? p.filter,
        partner: "partner" in over ? over.partner : p.partner,
        month: "month" in over ? over.month : p.month,
        n: over.n,
      },
      undefined,
      p.suspended ? NETWORK_SUSPENDED_PATH : undefined,
    );
  const counts: Partial<Record<NetworkGivenFilter, number>> = g
    ? { in_progress: g.in_progress, to_check: g.to_check_count, to_confirm: g.to_confirm_count, overdue: g.overdue_count, disputed: g.disputed_count }
    : {};
  // Puce visible : au-dessus de zéro (nombre, ou montant pour « À encaisser » et « À verser »), ou affichée
  const shown = (key: NetworkGivenFilter) => {
    if (key === p.filter || !g) return true;
    if (key === "to_collect") return g.to_collect_cents > 0;
    if (key === "to_pay") return g.to_pay_cents > 0;
    return (counts[key] ?? 0) > 0;
  };
  const exportMonth = p.month ?? p.months[0]?.value ?? null;
  const excluded = new Set(p.excludedPartners);
  const filtered = !!(p.partner || p.month);

  const filters = (
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-[180px] flex-1 sm:flex-none">
        <span className="sr-only">Partenaire</span>
        <NativeSelect
          value={p.partner ?? ""}
          onChange={(e) => router.push(href({ partner: e.target.value || null }), { scroll: false })}
          aria-label="Filtrer par organisation partenaire"
          className="h-10 text-[13px]"
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
          className="h-10 text-[13px]"
        >
          <option value="">Tous les mois</option>
          {p.months.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </NativeSelect>
      </label>
      {exportMonth && !p.suspended && (
        <Button asChild variant="outline" size="sm" className="max-sm:h-10 sm:ml-auto">
          <a href={networkExportHref({ view: "confiees", month: exportMonth, partner: p.partner })} download>
            <Download /> Relevé {p.months.find((m) => m.value === exportMonth)?.label ?? exportMonth} (CSV)
          </a>
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      {g && (
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-3" aria-label="Indicateurs des courses confiées">
          <StatCard
            label="À encaisser"
            value={formatPrice(g.to_collect_cents, p.currency)}
            sub={
              g.to_confirm_count
                ? plural(g.to_confirm_count, "paiement à confirmer", "paiements à confirmer")
                : g.to_collect_cents > 0
                  ? "part à vous reverser par les chauffeurs partenaires"
                  : "rien à encaisser"
            }
            tone={g.to_confirm_count ? "amber" : undefined}
            href={href({ filter: g.to_confirm_count ? "to_confirm" : "to_collect", n: undefined })}
            active={p.filter === "to_collect" || p.filter === "to_confirm"}
            icon={<ArrowDownLeft />}
          />
          <StatCard
            label="À verser"
            value={formatPrice(g.to_pay_cents, p.currency)}
            tone={g.to_pay_cents > 0 ? "amber" : undefined}
            sub={g.to_pay_cents > 0 ? "courses déjà payées par vos clients" : "rien à verser"}
            href={href({ filter: "to_pay", n: undefined })}
            active={p.filter === "to_pay"}
            icon={<ArrowUpRight />}
          />
          <StatCard
            label="À vérifier"
            value={formatNumber(g.to_check_count)}
            tone={g.to_check_count > 0 ? "amber" : undefined}
            sub={g.to_check_count ? "fins de course à contrôler" : "rien à contrôler"}
            href={href({ filter: "to_check", n: undefined })}
            active={p.filter === "to_check"}
            icon={<ShieldAlert />}
            className="max-lg:col-span-2"
          />
        </section>
      )}

      <section id="courses" className="scroll-mt-6 space-y-3">
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Filtrer les courses confiées">
          {NETWORK_GIVEN_FILTERS.filter((f) => f.key === "all" || f.key === "settled").map((f) => (
            <FilterTab key={f.key} href={href({ filter: f.key, n: undefined })} label={f.label} active={f.key === p.filter} />
          ))}
          {NETWORK_GIVEN_FILTERS.some((f) => f.key !== "all" && f.key !== "settled" && shown(f.key)) && (
            <span aria-hidden className="mx-1 hidden h-5 w-px bg-line sm:block" />
          )}
          {NETWORK_GIVEN_FILTERS.filter((f) => f.key !== "all" && f.key !== "settled" && shown(f.key)).map((f) => (
            <FilterTab
              key={f.key}
              href={href({ filter: f.key, n: undefined })}
              label={f.label}
              count={counts[f.key] ?? null}
              alert={f.key === "overdue" || f.key === "disputed"}
              active={f.key === p.filter}
            />
          ))}
        </div>

        {/* Partenaire, mois, relevé : une ligne sur grand écran, repliée sur téléphone (ouverte si un filtre est actif) */}
        <div className="max-md:hidden">{filters}</div>
        <Disclosure
          title={filtered ? "Filtrer (filtre actif)" : "Filtrer : partenaire, mois, relevé"}
          forceOpen={filtered}
          className="surface rounded-xl md:hidden"
          summaryClassName="px-4"
          contentClassName="border-t border-line px-4 py-3"
        >
          {filters}
        </Disclosure>

        {p.failed ? (
          <Card>
            <EmptyState size="compact" icon={<Route />} title="Courses confiées indisponibles." description="Lecture impossible, réessayez dans un instant." />
          </Card>
        ) : p.items.length === 0 ? (
          <Card>
            <EmptyState
              size="compact"
              icon={<CheckCheck />}
              title={`${EMPTY[p.filter].title}.`}
              // Réseau fermé : plus aucune course ne sera proposée (le texte habituel l'annoncerait)
              description={p.closed && p.filter === "all" ? CLOSED_EMPTY : EMPTY[p.filter].description}
            />
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className={cn("hidden border-b border-line px-5 py-2.5 text-[12px] font-medium text-fg-muted", ROW_GRID)}>
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
                  suspended={p.suspended}
                  closed={p.closed}
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

/** Onglet de filtre (même apparence que les onglets d'Encaissements ; role="tab", sémantique d'origine). */
export function FilterTab({ href, label, count = null, alert = false, active }: { href: string; label: string; count?: number | null; alert?: boolean; active: boolean }) {
  return (
    <Link
      href={href}
      prefetch={false}
      scroll={false}
      role="tab"
      aria-selected={active}
      className={cn(
        "inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[13px] transition-colors sm:h-9",
        active ? "border-line-strong bg-ink-600 font-medium text-fg" : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
      )}
    >
      {label}
      {count != null && count > 0 && (
        <span
          className={cn(
            "min-w-5 rounded-full px-1.5 text-center text-[12px] font-semibold leading-5 tabular-nums",
            alert ? "bg-red/15 text-red" : active ? "bg-white/[0.08] text-fg" : "bg-white/[0.05] text-fg-muted",
          )}
        >
          {count}
        </span>
      )}
    </Link>
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
  suspended,
  closed,
}: {
  item: NetworkGivenItem;
  now: number;
  timeZone: string;
  orgName: string;
  canManage: boolean;
  partnerExcluded: boolean;
  suspended?: boolean;
  closed?: boolean;
}) {
  const e = item.execution;
  const t = e.terms;
  const s = item.settlement;
  const currency = item.ride.currency;
  const owes = t.direction === "driver_owes";
  const base = givenRowActions(item, { canManage, now, partnerExcluded });
  // Organisation suspendue : décisions d'argent seulement (relance, exclusions : organisation active) ; réseau fermé
  // par Rydar : plus d'exclusion (plus aucune course n'est partagée)
  const can = suspended
    ? { ...base, remind: false, excludeDriver: false, excludePartner: false }
    : closed
      ? { ...base, excludeDriver: false, excludePartner: false }
      : base;
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
            {suspended ? (
              <span className="mono shrink-0 font-semibold text-fg">#{item.ride.number}</span>
            ) : (
              <Link href={`/dashboard/rides/${item.ride.id}`} prefetch={false} className="mono shrink-0 font-semibold text-fg hover:text-brand">
                #{item.ride.number}
              </Link>
            )}
            <span className="truncate text-[12px] text-fg-muted">{formatRideDate(at, timeZone, new Date(now))}</span>
          </p>
          <p className="truncate text-[13px] text-fg-muted" title={`${item.ride.pickup_address} → ${item.ride.dropoff_address}`}>
            {shortAddress(item.ride.pickup_address)} → {shortAddress(item.ride.dropoff_address)}
          </p>
        </div>

        <div className="min-w-0">
          <p className="truncate text-[13px]">
            {e.driver_label} <span className="text-fg-muted">· {e.partner.name}</span>
          </p>
          <p className="truncate text-[12px] text-fg-muted">
            {vehicle}
            {e.vehicle.plate ? <span className="mono"> · {e.vehicle.plate}</span> : null}
          </p>
        </div>

        {/* Répartition en phrase (comme Encaissements) : prix, part de l'organisation, part du chauffeur */}
        <p className="min-w-0 text-[12px] leading-[18px] text-fg-muted" title={`Part de ${orgName} · part du chauffeur`}>
          <span className="mono text-fg">{formatPrice(t.price_cents, currency)}</span> = votre part{" "}
          <span className="mono text-fg">{formatPrice(t.giver_cut_cents, currency)}</span> + chauffeur{" "}
          <span className="mono text-fg">{formatPrice(t.driver_payout_cents, currency)}</span>
          {t.platform_fee_cents > 0 && (
            <>
              {" "}
              + plateforme <span className="mono text-fg">{formatPrice(t.platform_fee_cents, currency)}</span>
            </>
          )}
        </p>

        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {live ? (
              <>
                <span className="mono text-[14px] font-semibold text-fg">{formatPrice(live.amount_cents, live.currency)}</span>
                {/* Sens : « à encaisser / à verser » seulement tant que le règlement est ouvert */}
                {OPEN_STATUSES.has(live.status) ? (
                  <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[12px]", owes ? "text-fg-muted" : "text-amber")}>
                    <DirIcon aria-hidden className="size-3" /> {owes ? "à encaisser" : "à verser"}
                  </span>
                ) : (
                  <span className="whitespace-nowrap text-[12px] text-fg-muted">{owes ? "votre part" : "part chauffeur"}</span>
                )}
                {/* « À régler » / « À verser » redirait le sens : badge seulement pour un autre état (ou un retard) */}
                {(live.status !== "due" || live.overdue) && <SettlementBadge settlement={live} />}
              </>
            ) : progress ? (
              <Badge tone={progress.tone}>{progress.label}</Badge>
            ) : null}
            {toCheck && (
              <Badge tone="amber" dot={false}>
                <ShieldAlert className="size-3" /> À vérifier
              </Badge>
            )}
            {e.contested_at && <Badge tone="red">Course contestée</Badge>}
            {e.driver_disputed_at && <Badge tone="red">Le chauffeur conteste</Badge>}
          </div>
          {/* Motifs en clair (lisibles au doigt et au clavier, sans survol) : deux lignes au plus chacun ; le texte entier
              est dans la fiche course et dans la fenêtre « Valider » */}
          {toCheck && <p className="line-clamp-2 text-[12px] text-amber" title={suspectText(item)}>{suspectText(item)}</p>}
          {e.contested_at && e.contested_reason && (
            <p className="line-clamp-2 text-[12px] text-fg-muted [overflow-wrap:anywhere]" title={e.contested_reason}>
              Contestée{NB}: «{NB}{e.contested_reason}{NB}»
            </p>
          )}
          {e.driver_disputed_at && (
            <p className="line-clamp-2 text-[12px] text-fg-muted [overflow-wrap:anywhere]" title={e.driver_dispute_reason ?? undefined}>
              Le chauffeur conteste{e.driver_dispute_reason ? <>{NB}: «{NB}{e.driver_dispute_reason}{NB}»</> : " ce règlement"}
            </p>
          )}
          {s?.status === "declared" ? (
            <DeclarationLine settlement={s} now={now} />
          ) : e.on_hold && e.hold_until ? (
            <p className="flex items-center gap-1.5 text-[12px] text-amber">
              <Timer aria-hidden className="size-3 shrink-0" /> versement retenu, libéré {fromNow(e.hold_until, now)}
            </p>
          ) : due ? (
            <p className={cn("text-[12px]", toneText[due.tone])}>{due.text.replace(/^à verser dans /, "échéance dans ")}</p>
          ) : null}
          {s && !owes && s.status === "due" && s.network?.payout_configured === false && (
            <p className="text-[12px] text-fg-muted">RIB non renseigné par le chauffeur</p>
          )}
          {/* Note du règlement (« Pas reçu », annulation), sauf si c'est le motif de la contestation, déjà affiché */}
          {s && (s.status === "disputed" || s.status === "waived") && s.note && s.note !== e.contested_reason && (
            <p className="truncate text-[12px] text-fg-muted" title={s.note}>«{NB}{s.note}{NB}»</p>
          )}
        </div>

        <GivenActions item={item} can={can} className="xl:flex-nowrap xl:justify-end" />
      </div>
    </li>
  );
}
