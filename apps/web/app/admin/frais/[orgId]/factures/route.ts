// Export CSV des frais à facturer d'un cycle (super admin uniquement) : base de la facture récapitulative que l'éditeur
// adresse à l'organisation à la fin de chaque cycle (CGV art. 5 ; le relevé du tableau de bord n'en est pas une).
// Écritures COMPTÉES prises en compte pendant le cycle (admin_platform_invoice_lines, migration 20260924006600) :
// enregistrement, ou acceptation d'une baisse — une écriture créée après coup (prix saisi après la course) arrive dans
// le cycle de son enregistrement, jamais dans un cycle déjà facturé. Montants toutes taxes comprises.
// UTF-8 avec BOM, séparateur « ; », cellules neutralisées (modèle : dashboard/settlements/rydar/export).
import { addIsoDays, type AdminPlatformInvoiceLines } from "@rydar/shared";
import { ISO_DAY_RE, csvText, entryKindLabel } from "@/components/platform-fees/admin-platform-format";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 12345 → « 123,45 » ; null → vide. */
const euros = (cents: number | null | undefined) => (cents == null ? "" : (cents / 100).toFixed(2).replace(".", ","));

/** « 05/10/2026 14:32 » (instant, fuseau de l'organisation) ou « 05/10/2026 » (jour). */
function dateTime(iso: string | null | undefined, timeZone: string, withTime = true) {
  if (!iso) return "";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: withTime && !day ? "2-digit" : undefined,
    minute: withTime && !day ? "2-digit" : undefined,
    timeZone: day ? "UTC" : timeZone,
  })
    .format(day ? new Date(`${iso}T12:00:00Z`) : new Date(iso))
    .replace(",", "");
}

const HEADER = [
  "Pris en compte le",
  "Type",
  "Libellé",
  "Course",
  "Course terminée le",
  "Prix course (€)",
  "Montant TTC (€)",
  "Échéance",
  "Motif / note",
];

export async function GET(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const session = await getSession();
  if (!session?.profile.is_super_admin) {
    return Response.json({ error: { code: "FORBIDDEN", message: "Réservé au super admin." } }, { status: 403 });
  }
  const { orgId } = await params;
  if (!UUID.test(orgId)) return Response.json({ error: { code: "NOT_FOUND", message: "Organisation introuvable." } }, { status: 404 });
  const url = new URL(req.url);
  const from = url.searchParams.get("du") ?? "";
  const to = url.searchParams.get("au") ?? "";
  if (!ISO_DAY_RE.test(from) || !ISO_DAY_RE.test(to)) {
    return Response.json({ error: { code: "INVALID", message: "Période invalide." } }, { status: 422 });
  }

  const { data, error } = await session.supabase.rpc("admin_platform_invoice_lines", { p_org: orgId, p_from: from, p_to: to });
  if (error) {
    const forbidden = error.code === "42501" || /FORBIDDEN/.test(error.message ?? "");
    return Response.json(
      { error: { code: forbidden ? "FORBIDDEN" : "INTERNAL", message: forbidden ? "Réservé au super admin." : "Export impossible." } },
      { status: forbidden ? 403 : 500 },
    );
  }
  const d = (data ?? null) as AdminPlatformInvoiceLines | null;
  if (!d) return Response.json({ error: { code: "NOT_FOUND", message: "Organisation introuvable." } }, { status: 404 });
  if (!d.ok) return Response.json({ error: { code: d.code, message: d.message } }, { status: 422 });
  const tz = d.organization.timezone || "Europe/Paris";

  const rows = d.entries.map((e) => [
    dateTime(e.counted_at, tz),
    csvText(entryKindLabel(e)),
    csvText(e.label),
    e.ride ? String(e.ride.number) : "",
    dateTime(e.ride?.completed_at ?? null, tz, false),
    euros(e.ride?.price_cents),
    euros(e.amount_cents),
    dateTime(e.due_at, tz, false),
    csvText([e.reason, e.review_note ? `Décision : ${e.review_note}` : null].filter(Boolean).join(" · ")),
  ]);
  const summary = [
    [],
    ["Organisation", csvText(d.organization.name)],
    ["Référence", csvText(d.organization.reference)],
    ["Période (prise en compte)", `du ${dateTime(d.from, tz, false)} au ${dateTime(addIsoDays(d.to, -1), tz, false)} inclus`],
    ["Total TTC à facturer (€)", euros(d.total_cents)],
    ["Échéance (fin du cycle + délai)", dateTime(d.due_at, tz, false)],
    ["Rappel", csvText("Montants toutes taxes comprises : détailler la TVA sur la facture ; mentions de pénalités de retard et d'indemnité de 40 € (CGV, article 6).")],
  ];
  const csv = "﻿" + [HEADER.map(csvText), ...rows, ...summary].map((r) => r.join(";")).join("\r\n") + "\r\n";
  const slug = (d.organization.slug || "organisation").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "organisation";

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="frais-a-facturer-${slug}-${d.from}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
