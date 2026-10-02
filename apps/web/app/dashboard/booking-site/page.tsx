import { ERROR_MESSAGES } from "@rydar/shared";
import { Globe } from "lucide-react";
import type { Metadata } from "next";
import { BookingSiteForm } from "@/components/booking/booking-site-form";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { bookingSitesEnabled } from "@/lib/booking-sites";
import { env } from "@/lib/env";
import { domainToken } from "./actions";

export const metadata: Metadata = { title: "Mini-site" };
export const dynamic = "force-dynamic";

export default async function BookingSitePage() {
  const ctx = await requireOrg();
  const header = (
    <PageHeader eyebrow="Canaux" title="Mini-site de réservation" description="Option pour les rattacheurs sans site : vos clients réservent en 30 secondes, sans compte ni application." />
  );
  // Mini-sites coupés par la plateforme (super admin) : explication à la place de l'éditeur ; les réglages de la
  // centrale sont conservés et reviennent tels quels à la réactivation
  if (!(await bookingSitesEnabled())) {
    return (
      <>
        {header}
        <PageBody>
          <Card>
            <EmptyState
              icon={<Globe />}
              title={ERROR_MESSAGES.BOOKING_SITES_DISABLED!}
              description="Votre mini-site n'est plus accessible au public pour le moment. Vos réglages sont conservés et reviendront tels quels à la réactivation. Les réservations par le tableau de bord et par l'API ne sont pas concernées."
            />
          </Card>
        </PageBody>
      </>
    );
  }
  const [{ data: site }, { data: usage }] = await Promise.all([
    ctx.supabase.from("booking_sites").select("*").eq("organization_id", ctx.org.id).single(),
    ctx.supabase.rpc("org_usage", { p_org: ctx.org.id }),
  ]);
  const limits = (usage as any)?.limits ?? {};
  return (
    <>
      {header}
      <PageBody>
        <BookingSiteForm
          site={site}
          slug={ctx.org.slug}
          rootDomain={env.rootDomain}
          appUrl={env.appUrl}
          token={await domainToken(ctx.org.id)}
          canEdit={isAdminRole(ctx.role)}
          planAllows={Boolean(limits.booking_site)}
          customDomainAllowed={Boolean(limits.custom_domain)}
        />
      </PageBody>
    </>
  );
}
