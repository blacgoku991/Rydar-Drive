import type { Metadata } from "next";
import { OrgStatementPage } from "@/components/platform-fees/org-statement-page";

export const metadata: Metadata = { title: "Relevé des frais plateforme" };
export const dynamic = "force-dynamic";

/**
 * Relevé mensuel des frais plateforme à régler à Rydar (owner / admin de la centrale ; une flotte a le sien sous
 * /dashboard/rydar/releve, même rendu).
 *   ?mois=YYYY-MM  (défaut : mois en cours, fuseau de la centrale)
 */
export default function PlatformStatementPage({ searchParams }: { searchParams: Promise<{ mois?: string }> }) {
  return <OrgStatementPage searchParams={searchParams} />;
}
