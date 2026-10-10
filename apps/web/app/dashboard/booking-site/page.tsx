import { ERROR_MESSAGES, bookingOperatorGaps } from "@rydar/shared";
import { Globe } from "lucide-react";
import type { Metadata } from "next";
import { BookingSiteForm } from "@/components/booking/booking-site-form";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { privateFleetPage } from "@/lib/private-fleet";
import { bookingSitesEnabled } from "@/lib/booking-sites";
import { env } from "@/lib/env";
import { domainToken } from "./actions";

export const metadata: Metadata = { title: "Mini-site" };
export const dynamic = "force-dynamic";

/**
 * Mini-site de réservation (docs/REFONTE-PANELS.md § 5.6, lot R10 ; coupé en production par la plateforme) : mise en
 * page sans débordement, liste « Pour mettre en ligne » sous l'interrupteur (bookingSitePublishable +
 * bookingOperatorGaps, mêmes règles que l'enregistrement), vocabulaire du lexique. Lectures et action inchangées, plus
 * l'identité de l'organisation (lecture seule) pour la liste.
 */
export default async function BookingSitePage() {
  const ctx = await requireOrg();
  // Flotte Privée : son site est relié par l'API v1 (mini-sites coupés pour la plateforme) → « Mon site »
  privateFleetPage(ctx, { redirect: "/dashboard/site" });
  const header = <PageHeader title="Mini-site de réservation" description="Une page de réservation prête à l'emploi, si vous n'avez pas de site." />;
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
  const admin = isAdminRole(ctx.role);
  const [{ data: site }, { data: usage }, { data: identity }] = await Promise.all([
    ctx.supabase.from("booking_sites").select("*").eq("organization_id", ctx.org.id).single(),
    ctx.supabase.rpc("org_usage", { p_org: ctx.org.id }),
    // Identité de l'exploitant (bas du mini-site) : ce qui manque pour la mise en ligne, dit avant l'enregistrement
    ctx.supabase.from("organizations").select("legal_name, siret, address, postal_code, city, vtc_registration").eq("id", ctx.org.id).maybeSingle(),
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
          canEdit={admin}
          planAllows={Boolean(limits.booking_site)}
          customDomainAllowed={Boolean(limits.custom_domain)}
          operatorGaps={identity ? bookingOperatorGaps(identity as never) : null}
          offersHref={admin ? "/dashboard/settings?tab=billing" : null}
        />
      </PageBody>
    </>
  );
}
