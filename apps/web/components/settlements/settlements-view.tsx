"use client";
// Page « Encaissements » (mode centrale) : quatre chiffres dans l'ordre d'action (à confirmer, en retard, à encaisser, à
// verser), une ligne « Ce mois-ci », puis « Règlements » en deux vues : « Par course » (onglets À traiter · Réglés ·
// Annulés · Tous, puces À confirmer / En retard / Contestés / À verser quand elles comptent quelque chose) et « Par
// chauffeur » (ce que chacun doit ou attend, relance, WhatsApp ; un chauffeur ouvre ses règlements, ?driver=…).
// Les chiffres viennent de org_settlement_overview / org_settlements ; toute décision passe par une RPC (Reçu, Pas reçu,
// Versé, Annuler, Rouvrir, Relancer) puis la page est relue. Temps réel : settlement.updated.
// Chaque règlement est rendu une seule fois (ligne de tableau sur grand écran, carte en dessous : même balisage).
// Liens sans préchargement : pages dynamiques sans loading.js, le préchargement ne rapportait que la mise en page et
// repartait (onglets, réglages, relevé…) à chaque relecture de la page.
import {
  DRIVER_BLOCKER_META, formatPhone, formatPrice, formatRideDate, shortAddress, splitSummary,
  type DriverBlocker, type OrgSettlementDriver, type OrgSettlementFilter, type OrgSettlementItem, type OrgSettlementOverview,
} from "@rydar/shared";
import { ArrowDownLeft, ArrowUpRight, BellRing, CheckCheck, Funnel, HandCoins, Hourglass, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { confirmSettlements } from "@/app/dashboard/settlements/actions";
import { StatCard } from "@/components/layout/page-header";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { useLiveSync } from "@/components/realtime/use-live-sync";
import { useCentrale } from "@/components/settlements/centrale-context";
import {
  OPEN_STATUSES, SETTLEMENT_MAX, SETTLEMENT_PAGE, carrySelection, lateNow, sortOpen, type OpenSettlement,
} from "@/components/settlements/settlement-list";
import {
  DeclarationLine, METHOD_ICON, METHOD_ORDER, SettlementActions, SettlementBadge, WhatsAppButton, batchReference, buildSettlementWhatsApp,
  dueInfo, fromNow, methodLabel, rideNumberOf, useRemindDriver, useSettlementRunner, type ConfirmMethod,
} from "@/components/settlements/settlement-ui";
import { Badge, toneText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Avatar, EmptyState, Tooltip } from "@/components/ui/misc";
import { useNow } from "@/hooks/use-now";
import { plural } from "@/lib/wording";
import { cn } from "@/lib/utils";

const NB = " ";

type Props = {
  overview: OrgSettlementOverview;
  /** Tous les règlements ouverts, en version compacte (compteurs des onglets, messages WhatsApp) */
  openIndex: OpenSettlement[];
  /** Liste affichée (onglet + chauffeur) */
  items: OrgSettlementItem[];
  filter: OrgSettlementFilter;
  driverId: string | null;
  limit: number;
  /** D'autres règlements suivent (« Afficher plus ») */
  hasMore: boolean;
  orgName: string;
  timeZone: string;
  canManage: boolean;
  /** Horloge du rendu serveur (libellés relatifs identiques à l'hydratation) */
  serverNow: number;
};

/** Onglets (toujours visibles) ; mêmes clés d'URL qu'avant (« Réglés » = paid). */
const TABS: { key: OrgSettlementFilter; label: string }[] = [
  { key: "open", label: "À traiter" },
  { key: "paid", label: "Réglés" },
  { key: "waived", label: "Annulés" },
  { key: "all", label: "Tous" },
];
/** Puces : sous-ensembles de « À traiter », visibles seulement s'ils comptent quelque chose (ou s'ils sont affichés). */
const CHIPS: { key: OrgSettlementFilter; label: string; alert?: boolean }[] = [
  { key: "declared", label: "À confirmer" },
  { key: "overdue", label: "En retard", alert: true },
  { key: "disputed", label: "Contestés", alert: true },
  { key: "to_pay", label: "À verser" },
];

const EMPTY: Record<OrgSettlementFilter, { title: string; description: string }> = {
  open: { title: "Tout est réglé.", description: "Les commissions à encaisser et les parts à verser apparaîtront ici à la fin de chaque course." },
  declared: { title: "Rien à confirmer.", description: "Quand un chauffeur signale « J'ai payé », le paiement attend ici votre « Reçu »." },
  overdue: { title: "Aucun retard.", description: "Aucune commission n'a dépassé son échéance." },
  disputed: { title: "Aucune contestation.", description: "Les paiements marqués « Pas reçu » s'afficheront ici." },
  to_pay: { title: "Rien à verser.", description: "Les courses payées à la centrale (en ligne, facture) créent ici la part à verser au chauffeur." },
  paid: { title: "Aucun règlement réglé.", description: "Les commissions encaissées et les parts versées s'afficheront ici." },
  waived: { title: "Aucune annulation.", description: "Les commissions et versements annulés (geste commercial, litige) s'afficheront ici." },
  all: { title: "Aucun règlement.", description: "Les règlements sont créés automatiquement à la fin des courses." },
};

const isOpen = (s: OrgSettlementItem) => OPEN_STATUSES.has(s.status);
const owesNow = (s: Pick<OrgSettlementItem, "direction" | "status">) => s.direction === "driver_owes" && (s.status === "due" || s.status === "disputed");

function href(filter: OrgSettlementFilter, driver: string | null, n?: number) {
  const p = new URLSearchParams();
  if (filter !== "open") p.set("filter", filter);
  if (driver) p.set("driver", driver);
  if (n) p.set("n", String(n));
  const q = p.toString();
  return `/dashboard/settlements${q ? `?${q}` : ""}#reglements`;
}

const driverName = (d: { first_name: string; last_name: string }) => `${d.first_name} ${d.last_name}`;

// ---------------------------------------------------------------------------- vue
export function SettlementsView({ overview, openIndex, items, filter, driverId, limit, hasMore, orgName, timeZone, canManage, serverNow }: Props) {
  const router = useRouter();
  const now = useNow(30_000) ?? serverNow;
  const t = overview.totals;
  const m = overview.month;
  const currency = overview.currency || "EUR";
  const settings = overview.settings;
  const centrale = useCentrale();
  const [view, setView] = useState<"rides" | "drivers">("rides");

  // Relecture à chaque règlement créé / déclaré / confirmé (ici ou ailleurs), différée si l'onglet est caché ; sans
  // temps réel, sondage 15 s → 45 s → 2 min (en pause onglet caché) ; avec, relecture de sécurité toutes les 5 min
  // (diffusion perdue sans coupure du canal)
  const { schedule } = useLiveSync(() => router.refresh(), { pollMs: 15_000, maxPollMs: 120_000, livePollMs: 300_000, debounceMs: 450 });
  useRealtimeEvent("settlement.updated", schedule);
  // Carte « Frais Rydar » en tête de page (owner / admin) : paiement, relance, frais par course changés, hausse
  // annoncée ou annulée (« platform.updated », identifiants seulement : la page relue contrôle le rôle)
  useRealtimeEvent("platform.updated", () => canManage && schedule());
  // Une commission passe « en retard » à son échéance, sans événement : montants « En retard » relus à ce moment-là
  const nextDue = useMemo(() => {
    let next = Infinity;
    for (const s of openIndex) {
      const t = Date.parse(s.due_at);
      if (s.direction === "driver_owes" && s.status === "due" && t > now && t < next) next = t;
    }
    return next;
  }, [openIndex, now]);
  const scheduleRef = useRef(schedule);
  scheduleRef.current = schedule;
  const lastDueSync = useRef(0);
  useEffect(() => {
    if (!Number.isFinite(nextDue)) return;
    // au plus une relecture par minute si plusieurs échéances se suivent de près
    const delay = Math.max(nextDue - Date.now() + 1000, lastDueSync.current + 60_000 - Date.now());
    const id = window.setTimeout(() => {
      lastDueSync.current = Date.now();
      scheduleRef.current();
    }, Math.min(delay, 2 ** 31 - 1));
    return () => window.clearTimeout(id);
  }, [nextDue]);

  const scoped = useMemo(() => (driverId ? openIndex.filter((s) => s.driver_id === driverId) : openIndex), [openIndex, driverId]);
  const counts: Partial<Record<OrgSettlementFilter, number>> = useMemo(
    () => ({
      open: scoped.length,
      declared: scoped.filter((s) => s.status === "declared").length,
      overdue: scoped.filter((s) => lateNow(s, now)).length,
      disputed: scoped.filter((s) => s.status === "disputed").length,
      to_pay: scoped.filter((s) => s.direction === "centrale_owes" && s.status === "due").length,
    }),
    [scoped, now],
  );
  // Chiffres de la page (tous chauffeurs)
  const all = useMemo(
    () => ({
      commissions: openIndex.filter((s) => s.direction === "driver_owes").length,
      overdue: openIndex.filter((s) => lateNow(s, now)).length,
      toPay: openIndex.filter((s) => s.direction === "centrale_owes" && s.status === "due").length,
    }),
    [openIndex, now],
  );

  const list = useMemo(() => {
    if (filter !== "open") return items;
    return sortOpen(items, now);
  }, [items, filter, now]);

  // Lignes cochées sorties de la page affichée : gardées tant qu'elles restent ouvertes (voir carrySelection)
  const openById = useMemo(() => new Map(openIndex.map((s) => [s.id, s])), [openIndex]);

  // Réclamation WhatsApp par chauffeur : tout ce qui est à régler (à régler + contesté), comme l'app chauffeur
  const owedByDriver = useMemo(() => {
    const map = new Map<string, OpenSettlement[]>();
    for (const s of openIndex) {
      if (!s.driver_id || !owesNow(s)) continue;
      map.set(s.driver_id, [...(map.get(s.driver_id) ?? []), s]);
    }
    return map;
  }, [openIndex]);
  const whatsappFor = (d: { driver_id: string; number: number; first_name: string; phone: string }) => {
    const owed = owedByDriver.get(d.driver_id) ?? [];
    const amount = owed.reduce((n, s) => n + s.amount_cents, 0);
    if (!amount) return null;
    return buildSettlementWhatsApp(
      {
        phone: d.phone,
        firstName: d.first_name,
        amountCents: amount,
        currency,
        rideNumbers: owed.map((s) => s.ride_number).filter((n): n is number => n != null).sort((a, b) => a - b),
        reference: owed.length === 1 ? owed[0]!.reference : batchReference(d.number, timeZone),
      },
      { orgName, link: settings.link, instructions: settings.instructions, methods: settings.methods ?? [], bank: centrale?.bank ?? null },
    );
  };

  const drivers = overview.drivers ?? [];
  const filteredDriver = driverId ? (drivers.find((d) => d.driver_id === driverId) ?? items.find((s) => s.driver?.id === driverId)?.driver ?? null) : null;
  const filteredDriverLabel = filteredDriver ? `${driverName(filteredDriver)} #${filteredDriver.number}` : "Chauffeur sélectionné";
  const month = [
    `${formatPrice(t.collected_month_cents, currency)} encaissés`,
    t.paid_out_month_cents ? `${formatPrice(t.paid_out_month_cents, currency)} versés aux chauffeurs` : null,
    `${formatPrice(m.commission_cents, currency)} de commissions (${plural(m.rides, "course terminée", "courses terminées")})`,
    `${formatPrice(m.volume_cents, currency)} de volume`,
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------ chiffres, dans l'ordre d'action */}
      <section aria-label="Ce qui demande une action">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="À confirmer"
            value={formatPrice(t.declared_cents, currency)}
            tone={t.declared_count > 0 ? "amber" : undefined}
            sub={t.declared_count > 0 ? `${plural(t.declared_count, "paiement signalé", "paiements signalés")} par les chauffeurs` : "rien en attente"}
            href={href("declared", null)}
            active={filter === "declared" && !driverId}
            icon={<CheckCheck />}
          />
          <StatCard
            label="En retard"
            value={formatPrice(t.overdue_cents, currency)}
            tone={t.overdue_cents > 0 ? "red" : undefined}
            sub={
              t.overdue_cents > 0
                ? `${plural(all.overdue, "commission", "commissions")}${settings.block_unpaid ? " · chauffeurs bloqués jusqu'au règlement" : " à relancer"}`
                : "aucun retard"
            }
            href={href("overdue", null)}
            active={filter === "overdue" && !driverId}
            icon={<Hourglass />}
          />
          {/* Mène à « À traiter » (commissions ET parts à verser) : jamais surlignée comme si c'était sa liste */}
          <StatCard
            label="À encaisser"
            value={formatPrice(t.to_collect_cents, currency)}
            sub={all.commissions ? `${plural(all.commissions, "commission", "commissions")} en cours` : "rien à encaisser"}
            href={href("open", null)}
            icon={<HandCoins />}
          />
          <StatCard
            label="À verser"
            value={formatPrice(t.to_pay_cents, currency)}
            tone={t.to_pay_cents > 0 ? "amber" : undefined}
            sub={all.toPay ? `${plural(all.toPay, "part chauffeur", "parts chauffeurs")} · courses payées à la centrale` : "rien à verser aux chauffeurs"}
            href={href("to_pay", null)}
            active={filter === "to_pay" && !driverId}
            icon={<ArrowUpRight />}
          />
        </div>
        <p className="mt-3 text-[13px] leading-5 text-fg-muted">
          <span className="font-medium text-fg">Ce mois-ci{NB}:</span> {month.join(" · ")}.
        </p>
      </section>

      {/* ------------------------------------------------------------ règlements */}
      <section id="reglements" aria-labelledby="reglements-title" className="scroll-mt-6">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 id="reglements-title" className="text-[17px] font-semibold tracking-tight">
              Règlements
            </h2>
            <p className="mt-0.5 text-[13px] text-fg-muted">
              {view === "rides"
                ? "Un règlement par course terminée : commission due par le chauffeur ou part à lui verser."
                : "Ce que chaque chauffeur doit encore ou attend : relancez-le ou réclamez par WhatsApp."}
            </p>
          </div>
          <ViewToggle view={view} onChange={setView} />
        </div>

        {view === "drivers" ? (
          <DriverBalances drivers={drivers} currency={currency} now={now} whatsappFor={whatsappFor} activeId={driverId} />
        ) : (
          <>
            <SettlementTabs filter={filter} driverId={driverId} counts={counts} />

            {driverId && (
              <div className="mb-3 flex items-center gap-2">
                <span className="inline-flex min-h-8 items-center gap-2 rounded-full border border-brand/30 bg-brand/[0.07] pl-3 pr-1 text-[13px] text-fg">
                  <Funnel aria-hidden className="size-3.5 text-brand" />
                  {filteredDriverLabel}
                  <Link
                    href={href(filter, null)}
                    scroll={false}
                    prefetch={false}
                    className="grid size-7 place-items-center rounded-full text-fg-muted hover:bg-white/10 hover:text-fg"
                    aria-label="Retirer le filtre chauffeur"
                  >
                    <X className="size-3.5" />
                  </Link>
                </span>
              </div>
            )}

            <SettlementList
              items={list}
              openById={openById}
              filter={filter}
              now={now}
              timeZone={timeZone}
              canManage={canManage}
              currency={currency}
              blockUnpaid={settings.block_unpaid}
              whatsappFor={(s) =>
                s.driver && owesNow(s)
                  ? buildSettlementWhatsApp(
                      {
                        phone: s.driver.phone,
                        firstName: s.driver.first_name,
                        amountCents: s.amount_cents,
                        currency: s.currency,
                        rideNumbers: [rideNumberOf(s) ?? s.reference],
                        reference: s.reference,
                      },
                      { orgName, link: settings.link, instructions: settings.instructions, methods: settings.methods ?? [], bank: centrale?.bank ?? null },
                    )
                  : null
              }
            />

            {hasMore && (
              <div className="mt-4 flex justify-center">
                <Button asChild variant="outline" size="sm">
                  <Link href={href(filter, driverId, Math.min(SETTLEMENT_MAX, limit + SETTLEMENT_PAGE))} scroll={false} prefetch={false}>Afficher plus</Link>
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------- bascule « Par course | Par chauffeur »
function ViewToggle({ view, onChange }: { view: "rides" | "drivers"; onChange: (v: "rides" | "drivers") => void }) {
  return (
    <div role="group" aria-label="Affichage des règlements" className="inline-flex rounded-lg border border-line bg-ink-850 p-0.5">
      {(
        [
          ["rides", "Par course"],
          ["drivers", "Par chauffeur"],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          type="button"
          aria-pressed={view === key}
          onClick={() => onChange(key)}
          className={cn(
            "min-h-10 rounded-md px-3 text-[13px] font-medium transition-colors sm:min-h-8",
            view === key ? "bg-ink-600 text-fg" : "text-fg-muted hover:text-fg",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------- onglets et puces
/**
 * Barre des règlements : liste d'onglets (role="tab", même sémantique qu'avant) au style des filtres. « À traiter ·
 * Réglés · Annulés · Tous » toujours visibles ; « À confirmer », « En retard », « Contestés », « À verser » seulement
 * au-dessus de zéro ou quand ils sont affichés (mêmes clés ?filter=).
 */
function SettlementTabs({ filter, driverId, counts }: { filter: OrgSettlementFilter; driverId: string | null; counts: Partial<Record<OrgSettlementFilter, number>> }) {
  const chips = CHIPS.filter((c) => (counts[c.key] ?? 0) > 0 || c.key === filter);
  const tab = (key: OrgSettlementFilter, label: string, alert = false) => {
    const n = counts[key];
    const active = key === filter;
    return (
      <Link
        key={key}
        href={href(key, driverId)}
        prefetch={false}
        role="tab"
        aria-selected={active}
        scroll={false}
        className={cn(
          // 44 px au toucher sous 640 px (comme FilterTabs)
          "inline-flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[13px] transition-colors sm:h-9",
          active ? "border-line-strong bg-ink-600 font-medium text-fg" : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
        )}
      >
        {label}
        {n != null && n > 0 && (
          <span
            className={cn(
              "min-w-5 rounded-full px-1.5 text-center text-[12px] font-semibold leading-5 tabular-nums",
              // Alerte : rouge plein, texte encre (5,97:1) ; le rouge sur rouge pâle tombait à 4,05:1 sur l'onglet actif
              alert ? "bg-red text-ink-950" : active ? "bg-white/[0.08] text-fg" : "bg-white/[0.05] text-fg-muted",
            )}
          >
            {n}
          </span>
        )}
      </Link>
    );
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Filtrer les règlements">
      {TABS.map((t) => tab(t.key, t.label))}
      {chips.length > 0 && <span aria-hidden className="mx-1 hidden h-5 w-px bg-line sm:block" />}
      {chips.map((c) => tab(c.key, c.label, c.alert))}
    </div>
  );
}

// ---------------------------------------------------------------------------- vue « Par chauffeur »
/**
 * État d'un chauffeur en un seul libellé : « Actif », « Bloqué · commission en retard », « Bloqué · paiement contesté »,
 * « Banni ». « unpaid » couvre une commission en retard OU contestée (DRIVER_BLOCKER_META) : sans montant en retard,
 * c'est la contestation qui bloque.
 */
const BLOCKED_REASON: Record<DriverBlocker, string> = {
  unpaid: "commission en retard",
  credit_limit: "plafond de commissions atteint",
  new_driver: "courses réservées aux confirmés",
};

function driverState(d: Pick<OrgSettlementDriver, "banned" | "blocked" | "overdue_cents">): { label: string; tone: "red" | "green" } {
  if (d.banned) return { label: "Banni", tone: "red" };
  if (d.blocked === "unpaid" && !(d.overdue_cents > 0)) return { label: "Bloqué · paiement contesté", tone: "red" };
  if (d.blocked) return { label: `Bloqué · ${BLOCKED_REASON[d.blocked] ?? DRIVER_BLOCKER_META[d.blocked]?.label.toLowerCase() ?? "commission en retard"}`, tone: "red" };
  return { label: "Actif", tone: "green" };
}

/** « doit 30 €, en retard · a déclaré 11 €, à confirmer · à lui verser 66,20 € » (montants à zéro omis). */
export function balancePhrase(d: Pick<OrgSettlementDriver, "owed_cents" | "overdue_cents" | "declared_cents" | "to_pay_cents">, currency = "EUR") {
  const p = (c: number) => formatPrice(c, currency);
  const parts: string[] = [];
  if (d.owed_cents > 0) {
    parts.push(
      d.overdue_cents >= d.owed_cents
        ? `doit ${p(d.owed_cents)}, en retard`
        : d.overdue_cents > 0
          ? `doit ${p(d.owed_cents)}, dont ${p(d.overdue_cents)} en retard`
          : `doit ${p(d.owed_cents)}`,
    );
  }
  if (d.declared_cents > 0) parts.push(`a déclaré ${p(d.declared_cents)}, à confirmer`);
  if (d.to_pay_cents > 0) parts.push(`à lui verser ${p(d.to_pay_cents)}`);
  return parts.length ? parts.join(" · ") : "rien en cours";
}

function DriverBalances({
  drivers,
  currency,
  now,
  whatsappFor,
  activeId,
}: {
  drivers: OrgSettlementDriver[];
  currency: string;
  now: number;
  whatsappFor: (d: OrgSettlementDriver) => string | null;
  activeId: string | null;
}) {
  if (!drivers.length) {
    return (
      <Card>
        <EmptyState size="compact" icon={<CheckCheck />} title="Aucun solde ouvert." description="Toutes les commissions sont réglées et toutes les parts versées." />
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line">
        {drivers.map((d) => (
          <DriverBalanceRow key={d.driver_id} d={d} currency={currency} now={now} whatsapp={whatsappFor(d)} active={d.driver_id === activeId} />
        ))}
      </ul>
    </Card>
  );
}

function DriverBalanceRow({ d, currency, now, whatsapp, active }: { d: OrgSettlementDriver; currency: string; now: number; whatsapp: string | null; active: boolean }) {
  const { pending, remind } = useRemindDriver();
  const recent = d.last_reminded_at ? now - Date.parse(d.last_reminded_at) < 30 * 60_000 : false;
  const canRemind = d.owed_cents > 0 && !recent;
  const state = driverState(d);
  const phrase = balancePhrase(d, currency);
  const late = d.overdue_cents > 0;
  return (
    <li className={cn("flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:px-5", active && "bg-brand/[0.035]")}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Avatar name={driverName(d)} size={36} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              href={href("open", d.driver_id)}
              prefetch={false}
              className="text-[14px] font-medium text-fg underline-offset-2 hover:text-brand hover:underline"
              title={`Voir les règlements de ${d.first_name}`}
            >
              {driverName(d)} <span className="mono font-normal text-fg-muted">#{d.number}</span>
            </Link>
            {/* Un seul libellé d'état, jamais coupé (retour à la ligne si besoin) */}
            <Badge tone={state.tone} className="h-auto min-h-[22px] whitespace-normal py-0.5">
              {state.label}
            </Badge>
            {d.trust_level === "new" && <span className="text-[12px] text-amber">nouveau</span>}
          </p>
          <p className={cn("mt-0.5 text-[13px]", late ? "text-red" : "text-fg")}>{phrase}</p>
          <p className="mt-0.5 text-[12px] text-fg-muted">
            <a href={`tel:${d.phone}`} className="mono hover:text-fg">
              {formatPhone(d.phone)}
            </a>
            {" · "}
            {d.last_reminded_at ? `relancé ${fromNow(d.last_reminded_at, now)}` : "jamais relancé"}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 max-sm:pl-12 sm:shrink-0 sm:justify-end">
        {d.owed_cents > 0 && (
          <Tooltip content={recent ? `Déjà relancé ${fromNow(d.last_reminded_at, now)} (1 rappel / 30 min)` : "Rappel au chauffeur, par le canal choisi dans vos réglages"}>
            <span>
              <Button variant="secondary" size="sm" disabled={!canRemind || pending} loading={pending} onClick={() => remind(d.driver_id, d.first_name)}>
                <BellRing /> Relancer
              </Button>
            </span>
          </Tooltip>
        )}
        <WhatsAppButton href={whatsapp} size="sm" />
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------- liste des règlements
const ROW_GRID = "xl:grid xl:grid-cols-[20px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,0.75fr)_minmax(150px,1.1fr)_200px] xl:items-center xl:gap-3";

function SettlementList({
  items,
  openById,
  filter,
  now,
  timeZone,
  canManage,
  currency,
  blockUnpaid,
  whatsappFor,
}: {
  items: OrgSettlementItem[];
  openById: ReadonlyMap<string, OpenSettlement>;
  filter: OrgSettlementFilter;
  now: number;
  timeZone: string;
  canManage: boolean;
  currency: string;
  blockUnpaid: boolean;
  whatsappFor: (s: OrgSettlementItem) => string | null;
}) {
  // Sélection : id → dernière version connue de la ligne (une ligne cochée peut sortir des lignes affichées)
  const [selected, setSelected] = useState<ReadonlyMap<string, OrgSettlementItem>>(() => new Map());
  const [bulkMethod, setBulkMethod] = useState<ConfirmMethod | "declared">("declared");
  const { pending, run } = useSettlementRunner();
  const selectable = items.filter(isOpen);
  const picked = [...selected.values()];
  // Cochées mais plus dans la liste (relecture qui re-trie « À traiter ») : affichées à part, toujours sélectionnées
  const shownIds = useMemo(() => new Set(items.map((s) => s.id)), [items]);
  const carried = picked.filter((s) => !shownIds.has(s.id));
  // Entrées (commissions à encaisser) et sorties (parts à verser) jamais additionnées
  const inCents = picked.reduce((n, s) => n + (s.direction === "driver_owes" ? s.amount_cents : 0), 0);
  const outCents = picked.reduce((n, s) => n + (s.direction === "centrale_owes" ? s.amount_cents : 0), 0);
  const allOwes = picked.every((s) => s.direction === "driver_owes");
  const allPays = picked.every((s) => s.direction === "centrale_owes");
  const mixed = !allOwes && !allPays;
  const pickedAmount = mixed
    ? `${formatPrice(inCents, currency)} à encaisser · ${formatPrice(outCents, currency)} à verser`
    : formatPrice(inCents + outCents, currency);
  const verb = allOwes ? "Marquer reçus" : allPays ? "Marquer versés" : "Marquer réglés";
  // Sélection relue avec la liste : règlement réglé ailleurs (temps réel) retiré, ligne sortie de la page gardée s'il
  // reste ouvert et inchangé
  useEffect(() => {
    setSelected((cur) => carrySelection(cur, items, openById));
  }, [items, openById]);

  const toggle = (s: OrgSettlementItem) =>
    setSelected((cur) => {
      const next = new Map(cur);
      if (next.has(s.id)) next.delete(s.id);
      else next.set(s.id, s);
      return next;
    });
  const allChecked = selectable.length > 0 && selectable.every((s) => selected.has(s.id));

  if (!items.length) {
    return (
      <Card>
        <EmptyState size="compact" icon={<CheckCheck />} title={EMPTY[filter].title} description={EMPTY[filter].description} />
      </Card>
    );
  }

  return (
    <>
      <Card className="overflow-hidden">
        <div className={cn("hidden border-b border-line px-5 py-2.5 text-[12px] font-medium text-fg-muted", ROW_GRID)}>
          <span>
            {selectable.length > 0 && (
              <Checkbox
                checked={allChecked}
                onChange={() => setSelected((cur) => (allChecked ? new Map() : new Map([...cur, ...selectable.map((s) => [s.id, s] as const)])))}
                label="Tout sélectionner"
              />
            )}
          </span>
          <span>Course</span>
          <span>Chauffeur</span>
          <span>Répartition</span>
          <span className="text-right">Montant</span>
          <span>Statut</span>
          <span className="sr-only">Actions</span>
        </div>
        <ul className="divide-y divide-line">
          {items.map((s) => (
            <SettlementRow
              key={s.id}
              s={s}
              now={now}
              timeZone={timeZone}
              canManage={canManage}
              checked={selected.has(s.id)}
              onToggle={isOpen(s) ? () => toggle(s) : undefined}
              whatsapp={whatsappFor(s)}
              blockUnpaid={blockUnpaid}
            />
          ))}
        </ul>
        {carried.length > 0 && (
          <div className="border-t border-line-strong">
            <p className="px-5 pb-1 pt-3 text-[13px] text-fg-muted">
              {carried.length > 1
                ? `Sélection conservée : ces ${carried.length} règlements ne font plus partie des lignes affichées.`
                : "Sélection conservée : ce règlement ne fait plus partie des lignes affichées."}
            </p>
            <ul className="divide-y divide-line">
              {carried.map((s) => (
                <SettlementRow
                  key={s.id}
                  s={s}
                  now={now}
                  timeZone={timeZone}
                  canManage={canManage}
                  checked
                  onToggle={() => toggle(s)}
                  whatsapp={whatsappFor(s)}
                  blockUnpaid={blockUnpaid}
                />
              ))}
            </ul>
          </div>
        )}
      </Card>

      {picked.length > 0 && (
        <div data-tour-avoid="" className="sticky bottom-4 z-20 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line-strong bg-ink-700/[0.97] px-4 py-3 shadow-float backdrop-blur-xl">
          <p className="text-[13px] text-fg-muted">
            <span className="font-semibold text-fg">{picked.length}</span> sélectionné{picked.length > 1 ? "s" : ""} ·{" "}
            <span className="mono font-semibold text-fg">{pickedAmount}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-[13px] text-fg-muted">
              <span className="hidden sm:inline">Moyen</span>
              <select
                value={bulkMethod}
                onChange={(e) => setBulkMethod(e.target.value as ConfirmMethod | "declared")}
                className="h-9 rounded-lg border border-line bg-ink-800 px-2 text-[13px] text-fg outline-none focus:border-brand/50"
                aria-label="Moyen de paiement"
              >
                <option value="declared">Selon la déclaration</option>
                {METHOD_ORDER.map((mth) => (
                  <option key={mth} value={mth}>{methodLabel(mth)}</option>
                ))}
              </select>
            </label>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Map())}>Tout désélectionner</Button>
            <Button
              variant="primary"
              size="sm"
              loading={pending}
              onClick={() =>
                run(
                  () => confirmSettlements([...selected.keys()], bulkMethod === "declared" ? null : bulkMethod),
                  (r) =>
                    `${r.count ?? picked.length} règlement${(r.count ?? picked.length) > 1 ? "s" : ""} confirmé${(r.count ?? picked.length) > 1 ? "s" : ""} · ${
                      mixed
                        ? `${formatPrice(r.received_cents ?? inCents, currency)} encaissés · ${formatPrice(r.paid_out_cents ?? outCents, currency)} versés`
                        : formatPrice(r.amount_cents ?? inCents + outCents, currency)
                    }`,
                  () => setSelected(new Map()),
                )
              }
            >
              <CheckCheck /> {verb}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      className="size-4 cursor-pointer rounded border-line-strong bg-ink-800 accent-[var(--color-brand)]"
    />
  );
}

function SettlementRow({
  s,
  now,
  timeZone,
  canManage,
  checked,
  onToggle,
  whatsapp,
  blockUnpaid,
}: {
  s: OrgSettlementItem;
  now: number;
  timeZone: string;
  canManage: boolean;
  checked: boolean;
  onToggle?: () => void;
  whatsapp: string | null;
  blockUnpaid: boolean;
}) {
  const at = now;
  const live = { ...s, overdue: s.direction === "driver_owes" && s.status === "due" && Date.parse(s.due_at) <= at };
  const due = dueInfo(live, at, { blockUnpaid });
  const owes = s.direction === "driver_owes";
  const open = isOpen(s);
  const n = rideNumberOf(s);
  const summary = splitSummary({ ...s, currency: s.currency });
  const DirIcon = owes ? ArrowDownLeft : ArrowUpRight;
  const driver = s.driver;
  const MethodIcon = s.settled_method ? METHOD_ICON[s.settled_method] : null;

  const course = (
    <div className="min-w-0 xl:order-1">
      <p className="flex min-w-0 items-baseline gap-2 text-[14px]">
        <Link href={`/dashboard/rides/${s.ride_id}`} prefetch={false} className="mono shrink-0 font-semibold text-fg hover:text-brand">
          #{n ?? "—"}
        </Link>
        <span className="truncate text-[12px] text-fg-muted">{s.ride.completed_at ? formatRideDate(s.ride.completed_at, timeZone, new Date(at)) : "—"}</span>
      </p>
      <p className="truncate text-[13px] text-fg-muted" title={`${s.ride.pickup} → ${s.ride.dropoff}`}>
        {shortAddress(s.ride.pickup)} → {shortAddress(s.ride.dropoff)}
      </p>
    </div>
  );
  const who = (
    <div className="min-w-0 xl:order-2">
      <p className="truncate text-[13px]">
        {driver ? `${driver.first_name} ${driver.last_name}` : s.driver_label}
        {driver && <span className="mono text-fg-muted"> #{driver.number}</span>}
      </p>
      <p className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-fg-muted">
        <span>réf.</span> <span className="mono">{s.reference}</span>
        {driver?.trust_level === "new" && <span className="text-amber">· nouveau</span>}
        {driver?.banned && <span className="text-red">· banni</span>}
      </p>
    </div>
  );
  // Répartition en phrase (« 30 € = 19 € chauffeur + 6 € commission + 5 € plateforme »), partout
  const repartition = summary ? <p className="min-w-0 text-[12px] leading-[18px] text-fg-muted xl:order-3">{summary}</p> : <span className="hidden xl:order-3 xl:block" />;
  const amount = (
    <div className="shrink-0 text-right xl:order-4">
      <p className={cn("mono whitespace-nowrap text-[15px] font-semibold tracking-tight", s.status === "waived" ? "text-fg-muted line-through" : "text-fg")}>
        {formatPrice(s.amount_cents, s.currency)}
      </p>
      {/* Sens : « à encaisser / à verser » seulement tant que le règlement est ouvert */}
      {open ? (
        <p className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[12px]", owes ? "text-fg-muted" : "text-amber")}>
          <DirIcon aria-hidden className="size-3" /> {owes ? "à encaisser" : "à verser"}
        </p>
      ) : (
        <p className="whitespace-nowrap text-[12px] text-fg-muted">{owes ? "commission" : "part chauffeur"}</p>
      )}
    </div>
  );
  const status = (
    <div className="min-w-0 space-y-1 xl:order-5">
      <SettlementBadge settlement={live} />
      {s.status === "declared" ? (
        <DeclarationLine settlement={s} now={at} />
      ) : (
        <p className={cn("flex min-w-0 items-center gap-1.5 text-[12px]", toneText[due.tone])}>
          {s.status === "paid" && MethodIcon && <MethodIcon aria-hidden className="size-3 shrink-0" />}
          <span className="min-w-0">
            {s.status === "paid" && s.settled_method ? `${methodLabel(s.settled_method)} · ` : ""}
            {due.text}
          </span>
        </p>
      )}
      {(s.status === "disputed" || s.status === "waived") && s.note && (
        <p className="truncate text-[12px] text-fg-muted" title={s.note}>«{NB}{s.note}{NB}»</p>
      )}
    </div>
  );
  const actions = <SettlementActions settlement={live} canManage={canManage} whatsapp={whatsapp} size="xs" className="xl:order-6 xl:flex-nowrap xl:justify-end" />;

  return (
    <li className={cn("px-4 py-3.5 transition-colors sm:px-5", checked ? "bg-brand/[0.04]" : "hover:bg-white/[0.015]")}>
      {/* Mobile / tablette : une carte ; grand écran (xl) : une ligne de tableau. Les enveloppes « xl:contents »
          laissent leurs enfants dans la grille, rangés par « xl:order-* ». */}
      <div className={cn("flex gap-3", ROW_GRID)}>
        <span className={cn("pt-1 xl:pt-0", !onToggle && "hidden xl:block")}>
          {onToggle && <Checkbox checked={checked} onChange={onToggle} label={`Sélectionner ${s.reference}`} />}
        </span>
        <div className="min-w-0 flex-1 space-y-2.5 xl:contents xl:space-y-0">
          <div className="flex items-start justify-between gap-3 xl:contents">
            {course}
            {amount}
          </div>
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 xl:contents">
            {who}
            {status}
          </div>
          {repartition}
          {actions}
        </div>
      </div>
    </li>
  );
}
