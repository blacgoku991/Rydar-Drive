"use client";
// Page « Encaissements » (mode centrale) : indicateurs, soldes par chauffeur, règlements filtrables.
// Les chiffres viennent de org_settlement_overview / org_settlements ; toute décision passe par une RPC
// (Reçu, Pas reçu, Versé, Annuler, Rouvrir, Relancer) puis la page est relue. Temps réel : settlement.updated.
import {
  DRIVER_BLOCKER_META, TRUST_LEVEL_META, formatNumber, formatPhone, formatPrice, formatRideDate, shortAddress, splitSummary,
  type OrgSettlementDriver, type OrgSettlementFilter, type OrgSettlementItem, type OrgSettlementOverview,
} from "@rydar/shared";
import { ArrowDownLeft, ArrowUpRight, BellRing, Check, CheckCheck, Funnel, FunnelX, HandCoins, Hourglass, Lock, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { confirmSettlements } from "@/app/dashboard/settlements/actions";
import { useRealtimeEvent, useRealtimeStatus } from "@/components/realtime/realtime-provider";
import {
  DeclarationLine, METHOD_ICON, SettlementActions, SettlementBadge, SplitBar, WhatsAppButton, batchReference, buildSettlementWhatsApp,
  dueInfo, fromNow, methodLabel, rideNumberOf, useRemindDriver, useSettlementRunner, type ConfirmMethod,
} from "@/components/settlements/settlement-ui";
import { Badge, toneText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Avatar, EmptyState, Tooltip } from "@/components/ui/misc";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";

type Props = {
  overview: OrgSettlementOverview;
  /** Tous les règlements ouverts (soldes, compteurs, messages WhatsApp) */
  openItems: OrgSettlementItem[];
  /** Liste affichée (onglet + chauffeur) */
  items: OrgSettlementItem[];
  filter: OrgSettlementFilter;
  driverId: string | null;
  limit: number;
  orgName: string;
  timeZone: string;
  canManage: boolean;
  /** Horloge du rendu serveur (libellés relatifs identiques à l'hydratation) */
  serverNow: number;
};

const TABS: { key: OrgSettlementFilter; label: string }[] = [
  { key: "open", label: "À traiter" },
  { key: "declared", label: "À confirmer" },
  { key: "overdue", label: "En retard" },
  { key: "disputed", label: "Contestés" },
  { key: "to_pay", label: "À verser" },
  { key: "paid", label: "Encaissés" },
  { key: "waived", label: "Annulés" },
  { key: "all", label: "Tous" },
];

const EMPTY: Record<OrgSettlementFilter, { title: string; description: string }> = {
  open: { title: "Tout est réglé", description: "Les commissions à encaisser et les parts à verser apparaîtront ici à la fin de chaque course." },
  declared: { title: "Rien à confirmer", description: "Quand un chauffeur signale « J'ai payé », le paiement attend ici votre « Reçu »." },
  overdue: { title: "Aucun retard", description: "Aucune commission n'a dépassé son échéance." },
  disputed: { title: "Aucune contestation", description: "Les paiements marqués « Pas reçu » s'afficheront ici." },
  to_pay: { title: "Rien à verser", description: "Les courses payées à la centrale (en ligne, facture) créent ici la part à verser au chauffeur." },
  paid: { title: "Aucun encaissement", description: "Les règlements confirmés s'afficheront ici." },
  waived: { title: "Aucune annulation", description: "Les dettes annulées (geste commercial, litige) s'afficheront ici." },
  all: { title: "Aucun règlement", description: "Les règlements sont créés automatiquement à la fin des courses." },
};

const OPEN = new Set(["due", "declared", "disputed"]);
const isOpen = (s: OrgSettlementItem) => OPEN.has(s.status);
const owesNow = (s: OrgSettlementItem) => s.direction === "driver_owes" && (s.status === "due" || s.status === "disputed");
const lateNow = (s: OrgSettlementItem, now: number) =>
  s.direction === "driver_owes" && (s.status === "disputed" || (s.status === "due" && Date.parse(s.due_at) <= now));

/** « À traiter » : d'abord ce qui attend une décision (déclaré), puis les retards, le reste, les versements. */
function openRank(s: OrgSettlementItem, now: number) {
  if (s.status === "declared") return 0;
  if (s.status === "disputed") return 1;
  if (lateNow(s, now)) return 2;
  return s.direction === "driver_owes" ? 3 : 4;
}

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
export function SettlementsView({ overview, openItems, items, filter, driverId, limit, orgName, timeZone, canManage, serverNow }: Props) {
  const router = useRouter();
  const now = useNow(30_000) ?? serverNow;
  const t = overview.totals;
  const m = overview.month;
  const currency = overview.currency || "EUR";
  const settings = overview.settings;

  // Relecture à chaque règlement créé / déclaré / confirmé (ici ou ailleurs) ; repli périodique sans temps réel
  const timer = useRef<number | null>(null);
  const refresh = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => router.refresh(), 450);
  };
  useRealtimeEvent("settlement.updated", refresh);
  const realtime = useRealtimeStatus();
  useEffect(() => {
    const id = window.setInterval(() => router.refresh(), realtime === "live" ? 120_000 : 15_000);
    return () => window.clearInterval(id);
  }, [realtime, router]);

  const scoped = useMemo(() => (driverId ? openItems.filter((s) => s.driver_id === driverId) : openItems), [openItems, driverId]);
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

  const list = useMemo(() => {
    if (filter !== "open") return items;
    return [...items].sort((a, b) => openRank(a, now) - openRank(b, now) || b.created_at.localeCompare(a.created_at));
  }, [items, filter, now]);

  // Réclamation WhatsApp par chauffeur : tout ce qui est à régler (à régler + contesté), comme l'app chauffeur
  const owedByDriver = useMemo(() => {
    const map = new Map<string, OrgSettlementItem[]>();
    for (const s of openItems) {
      if (!s.driver_id || !owesNow(s)) continue;
      map.set(s.driver_id, [...(map.get(s.driver_id) ?? []), s]);
    }
    return map;
  }, [openItems]);
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
        rideNumbers: owed.map((s) => rideNumberOf(s)).filter((n): n is number => n != null).sort((a, b) => a - b),
        reference: owed.length === 1 ? owed[0]!.reference : batchReference(d.number, timeZone),
      },
      { orgName, link: settings.link, instructions: settings.instructions, methods: settings.methods ?? [] },
    );
  };

  const drivers = overview.drivers ?? [];
  const filteredDriver = driverId ? (drivers.find((d) => d.driver_id === driverId) ?? items.find((s) => s.driver?.id === driverId)?.driver ?? null) : null;
  const filteredDriverLabel = filteredDriver ? `${driverName(filteredDriver)} #${filteredDriver.number}` : "Chauffeur sélectionné";
  const openCommissions = openItems.filter((s) => s.direction === "driver_owes").length;

  return (
    <div className="space-y-8">
      {/* ------------------------------------------------------------ indicateurs */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Indicateurs d'encaissement">
        <Kpi
          label="À encaisser"
          value={formatPrice(t.to_collect_cents, currency)}
          sub={openCommissions ? `${formatNumber(openCommissions)} commission${openCommissions > 1 ? "s" : ""} en cours` : "rien à encaisser"}
          href={href("open", null)}
          icon={<HandCoins />}
        />
        <Kpi
          label="En retard"
          value={formatPrice(t.overdue_cents, currency)}
          tone={t.overdue_cents > 0 ? "red" : undefined}
          sub={t.overdue_cents > 0 ? (settings.block_unpaid ? "chauffeurs bloqués jusqu'au règlement" : "à relancer") : "aucun retard"}
          href={href("overdue", null)}
          icon={<Hourglass />}
        />
        <Kpi
          label="À confirmer"
          value={formatPrice(t.declared_cents, currency)}
          tone={t.declared_count > 0 ? "blue" : undefined}
          sub={t.declared_count > 0 ? `${t.declared_count} paiement${t.declared_count > 1 ? "s" : ""} signalé${t.declared_count > 1 ? "s" : ""} par les chauffeurs` : "rien en attente"}
          href={href("declared", null)}
          icon={<CheckCheck />}
        />
        <Kpi
          label="À verser aux chauffeurs"
          value={formatPrice(t.to_pay_cents, currency)}
          tone={t.to_pay_cents > 0 ? "violet" : undefined}
          sub="courses payées à la centrale"
          href={href("to_pay", null)}
          icon={<ArrowUpRight />}
        />
        <Kpi
          label="Encaissé ce mois"
          value={formatPrice(t.collected_month_cents, currency)}
          tone="green"
          sub={t.paid_out_month_cents ? `${formatPrice(t.paid_out_month_cents, currency)} versés aux chauffeurs` : "commissions confirmées"}
          href={href("paid", null)}
          icon={<Check />}
        />
        <Kpi label="Commission du mois" value={formatPrice(m.commission_cents, currency)} tone="brand" sub={`${formatNumber(m.rides)} course${m.rides > 1 ? "s" : ""} terminée${m.rides > 1 ? "s" : ""}`} />
        {m.platform_fee_cents > 0 && <Kpi label="Frais plateforme du mois" value={formatPrice(m.platform_fee_cents, currency)} sub="fixés par Rydar" />}
        <Kpi label="Volume du mois" value={formatPrice(m.volume_cents, currency)} sub={`dont ${formatPrice(m.driver_payout_cents, currency)} pour les chauffeurs`} />
      </section>

      {/* ------------------------------------------------------------ soldes par chauffeur */}
      <Card>
        <CardHeader
          title="Soldes par chauffeur"
          description="Ce que chacun doit encore (ou attend) : relancez par notification ou réclamez par WhatsApp avec le lien de paiement prérempli."
        />
        {drivers.length === 0 ? (
          <EmptyState icon={<CheckCheck />} title="Aucun solde ouvert" description="Toutes les commissions sont réglées et toutes les parts versées." className="py-10" />
        ) : (
          <div>
            <div className={cn("hidden border-b border-line px-5 py-2.5 text-[12px] font-medium text-fg-subtle", BALANCE_GRID)}>
              <span>Chauffeur</span>
              <span>Statut</span>
              <span className="text-right">À régler</span>
              <span className="text-right">En retard</span>
              <span className="text-right">Déclaré</span>
              <span className="text-right">À verser</span>
              <span>Relance</span>
              <span className="sr-only">Actions</span>
            </div>
            <ul className="divide-y divide-line">
              {drivers.map((d) => (
                <BalanceRow key={d.driver_id} d={d} currency={currency} now={now} whatsapp={whatsappFor(d)} active={d.driver_id === driverId} />
              ))}
            </ul>
          </div>
        )}
      </Card>

      {/* ------------------------------------------------------------ règlements */}
      <section id="reglements" className="scroll-mt-6">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-semibold tracking-tight">Règlements</h2>
            <p className="mt-0.5 text-[12.5px] text-fg-muted">Un règlement par course terminée : commission due par le chauffeur ou part à lui verser.</p>
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-fg-subtle" aria-label="Légende de la répartition">
            <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-brand" /> chauffeur</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-blue" /> commission</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-violet" /> plateforme</span>
          </p>
        </div>

        <div className="-mx-1 mb-3 flex gap-1 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Filtrer les règlements">
          {TABS.map((tab) => {
            const n = counts[tab.key];
            const active = tab.key === filter;
            const alarm = (tab.key === "overdue" || tab.key === "disputed") && !!n;
            return (
              <Link
                key={tab.key}
                href={href(tab.key, driverId)}
                role="tab"
                aria-selected={active}
                scroll={false}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium transition-colors",
                  active ? "bg-white/[0.08] text-fg" : "text-fg-muted hover:bg-white/[0.04] hover:text-fg",
                )}
              >
                {tab.label}
                {n != null && n > 0 && (
                  <span
                    className={cn(
                      "mono rounded-md px-1.5 text-[11px] leading-[18px]",
                      alarm ? "bg-red/15 text-red" : tab.key === "declared" ? "bg-blue/15 text-blue" : active ? "bg-brand/15 text-brand" : "bg-white/[0.06] text-fg-subtle",
                    )}
                  >
                    {n}
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        {driverId && (
          <div className="mb-3 flex items-center gap-2">
            <span className="inline-flex h-7 items-center gap-2 rounded-full border border-brand/30 bg-brand/[0.07] pl-3 pr-1 text-[12.5px] text-fg">
              <Funnel className="size-3.5 text-brand" />
              {filteredDriverLabel}
              <Link href={href(filter, null)} scroll={false} className="grid size-5 place-items-center rounded-full text-fg-muted hover:bg-white/10 hover:text-fg" aria-label="Retirer le filtre chauffeur">
                <X className="size-3.5" />
              </Link>
            </span>
          </div>
        )}

        <SettlementList
          items={list}
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
                  { orgName, link: settings.link, instructions: settings.instructions, methods: settings.methods ?? [] },
                )
              : null
          }
        />

        {items.length >= limit && limit < 500 && (
          <div className="mt-4 flex justify-center">
            <Button asChild variant="outline" size="sm">
              <Link href={href(filter, driverId, Math.min(500, limit + 100))} scroll={false}>Afficher plus</Link>
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------- indicateur
type KpiTone = "red" | "blue" | "violet" | "green" | "brand";
function Kpi({ label, value, sub, tone, href: to, icon }: { label: string; value: string; sub?: string; tone?: KpiTone; href?: string; icon?: React.ReactNode }) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12.5px] text-fg-subtle">{label}</span>
        {icon && <span className={cn("shrink-0 [&_svg]:size-4", tone ? toneText[tone] : "text-fg-subtle")}>{icon}</span>}
      </div>
      <div className={cn("mono mt-1.5 truncate text-[22px] font-semibold leading-none tracking-tight sm:text-[24px]", tone ? toneText[tone] : "text-fg")}>{value}</div>
      {sub && <div className="mt-1.5 line-clamp-2 text-[12px] text-fg-subtle">{sub}</div>}
    </>
  );
  const cls = "surface relative block min-w-0 rounded-xl px-4 py-3.5";
  return to ? (
    <Link href={to} scroll={false} className={cn(cls, "transition-colors hover:border-line-strong hover:bg-ink-700")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

// ---------------------------------------------------------------------------- solde d'un chauffeur
const BALANCE_GRID = "xl:grid xl:grid-cols-[minmax(0,1.5fr)_minmax(150px,1fr)_repeat(4,minmax(0,0.62fr))_minmax(0,0.7fr)_268px] xl:items-center xl:gap-3";
function Money({ cents, currency, tone, className }: { cents: number; currency: string; tone?: KpiTone; className?: string }) {
  return (
    <span className={cn("mono text-[13.5px]", cents ? (tone ? cn("font-semibold", toneText[tone]) : "text-fg") : "text-fg-subtle", className)}>
      {cents ? formatPrice(cents, currency) : "—"}
    </span>
  );
}

function BalanceRow({ d, currency, now, whatsapp, active }: { d: OrgSettlementDriver; currency: string; now: number; whatsapp: string | null; active: boolean }) {
  const { pending, remind } = useRemindDriver();
  const trust = TRUST_LEVEL_META[d.trust_level];
  const recent = d.last_reminded_at ? now - Date.parse(d.last_reminded_at) < 30 * 60_000 : false;
  const canRemind = d.owed_cents > 0 && !recent;
  const status = (
    <div className="min-w-0 xl:w-full">
      {d.banned ? (
        <Badge tone="red">Banni</Badge>
      ) : d.blocked ? (
        <Badge tone="red" dot={false}>
          <Lock className="size-3" /> Bloqué
        </Badge>
      ) : (
        <Badge tone="green">
          <span className="xl:hidden">Actif</span>
          <span className="hidden xl:inline">Reçoit les courses</span>
        </Badge>
      )}
      <p className="mt-1 truncate text-[11.5px] text-fg-subtle" title={d.blocked ? `${DRIVER_BLOCKER_META[d.blocked].message} (${trust?.label ?? d.trust_level})` : trust?.description}>
        {d.blocked && !d.banned ? (
          <span className="text-red">{DRIVER_BLOCKER_META[d.blocked].label}</span>
        ) : (
          <span className={d.trust_level === "new" ? "text-amber" : undefined}>{trust?.label ?? d.trust_level}</span>
        )}
      </p>
    </div>
  );
  const actions = (
    <div className="flex flex-wrap items-center gap-1.5 xl:flex-nowrap xl:justify-end">
      <Tooltip content={d.owed_cents <= 0 ? "Rien à régler" : recent ? `Déjà relancé ${fromNow(d.last_reminded_at, now)} (1 rappel / 30 min)` : "Notification push au chauffeur"}>
        <span className={cn(d.owed_cents <= 0 && "hidden xl:inline")}>
          <Button variant="secondary" size="sm" disabled={!canRemind || pending} loading={pending} onClick={() => remind(d.driver_id, d.first_name)}>
            <BellRing /> Relancer
          </Button>
        </span>
      </Tooltip>
      <WhatsAppButton href={whatsapp} size="sm" />
      <Tooltip content={active ? "Tous les chauffeurs" : `Règlements de ${d.first_name}`}>
        <Button asChild variant="ghost" size="icon-sm" aria-label={active ? "Retirer le filtre chauffeur" : `Afficher les règlements de ${d.first_name}`}>
          <Link href={href("open", active ? null : d.driver_id)} scroll={!active}>
            {active ? <FunnelX className="text-brand" /> : <Funnel />}
          </Link>
        </Button>
      </Tooltip>
    </div>
  );
  return (
    <li className={cn("px-5 py-3.5", active && "bg-brand/[0.035]")}>
      <div className={cn("flex flex-col gap-2.5", BALANCE_GRID)}>
        <div className="flex items-start justify-between gap-3 xl:contents">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={driverName(d)} size={34} />
            <div className="min-w-0">
              <p className="truncate text-[13.5px] font-medium">
                {driverName(d)} <span className="mono font-normal text-fg-subtle">#{d.number}</span>
              </p>
              <a href={`tel:${d.phone}`} className="mono block truncate text-[12px] text-fg-subtle hover:text-fg">{formatPhone(d.phone)}</a>
            </div>
          </div>
          <div className="shrink-0 text-right xl:shrink xl:text-left">{status}</div>
        </div>
        {/* montants : grille sur grand écran, encart compact sinon */}
        <div className="rounded-xl bg-white/[0.025] px-3 py-2 xl:contents">
          <div className="grid grid-cols-4 gap-2 xl:contents">
            {(
              [
                ["À régler", d.owed_cents, undefined],
                ["En retard", d.overdue_cents, "red"],
                ["Déclaré", d.declared_cents, "blue"],
                ["À verser", d.to_pay_cents, "violet"],
              ] as const
            ).map(([label, cents, tone]) => (
              <div key={label} className="min-w-0 xl:text-right">
                <p className="text-[11px] text-fg-subtle xl:hidden">{label}</p>
                <Money cents={cents} currency={currency} tone={tone} />
              </div>
            ))}
          </div>
          <p className="mt-1.5 border-t border-line pt-1.5 text-[11.5px] text-fg-subtle xl:mt-0 xl:border-0 xl:pt-0 xl:text-[12px]">
            <span className="xl:hidden">{d.last_reminded_at ? "Relancé " : "Jamais relancé"}</span>
            {d.last_reminded_at ? fromNow(d.last_reminded_at, now) : <span className="hidden xl:inline">jamais</span>}
          </p>
        </div>
        {actions}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------- liste des règlements
const ROW_GRID = "xl:grid xl:grid-cols-[20px_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.95fr)_minmax(0,0.8fr)_minmax(158px,1.15fr)_220px] xl:items-center xl:gap-3";

function SettlementList({
  items,
  filter,
  now,
  timeZone,
  canManage,
  currency,
  blockUnpaid,
  whatsappFor,
}: {
  items: OrgSettlementItem[];
  filter: OrgSettlementFilter;
  now: number;
  timeZone: string;
  canManage: boolean;
  currency: string;
  blockUnpaid: boolean;
  whatsappFor: (s: OrgSettlementItem) => string | null;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMethod, setBulkMethod] = useState<ConfirmMethod | "declared">("declared");
  const { pending, run } = useSettlementRunner();
  const selectable = items.filter(isOpen);
  const picked = items.filter((s) => selected.has(s.id));
  const pickedTotal = picked.reduce((n, s) => n + s.amount_cents, 0);
  const allOwes = picked.every((s) => s.direction === "driver_owes");
  const allPays = picked.every((s) => s.direction === "centrale_owes");
  const verb = allOwes ? "Marquer reçus" : allPays ? "Marquer versés" : "Marquer réglés";
  // Sélection nettoyée quand un règlement quitte la liste (confirmé ailleurs, temps réel)
  useEffect(() => {
    setSelected((cur) => {
      const ids = new Set(items.filter(isOpen).map((s) => s.id));
      const next = new Set([...cur].filter((id) => ids.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [items]);

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allChecked = selectable.length > 0 && selectable.every((s) => selected.has(s.id));

  if (!items.length) {
    return (
      <Card>
        <EmptyState icon={<CheckCheck />} title={EMPTY[filter].title} description={EMPTY[filter].description} />
      </Card>
    );
  }

  return (
    <>
      <Card className="overflow-hidden">
        <div className={cn("hidden border-b border-line px-5 py-2.5 text-[12px] font-medium text-fg-subtle", ROW_GRID)}>
          <span>
            {selectable.length > 0 && (
              <Checkbox
                checked={allChecked}
                onChange={() => setSelected(allChecked ? new Set() : new Set(selectable.map((s) => s.id)))}
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
              onToggle={isOpen(s) ? () => toggle(s.id) : undefined}
              whatsapp={whatsappFor(s)}
              currency={currency}
              blockUnpaid={blockUnpaid}
            />
          ))}
        </ul>
      </Card>

      {picked.length > 0 && (
        <div className="sticky bottom-4 z-20 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line-strong bg-ink-700/[0.97] px-4 py-3 shadow-float backdrop-blur-xl">
          <p className="text-[13px] text-fg-muted">
            <span className="font-semibold text-fg">{picked.length}</span> sélectionné{picked.length > 1 ? "s" : ""} ·{" "}
            <span className="mono font-semibold text-fg">{formatPrice(pickedTotal, currency)}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-[12.5px] text-fg-muted">
              <span className="hidden sm:inline">Moyen</span>
              <select
                value={bulkMethod}
                onChange={(e) => setBulkMethod(e.target.value as ConfirmMethod | "declared")}
                className="h-8 rounded-lg border border-line bg-ink-800 px-2 text-[12.5px] text-fg outline-none focus:border-brand/50"
                aria-label="Moyen de paiement"
              >
                <option value="declared">Selon la déclaration</option>
                {(["link", "cash", "transfer", "other"] as const).map((mth) => (
                  <option key={mth} value={mth}>{methodLabel(mth)}</option>
                ))}
              </select>
            </label>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>Annuler</Button>
            <Button
              variant="primary"
              size="sm"
              loading={pending}
              onClick={() =>
                run(
                  () => confirmSettlements([...selected], bulkMethod === "declared" ? null : bulkMethod),
                  (r) => `${r.count ?? picked.length} règlement${(r.count ?? picked.length) > 1 ? "s" : ""} confirmé${(r.count ?? picked.length) > 1 ? "s" : ""} · ${formatPrice(r.amount_cents ?? pickedTotal, currency)}`,
                  () => setSelected(new Set()),
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
  currency,
  blockUnpaid,
}: {
  s: OrgSettlementItem;
  now: number;
  timeZone: string;
  canManage: boolean;
  checked: boolean;
  onToggle?: () => void;
  whatsapp: string | null;
  currency: string;
  blockUnpaid: boolean;
}) {
  const at = now;
  const live = { ...s, overdue: s.direction === "driver_owes" && s.status === "due" && Date.parse(s.due_at) <= at };
  const due = dueInfo(live, at, { blockUnpaid });
  const owes = s.direction === "driver_owes";
  const n = rideNumberOf(s);
  const split = { price: s.price_cents, driver: s.driver_payout_cents, commission: s.commission_cents, platform: s.platform_fee_cents };
  const summary = splitSummary({ ...s, currency: s.currency });
  const DirIcon = owes ? ArrowDownLeft : ArrowUpRight;
  const driver = s.driver;
  const MethodIcon = s.settled_method ? METHOD_ICON[s.settled_method] : null;

  const course = (
    <div className="min-w-0">
      <p className="flex min-w-0 items-baseline gap-2 text-[13.5px]">
        <Link href={`/dashboard/rides/${s.ride_id}`} className="mono shrink-0 font-semibold text-fg hover:text-brand">
          #{n ?? "—"}
        </Link>
        <span className="truncate text-[12px] text-fg-subtle">{s.ride.completed_at ? formatRideDate(s.ride.completed_at, timeZone, new Date(at)) : "—"}</span>
      </p>
      <p className="truncate text-[12.5px] text-fg-muted" title={`${s.ride.pickup} → ${s.ride.dropoff}`}>
        {shortAddress(s.ride.pickup)} → {shortAddress(s.ride.dropoff)}
      </p>
    </div>
  );
  const who = (
    <div className="min-w-0">
      <p className="truncate text-[13px]">
        {driver ? `${driver.first_name} ${driver.last_name}` : s.driver_label}
        {driver && <span className="mono text-fg-subtle"> #{driver.number}</span>}
      </p>
      <p className="flex items-center gap-1.5 text-[11.5px] text-fg-subtle">
        <span>réf.</span> <span className="mono text-fg-muted">{s.reference}</span>
        {driver?.trust_level === "new" && <span className="text-amber">· nouveau</span>}
        {driver?.banned && <span className="text-red">· banni</span>}
      </p>
    </div>
  );
  const repartition = (
    <div className="min-w-0" title={summary ?? undefined}>
      <div className="flex items-center gap-2">
        <span className="mono shrink-0 text-[12.5px] text-fg">{formatPrice(s.price_cents, s.currency)}</span>
        <SplitBar split={split} className="h-1.5 flex-1" />
      </div>
      <p className="mono mt-1 flex flex-wrap gap-x-2 text-[11.5px] text-fg-subtle">
        <span className="text-brand">{formatPrice(s.driver_payout_cents, s.currency)}</span>
        <span className="text-blue">{formatPrice(s.commission_cents, s.currency)}</span>
        {s.platform_fee_cents > 0 && <span className="text-violet">{formatPrice(s.platform_fee_cents, s.currency)}</span>}
      </p>
    </div>
  );
  const amount = (
    <div className="shrink-0 text-right">
      <p className={cn("mono text-[15px] font-semibold tracking-tight", s.status === "waived" ? "text-fg-subtle line-through" : "text-fg")}>
        {formatPrice(s.amount_cents, s.currency)}
      </p>
      <p className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[11.5px]", owes ? "text-fg-muted" : "text-violet")}>
        <DirIcon className="size-3" /> {owes ? "à encaisser" : "à verser"}
      </p>
    </div>
  );
  const status = (
    <div className="min-w-0 space-y-1">
      <SettlementBadge settlement={live} />
      {s.status === "declared" ? (
        <DeclarationLine settlement={s} now={at} />
      ) : (
        <p className={cn("flex min-w-0 items-center gap-1.5 truncate text-[11.5px]", toneText[due.tone])}>
          {s.status === "paid" && MethodIcon && <MethodIcon className="size-3 shrink-0" />}
          <span className="truncate">
            {s.status === "paid" && s.settled_method ? `${methodLabel(s.settled_method)} · ` : ""}
            {due.text}
          </span>
        </p>
      )}
      {(s.status === "disputed" || s.status === "waived") && s.note && (
        <p className="truncate text-[11.5px] text-fg-subtle" title={s.note}>« {s.note} »</p>
      )}
    </div>
  );
  const actions = <SettlementActions settlement={s} canManage={canManage} whatsapp={whatsapp} size="xs" className="xl:flex-nowrap xl:justify-end" />;

  return (
    <li className={cn("px-4 py-3.5 transition-colors sm:px-5", checked ? "bg-brand/[0.04]" : "hover:bg-white/[0.015]")}>
      {/* Grand écran : une ligne de tableau */}
      <div className={cn("hidden", ROW_GRID)}>
        <span>{onToggle && <Checkbox checked={checked} onChange={onToggle} label={`Sélectionner ${s.reference}`} />}</span>
        {course}
        {who}
        {repartition}
        {amount}
        {status}
        {actions}
      </div>
      {/* Mobile / tablette : une carte */}
      <div className="flex gap-3 xl:hidden">
        {onToggle && (
          <span className="pt-1">
            <Checkbox checked={checked} onChange={onToggle} label={`Sélectionner ${s.reference}`} />
          </span>
        )}
        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex items-start justify-between gap-3">
            {course}
            {amount}
          </div>
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            {who}
            {status}
          </div>
          <div className="rounded-lg bg-white/[0.025] px-3 py-2">
            <SplitBar split={split} className="h-1.5" />
            {summary && <p className="mono mt-1.5 text-[11.5px] leading-4 text-fg-muted">{summary}</p>}
          </div>
          {actions}
        </div>
      </div>
      <span className="sr-only">{`Montant ${formatPrice(s.amount_cents, currency)}`}</span>
    </li>
  );
}
