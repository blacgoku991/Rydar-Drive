// Export CSV / relevé mensuel du réseau partagé (tout membre de l'organisation, client de session : les RPC
// org_network_given / org_network_received vérifient l'appartenance en base). Mêmes colonnes et totaux pour les
// courses confiées et les courses reçues (components/network-share/csv.ts) ; UTF-8 avec BOM, séparateur « ; ».
// Réseau fermé par Rydar : relevé toujours disponible pour une organisation déjà membre (comptabilité des sommes en
// cours) ; jamais membre : 404, comme l'onglet.
//   ?vue=confiees|recues   &mois=AAAA-MM (défaut : mois en cours, fuseau de l'organisation)   &partenaire=<uuid>
import type { NetworkGivenItem, NetworkPartnerNames, NetworkReceivedItem, OrgNetworkGiven, OrgNetworkReceived } from "@rydar/shared";
import { NextResponse } from "next/server";
import { networkStatementCsv, statementFileName, statementRowsFromGiven, statementRowsFromReceived } from "@/components/network-share/csv";
import { isUuid, monthInZone, parseMonth } from "@/components/network-share/paths";
import { getOrgContext } from "@/lib/org-context";
import { networkAccess } from "@/lib/shared-network";

export const dynamic = "force-dynamic";

/** Lecture par pages de 500, 5 000 courses au plus par relevé. */
const PAGE = 500;
const MAX_ROWS = 5_000;

type Page<T> = { items: T[]; next_before: string | null };

export async function GET(request: Request) {
  const ctx = await getOrgContext();
  if (!ctx) return NextResponse.json({ error: "Connexion requise." }, { status: 401 });
  if (!(await networkAccess(ctx.supabase, ctx.org.id))) return NextResponse.json({ error: "Page introuvable." }, { status: 404 });
  const url = new URL(request.url);
  const view = url.searchParams.get("vue") === "recues" ? "recues" : "confiees";
  const tz = ctx.org.timezone || "Europe/Paris";
  const month = parseMonth(url.searchParams.get("mois")) ?? monthInZone(new Date(), tz);
  const rawPartner = url.searchParams.get("partenaire");
  const partner = isUuid(rawPartner) ? rawPartner : null;

  async function readAll<T>(fn: "org_network_given" | "org_network_received"): Promise<T[] | { status: number }> {
    const all: T[] = [];
    let before: string | null = null;
    for (;;) {
      const { data, error } = await ctx!.supabase.rpc(fn, {
        p_org: ctx!.org.id, p_filter: "all", p_partner: partner, p_month: month, p_limit: PAGE, p_before: before,
      });
      if (error) return { status: error.code === "42501" ? 403 : 500 };
      const page = (data ?? null) as Page<T> | null;
      const items = page?.items ?? [];
      all.push(...items);
      before = page?.next_before ?? null;
      if (!before || items.length === 0 || all.length >= MAX_ROWS) return all.slice(0, MAX_ROWS);
    }
  }

  const [items, names] = await Promise.all([
    view === "confiees" ? readAll<NetworkGivenItem>("org_network_given") : readAll<NetworkReceivedItem>("org_network_received"),
    partner ? ctx.supabase.rpc("network_partner_names", { p_org: ctx.org.id }) : Promise.resolve(null),
  ]);
  if (!Array.isArray(items)) return NextResponse.json({ error: "Relevé indisponible." }, { status: items.status });
  const partnerName = partner ? (((names?.data ?? {}) as NetworkPartnerNames)[partner] ?? null) : null;

  const rows =
    view === "confiees"
      ? statementRowsFromGiven(items as OrgNetworkGiven["items"], ctx.org.name)
      : statementRowsFromReceived(items as OrgNetworkReceived["items"], ctx.org.name);
  const csv = networkStatementCsv({ view, orgName: ctx.org.name, month, partnerName, rows, timeZone: tz });

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${statementFileName(view, ctx.org.slug, month)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
