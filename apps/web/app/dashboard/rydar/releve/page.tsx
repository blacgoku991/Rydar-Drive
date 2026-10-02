import type { Metadata } from "next";
import { OrgStatementPage } from "@/components/platform-fees/org-statement-page";

export const metadata: Metadata = { title: "Relevé des frais Rydar" };
export const dynamic = "force-dynamic";

/**
 * Relevé mensuel des frais Rydar d'une flotte (owner / admin) — même rendu que celui des centrales.
 *   ?mois=YYYY-MM  (défaut : mois en cours, fuseau de la flotte)
 */
export default function FleetStatementPage({ searchParams }: { searchParams: Promise<{ mois?: string }> }) {
  return <OrgStatementPage searchParams={searchParams} />;
}
