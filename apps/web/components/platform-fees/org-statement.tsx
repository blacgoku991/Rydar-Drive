// Relevé mensuel des frais Rydar (côté centrale ou flotte) : reste dû au début du mois, frais du mois, reçu par Rydar,
// reste dû à la fin ; le détail des frais, une ligne par course (« #1022 · 1 oct. 10:08 · Gare Saint-Lazare → Accor
// Arena · 60 € payé en ligne », +5 €, règlement chauffeur d'une centrale), groupé par échéance (« À régler le 5 nov. ·
// 47 courses · 235 € »), 20 lignes puis un repli ; chaque paiement du mois. Corrections, avoirs, baisses en attente ou
// refusées gardent leurs mentions. Rendu serveur ; montants et export CSV inchangés.
import {
  PAYMENT_METHOD_LABELS,
  PLATFORM_ENTRY_KIND_META,
  PLATFORM_PAYMENT_STATUS_META,
  dateTimeFormat,
  formatPrice,
  platformEntryStatusMeta,
  type PlatformEntry,
  type PlatformPayment,
  type PlatformStatement,
} from "@rydar/shared";
import Link from "next/link";
import {
  dayTime, platformMethodLabel, price, rideSettlementText, shortDay, showSettlementColumn, signedPrice,
} from "@/components/platform-fees/org-platform-format";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/misc";
import { plural } from "@/lib/wording";
import { cn } from "@/lib/utils";

const NB = " ";
/** Lignes montrées d'emblée dans chaque échéance ; les suivantes sont dans un repli. */
export const STATEMENT_FIRST_LINES = 20;

