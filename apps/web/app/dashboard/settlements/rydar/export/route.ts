// Export CSV du relevé mensuel des frais plateforme (owner / admin de la centrale, client de session :
// org_platform_statement vérifie le rôle en base). UTF-8 avec BOM, séparateur « ; », montants en euros « 12,50 ».
import {
  PAYMENT_METHOD_LABELS, PLATFORM_ENTRY_KIND_META, platformEntryStatusMeta, PLATFORM_PAYMENT_METHOD_META, PLATFORM_PAYMENT_STATUS_META,
  type PaymentMethod, type PlatformEntry, type PlatformPayment, type PlatformStatement,
} from "@rydar/shared";
import { NextResponse } from "next/server";
import { currentMonth, getPayerContext, parseMonth } from "@/components/platform-fees/org-payer-context";
import { rideSettlementText } from "@/components/platform-fees/org-platform-format";

export const dynamic = "force-dynamic";

const HEADER = [
  "Date",
  "Type",
  "Libellé",
  "N° course",
  "Départ",
  "Arrivée",
  "Prix course (€)",
  "Paiement client",
  "Règlement chauffeur",
  "Statut",
  "Échéance",
  "Frais (€)",
  "Paiement déclaré (€)",
  "Paiement reçu (€)",
  "Référence / motif",
];

/** Centimes → « 12,50 » ; « -2,00 » ; vide si null. */
function euros(cents: number | null | undefined) {
  if (cents == null) return "";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

/** Cellule : neutralise les formules (=, +, -, @ en tête de texte libre : adresse, note, référence…), sauf les montants « -2,00 ». */
function cell(v: string | number | null | undefined) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-\d+,\d{2}$/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const line = (values: (string | number | null | undefined)[]) => values.map(cell).join(";");

function dateTime(iso: string | null | undefined, timeZone: string) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}
function date(iso: string | null | undefined, timeZone: string) {
  if (!iso) return "";
  const d = iso.length === 10 ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: iso.length === 10 ? "UTC" : timeZone }).format(d);
}

function entryType(e: PlatformEntry) {
  if (e.kind === "adjustment") return e.amount_cents < 0 ? "Avoir" : "Frais ajoutés";
  return PLATFORM_ENTRY_KIND_META[e.kind].label;
}

const settlement = (e: PlatformEntry) => rideSettlementText(e.ride)?.text ?? "";

function entryRow(e: PlatformEntry, tz: string) {
  const status = e.status === "pending" ? "Baisse en attente de Rydar (non comptée)" : platformEntryStatusMeta(e).label;
  return line([
    dateTime(e.occurred_at, tz),
    entryType(e),
    e.label,
    e.ride?.number ?? "",
    e.ride?.pickup ?? "",
    e.ride?.dropoff ?? "",
    euros(e.ride?.price_cents),
    e.ride ? (PAYMENT_METHOD_LABELS[e.ride.payment_method as PaymentMethod] ?? e.ride.payment_method) : "",
    settlement(e),
    status,
    date(e.due_at, tz),
    euros(e.amount_cents),
    "",
    "",
    [e.reason, e.review_note ? `Rydar : ${e.review_note}` : null].filter(Boolean).join(" · "),
  ]);
}

function paymentRow(p: PlatformPayment, tz: string) {
  const status = p.status === "confirmed" && p.source === "admin" ? "Enregistré par Rydar" : PLATFORM_PAYMENT_STATUS_META[p.status].label;
  return line([
    dateTime(p.status === "confirmed" ? (p.reviewed_at ?? p.declared_at) : p.declared_at, tz),
    `Paiement (${PLATFORM_PAYMENT_METHOD_META[p.method]?.label ?? "Autre"})`,
    p.paid_on ? `Paiement du ${date(p.paid_on, tz)}` : "Paiement",
    "",
    "",
    "",
    "",
    "",
    "",
    status,
    "",
    "",
    euros(p.amount_cents),
    p.status === "confirmed" ? euros(p.received_cents) : "",
    [p.reference ? `Réf. ${p.reference}` : null, p.note, p.review_note ? `Rydar : ${p.review_note}` : null].filter(Boolean).join(" · "),
  ]);
}

export async function GET(request: Request) {
  const ctx = await getPayerContext();
  if (!ctx) return NextResponse.json({ error: "Connexion requise." }, { status: 401 });
  if (!ctx.canPay) return NextResponse.json({ error: "Réservé au propriétaire ou à un administrateur de la centrale." }, { status: 403 });
  const tz = ctx.org.timezone || "Europe/Paris";
  const month = parseMonth(new URL(request.url).searchParams.get("mois")) ?? currentMonth(tz);
  const { data, error } = await ctx.supabase.rpc("org_platform_statement", { p_org: ctx.org.id, p_month: month });
  if (error || !data) return NextResponse.json({ error: "Relevé indisponible." }, { status: error?.code === "42501" ? 403 : 500 });
  const s = data as PlatformStatement;
  const stz = s.organization.timezone || tz;

  // Mouvements du mois dans l'ordre chronologique (écritures + paiements)
  const rows = [
    ...s.entries.map((e) => ({ at: e.occurred_at, text: entryRow(e, stz) })),
    ...s.payments.map((p) => ({ at: p.status === "confirmed" ? (p.reviewed_at ?? p.declared_at) : p.declared_at, text: paymentRow(p, stz) })),
  ].sort((x, y) => x.at.localeCompare(y.at));

  const csv = [
    line(["Relevé des frais plateforme Rydar", s.organization.name, `Mois ${s.month}`, `Référence ${s.organization.reference}`]),
    line(["Solde d'ouverture (€)", euros(s.opening_cents)]),
    line(["Frais du mois (€)", euros(s.fees_cents)]),
    line(["Reçu par Rydar (€)", euros(s.received_cents)]),
    line(["Solde de clôture (€)", euros(s.closing_cents)]),
    "",
    line(HEADER),
    ...rows.map((r) => r.text),
  ].join("\r\n");

  const slug = (ctx.org.slug || "centrale").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "centrale";
  return new NextResponse(`﻿${csv}\r\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rydar-frais-plateforme-${slug}-${s.month}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
