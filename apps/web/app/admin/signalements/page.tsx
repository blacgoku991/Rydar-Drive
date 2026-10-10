import { formatNumber } from "@rydar/shared";
import { History, ShieldBan } from "lucide-react";
import type { Metadata } from "next";
import { FRAUD_REPORTS_LIMIT, readFraudReports } from "@/components/admin/fraud-data";
import { FraudReportsList } from "@/components/admin/fraud-reports";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Callout } from "@/components/ui/callout";
import { Card, CardHeader } from "@/components/ui/card";
import { requireSuperAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Signalements de fraude" };
export const dynamic = "force-dynamic";

/**
 * Signalements de fraude (docs/REFONTE-PANELS.md, R2) : chauffeurs bannis par une centrale et signalés à Rydar. Mêmes
 * actions qu'avant leur déplacement depuis /admin/centrales (bannir de toute la plateforme avec les cases des fiches
 * d'autres centrales, lever, classer sans suite) ; ceux à examiner d'abord, les autres ensuite.
 */
export default async function FraudReportsPage() {
  const session = await requireSuperAdmin();
  const { reports, error } = await readFraudReports(session.supabase);
  const open = reports.filter((r) => r.status === "open");
  const closed = reports.filter((r) => r.status !== "open");
  return (
    <>
      <PageHeader
        title="Signalements de fraude"
        description={"Chauffeurs signalés par les centrales\u00a0: bannir de toute la plateforme ou classer sans suite."}
      />
      <PageBody className="space-y-6">
        {error ? (
          <Callout tone="danger" title="Lecture impossible, réessayez dans un instant." />
        ) : (
          <>
            <Card className="overflow-hidden">
              <CardHeader
                icon={<ShieldBan />}
                title="À examiner"
                description={"Les identités (téléphone, e-mail, carte VTC…) ne sont jamais affichées en entier\u00a0: seuls des indices masqués."}
              />
              <FraudReportsList reports={open} />
            </Card>
            {closed.length > 0 && (
              <Card className="overflow-hidden">
                <CardHeader
                  icon={<History />}
                  title="Déjà traités"
                  description="Bannissements, levées et signalements classés sans suite, du plus récent au plus ancien."
                />
                <FraudReportsList reports={closed} />
              </Card>
            )}
            {reports.length >= FRAUD_REPORTS_LIMIT && (
              <p className="text-[12.5px] text-fg-muted">Les {formatNumber(FRAUD_REPORTS_LIMIT)} signalements les plus récents sont affichés.</p>
            )}
          </>
        )}
      </PageBody>
    </>
  );
}