/** « septembre 2026 » (formateur mémorisé) */
export function monthLabel(month: string, style: "long" | "short" = "long") {
  return dateTimeFormat("fr-FR", { month: style, year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`));
}

const capitalize = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

/** « Reste dû au 1er octobre » / « Avance au 1er octobre » ; « … fin octobre » ; « … à ce jour » (mois en cours). */
export function statementBalanceLabel(cents: number, when: string) {
  return `${cents < 0 ? "Avance en votre faveur" : "Reste dû"} ${when}`;
}

/** Libellé d'une ligne qui n'est pas une course : « Correction », « Avoir de Rydar », « Frais ajoutés par Rydar ». */
function kindLabel(e: PlatformEntry) {
  if (e.kind === "adjustment") return e.amount_cents < 0 ? "Avoir de Rydar" : "Frais ajoutés par Rydar";
  if (e.kind === "ride") return "Frais de course";
  return PLATFORM_ENTRY_KIND_META[e.kind].label;
}

/** « 60 € payé en ligne », « 55 € en espèces », « 40 € carte à bord » */
function ridePayment(r: NonNullable<PlatformEntry["ride"]>, currency: string) {
  const label = PAYMENT_METHOD_LABELS[r.payment_method] ?? r.payment_method;
  const how = r.payment_method === "cash" ? "en espèces" : label.charAt(0).toLowerCase() + label.slice(1);
  return r.price_cents == null ? `sans prix · ${how}` : `${formatPrice(r.price_cents, currency)} ${how}`;
}

function amountClass(e: PlatformEntry) {
  if (e.status === "rejected") return "text-fg-muted line-through";
  if (e.status === "pending") return "text-amber";
  if (e.amount_cents < 0) return "text-green";
  return "text-fg";
}

// ---------------------------------------------------------------------------- résumé du mois
export function StatementSummary({ s, current }: { s: PlatformStatement; current: boolean }) {
  const cur = s.organization.currency || "EUR";
  const label = monthLabel(s.month);
  const items = [
    { label: statementBalanceLabel(s.opening_cents, `au 1er ${label}`), value: formatPrice(Math.abs(s.opening_cents), cur), op: null },
    { label: "Frais du mois", value: price(s.fees_cents, cur), op: "+" },
    { label: "Reçu par Rydar", value: price(s.received_cents, cur), op: "−" },
    { label: statementBalanceLabel(s.closing_cents, current ? "à ce jour" : `fin ${label}`), value: formatPrice(Math.abs(s.closing_cents), cur), op: "=" },
  ];
  return (
    <dl aria-label="Résumé du mois" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((it) => (
        <div key={it.label} className="surface min-w-0 rounded-xl px-4 py-3.5">
          <dt className="flex items-start gap-1.5 text-[13px] text-fg-muted">
            {it.op && (
              <span className="mono text-fg-muted" aria-hidden>
                {it.op}
              </span>
            )}
            {it.label}
          </dt>
          <dd className="mt-1.5 text-[22px] font-semibold leading-none tabular-nums tracking-tight text-fg sm:text-[24px]">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------- détail des frais
type Group = { due: string; entries: PlatformEntry[]; rides: number; others: number; postedCents: number };

/** Lignes groupées par échéance (la plus proche d'abord), dans l'ordre du relevé à l'intérieur. */
export function groupByDue(entries: PlatformEntry[], timeZone: string): Group[] {
  const map = new Map<string, Group>();
  for (const e of entries) {
    const key = dateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(new Date(e.due_at));
    const g = map.get(key) ?? { due: e.due_at, entries: [], rides: 0, others: 0, postedCents: 0 };
    g.entries.push(e);
    if (e.kind === "ride") g.rides += 1;
    else g.others += 1;
    if (e.status === "posted") g.postedCents += e.amount_cents;
    map.set(key, g);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g);
}

/** « À régler le 5 nov. · 47 courses · 235 € » (échéance à venir) / « Échéance du 5 oct. · 23 courses · 115 € » (passée). */
function groupTitle(g: Group, timeZone: string, now: number, currency: string) {
  const day = shortDay(g.due, timeZone, now);
  const when = Date.parse(g.due) > now ? `À régler le ${day}` : `Échéance du ${day}`;
  const count = [g.rides ? plural(g.rides, "course") : null, g.others ? plural(g.others, "autre ligne", "autres lignes") : null].filter(Boolean).join(" · ");
  return `${when} · ${count} · ${formatPrice(g.postedCents, currency)}`;
}

function EntryLine({ e, timeZone, currency, settlement }: { e: PlatformEntry; timeZone: string; currency: string; settlement: boolean }) {
  const r = e.ride;
  const st = settlement ? rideSettlementText(r) : null;
  const status = e.status === "posted" ? null : platformEntryStatusMeta(e);
  const head =
    e.kind === "ride" && r
      ? [`#${r.number}`, dayTime(e.occurred_at, timeZone), r.pickup && r.dropoff ? `${r.pickup} → ${r.dropoff}` : null, ridePayment(r, currency)]
      : [r ? `#${r.number}` : null, kindLabel(e), dayTime(e.occurred_at, timeZone), e.kind === "adjustment" && e.created_by_name ? e.created_by_name : null];
  const text = head.filter(Boolean).join(" · ");
  return (
    <li className={cn("flex items-start justify-between gap-3 px-4 py-2.5 sm:px-5", e.status === "pending" && "bg-amber/[0.03]")}>
      <div className="min-w-0">
        <p className="text-[13px] text-fg [overflow-wrap:anywhere]">
          {r ? (
            <>
              <Link href={`/dashboard/rides/${r.id}`} prefetch={false} className="mono font-semibold hover:text-brand">
                #{r.number}
              </Link>
              {text.slice(`#${r.number}`.length)}
            </>
          ) : (
            text
          )}
        </p>
        {e.kind !== "ride" && e.label && <p className="text-[12px] text-fg-muted">{e.label}</p>}
        {e.reason && <p className="text-[12px] text-fg-muted">{e.reason}</p>}
        {e.status === "pending" && <p className="text-[12px] text-amber">Ne compte pas tant que Rydar ne l&apos;a pas acceptée.</p>}
        {e.review_note && <p className="text-[12px] text-fg-muted">Rydar{NB}: «{NB}{e.review_note}{NB}»</p>}
        {(st || status) && (
          <p className="mt-1 flex flex-wrap items-center gap-1.5">
            {st && <Badge tone={st.tone}>{st.text}</Badge>}
            {status && <Badge tone={status.tone}>{e.status === "pending" ? "En attente de Rydar" : status.label}</Badge>}
          </p>
        )}
      </div>
      <p className={cn("mono shrink-0 whitespace-nowrap text-[14px] font-semibold", amountClass(e))}>{signedPrice(e.amount_cents, currency)}</p>
    </li>
  );
}

export function StatementEntries({ s, now }: { s: PlatformStatement; now: number }) {
  const cur = s.organization.currency || "EUR";
  const tz = s.organization.timezone || "Europe/Paris";
  const pending = s.entries.filter((e) => e.status === "pending");
  const settlement = showSettlementColumn(s);
  const groups = groupByDue(s.entries, tz);
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={`Détail des frais · ${s.entries.length}`}
        description="Une ligne par course terminée ; un prix modifié ensuite ajoute une correction (une baisse attend l'accord de Rydar)."
      />
      {s.entries.length === 0 ? (
        <EmptyState size="compact" title="Aucun frais ce mois-ci." description="Les frais apparaissent ici à la fin de chaque course." />
      ) : (
        <>
          {groups.map((g) => {
            const first = g.entries.slice(0, STATEMENT_FIRST_LINES);
            const rest = g.entries.slice(STATEMENT_FIRST_LINES);
            return (
              <section key={g.due} aria-label={groupTitle(g, tz, now, cur)} className="border-t border-line">
                <h3 className="bg-white/[0.02] px-4 py-2.5 text-[13px] font-medium text-fg sm:px-5">{groupTitle(g, tz, now, cur)}</h3>
                <ul className="divide-y divide-line/70">
                  {first.map((e) => (
                    <EntryLine key={e.id} e={e} timeZone={tz} currency={cur} settlement={settlement} />
                  ))}
                </ul>
                {rest.length > 0 && (
                  <Disclosure
                    title={rest.length === 1 ? "Afficher la dernière ligne" : `Afficher les ${rest.length} autres lignes`}
                    className="border-t border-line"
                    summaryClassName="px-4 text-[13px] text-fg-muted hover:text-fg sm:px-5"
                  >
                    <ul className="divide-y divide-line/70 border-t border-line">
                      {rest.map((e) => (
                        <EntryLine key={e.id} e={e} timeZone={tz} currency={cur} settlement={settlement} />
                      ))}
                    </ul>
                  </Disclosure>
                )}
              </section>
            );
          })}
          {pending.length > 0 && (
            <p className="border-t border-line px-4 py-3 text-[13px] text-amber sm:px-5">
              {pending.length === 1 ? "1 baisse" : `${pending.length} baisses`} en attente de Rydar (
              {price(
                pending.reduce((n, e) => n + e.amount_cents, 0),
                cur,
              )}
              ){NB}: non comptée{pending.length > 1 ? "s" : ""} dans les totaux.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------- paiements du mois
export function StatementPayments({ s }: { s: PlatformStatement }) {
  const cur = s.organization.currency || "EUR";
  const tz = s.organization.timezone || "Europe/Paris";
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={`Paiements du mois · ${s.payments.length}`}
        description="Déclarés ou traités par Rydar ce mois-ci. Seuls les paiements confirmés (montant reçu) font baisser le solde."
      />
      {s.payments.length === 0 ? (
        <EmptyState size="compact" title="Aucun paiement ce mois-ci." description="Vos déclarations « J'ai payé » et les paiements enregistrés par Rydar apparaîtront ici." />
      ) : (
        <ul className="divide-y divide-line">
          {s.payments.map((p) => (
            <PaymentLine key={p.id} p={p} currency={cur} timeZone={tz} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function PaymentLine({ p, currency, timeZone }: { p: PlatformPayment; currency: string; timeZone: string }) {
  const meta = PLATFORM_PAYMENT_STATUS_META[p.status];
  const partial = p.status === "confirmed" && p.received_cents != null && p.received_cents !== p.amount_cents;
  return (
    <li className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between sm:px-5">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span
            className={cn("mono text-[14px] font-semibold", p.status === "rejected" || p.status === "cancelled" ? "text-fg-muted line-through" : "text-fg")}
          >
            {formatPrice(p.amount_cents, currency)}
          </span>
          <Badge tone={meta.tone}>{p.status === "confirmed" && p.source === "admin" ? "Enregistré par Rydar" : meta.label}</Badge>
          {partial && <span className="text-[12px] text-amber">{formatPrice(p.received_cents, currency)} reçus</span>}
        </p>
        <p className="mt-0.5 text-[12px] text-fg-muted">
          {[platformMethodLabel(p.method), p.paid_on ? `payé le ${shortDay(p.paid_on, timeZone)}` : null, p.reference ? `réf. ${p.reference}` : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {p.note && <p className="text-[12px] text-fg-muted">«{NB}{p.note}{NB}»</p>}
        {p.review_note && <p className={cn("text-[12px]", p.status === "rejected" ? "text-red" : "text-fg-muted")}>Rydar{NB}: «{NB}{p.review_note}{NB}»</p>}
      </div>
      <div className="shrink-0 text-[12px] text-fg-muted sm:text-right">
        <p>{p.source === "admin" ? "Saisi par Rydar" : `Déclaré le ${dayTime(p.declared_at, timeZone)}`}</p>
        {p.reviewed_at && p.status !== "cancelled" && (
          <p>
            {p.status === "confirmed" ? "Confirmé" : "Traité"} le {dayTime(p.reviewed_at, timeZone)}
          </p>
        )}
        {p.status === "cancelled" && <p>Déclaration retirée</p>}
        {p.status === "confirmed" && <p className="mono font-semibold text-green">{price(-(p.received_cents ?? p.amount_cents), currency)} sur le solde</p>}
      </div>
    </li>
  );
}

export { capitalize as capitalizeMonth };
