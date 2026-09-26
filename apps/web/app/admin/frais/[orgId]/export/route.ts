// Export CSV du relevé mensuel des frais plateforme d'une centrale (super admin uniquement).
// UTF-8 avec BOM, séparateur « ; », montants en euros avec virgule (ouverture directe dans Excel FR).
import type { AdminPlatformAccount, PlatformEntry, PlatformPayment } from "@rydar/shared";
import {
  MONTH_RE,
  entryKindLabel,
  entryStatusMeta,
  paymentStatusLabel,
  platformMethodLabel,
  rideSettlementLabel,
  ridePaymentLabel,
} from "@/components/platform-fees/admin-platform-format";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 12345 → « 123,45 » ; null → vide. */
const euros = (cents: number | null | undefined) => (cents == null ? "" : (cents / 100).toFixed(2).replace(".", ","));

/** Texte libre : neutralise les formules (=, +, -, @) et échappe « ; », guillemets et retours à la ligne. */
function text(v: string | null | undefined) {
  let s = (v ?? "").replace(/\r?\n/g, " ").trim();
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function dateTime(iso: string | null | undefined, timeZone: string) {
  if (!iso) return "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  const tz = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? "UTC" : timeZone;
  const withTime = !/^\d{4}-\d{2}-\d{2}$/.test(iso);
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: withTime ? "2-digit" : undefined,
    minute: withTime ? "2-digit" : undefined,
    timeZone: tz,
  })
    .format(d)
    .replace(",", "");
}

const HEADER = [
  "Date",
  "Type",
  "Libellé",
  "Course",
  "Départ",
  "Arrivée",
  "Prix course (€)",
  "Encaissement",
  "Règlement chauffeur",
  "Montant écriture (€)",
  "Frais comptés (€)",
  "Statut",
  "Échéance",
  "Motif / note",
  "Paiement déclaré (€)",
  "Paiement reçu (€)",
  "Moyen",
  "Référence",
];

function entryRow(e: PlatformEntry, tz: string) {
  return [
    dateTime(e.occurred_at, tz),
    text(entryKindLabel(e)),
    text(e.label),
    e.ride ? String(e.ride.number) : "",
    text(e.ride?.pickup),
    text(e.ride?.dropoff),
    euros(e.ride?.price_cents),
    text(e.ride ? ridePaymentLabel(e.ride.payment_method) : ""),
    text(e.ride ? rideSettlementLabel(e.ride) : ""),
    euros(e.amount_cents),
    // Seules les écritures comptabilisées comptent (une baisse en attente ou refusée n'est pas déduite)
    euros(e.status === "posted" ? e.amount_cents : 0),
    text(entryStatusMeta(e).label),
    dateTime(e.due_at, tz),
    text([e.reason, e.review_note ? `Décision : ${e.review_note}` : null].filter(Boolean).join(" · ")),
    "",
    "",
    "",
    "",
  ];
}

function paymentRow(p: PlatformPayment, tz: string) {
  return [
    dateTime(p.reviewed_at ?? p.declared_at, tz),
    "Paiement",
    text(p.source === "admin" ? "Saisi par Rydar" : `Déclaré par la centrale${p.declared_by_name ? ` (${p.declared_by_name})` : ""}`),
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    text(paymentStatusLabel(p)),
    "",
    text([p.paid_on ? `Payé le ${dateTime(p.paid_on, tz)}` : null, p.note, p.review_note ? `${p.status === "declared" ? "Rouvert" : "Décision"} : ${p.review_note}` : null].filter(Boolean).join(" · ")),
    euros(p.amount_cents),
    euros(p.status === "confirmed" ? p.received_cents : null),
    text(platformMethodLabel(p.method)),
    text(p.reference),
  ];
}

export async function GET(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const session = await getSession();
  if (!session?.profile.is_super_admin) {
    return Response.json({ error: { code: "FORBIDDEN", message: "Réservé au super admin." } }, { status: 403 });
  }
  const { orgId } = await params;
  if (!UUID.test(orgId)) return Response.json({ error: { code: "NOT_FOUND", message: "Centrale introuvable." } }, { status: 404 });
  const mois = new URL(req.url).searchParams.get("mois");
  const month = mois && MONTH_RE.test(mois) ? mois : null;

  const { data, error } = await session.supabase.rpc("admin_platform_account", { p_org: orgId, p_month: month });
  if (error) {
    const forbidden = error.code === "42501" || /FORBIDDEN/.test(error.message ?? "");
    return Response.json(
      { error: { code: forbidden ? "FORBIDDEN" : "INTERNAL", message: forbidden ? "Réservé au super admin." : "Export impossible." } },
      { status: forbidden ? 403 : 500 },
    );
  }
  const d = (data ?? null) as AdminPlatformAccount | null;
  if (!d?.statement) return Response.json({ error: { code: "NOT_FOUND", message: "Centrale introuvable." } }, { status: 404 });
  const s = d.statement;
  const tz = s.organization.timezone || "Europe/Paris";

  // Écritures et paiements du mois, dans l'ordre chronologique
  const lines: { at: string; cells: string[] }[] = [
    ...s.entries.map((e) => ({ at: e.occurred_at, cells: entryRow(e, tz) })),
    ...s.payments.map((p) => ({ at: p.reviewed_at ?? p.declared_at, cells: paymentRow(p, tz) })),
  ].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));

  const summary = [
    [],
    ["Centrale", text(s.organization.name)],
    ["Référence", text(s.organization.reference)],
    ["Mois", s.month],
    ["Solde d'ouverture (€)", euros(s.opening_cents)],
    ["Frais du mois (€)", euros(s.fees_cents)],
    ["Reçu dans le mois (€)", euros(s.received_cents)],
    ["Solde de clôture (€)", euros(s.closing_cents)],
  ];
  const csv = "﻿" + [HEADER.map(text), ...lines.map((l) => l.cells), ...summary].map((r) => r.join(";")).join("\r\n") + "\r\n";
  const slug = (d.organization.slug || "centrale").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "centrale";

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="frais-rydar-${slug}-${s.month}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
