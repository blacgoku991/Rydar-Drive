import type { Metadata } from "next";
import { BookingSiteForm } from "@/components/booking/booking-site-form";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { env } from "@/lib/env";
import { domainToken } from "./actions";

export const metadata: Metadata = { title: "Mini-site" };
export const dynamic = "force-dynamic";

export default async function BookingSitePage() {
  const ctx = await requireOrg();
  const [{ data: site }, { data: usage }] = await Promise.all([
    ctx.supabase.from("booking_sites").select("*").eq("organization_id", ctx.org.id).single(),
    ctx.supabase.rpc("org_usage", { p_org: ctx.org.id }),
  ]);
  const limits = (usage as any)?.limits ?? {};
  return (
    <>
      <PageHeader eyebrow="Canaux" title="Mini-site de réservation" description="Option pour les rattacheurs sans site : vos clients réservent en 30 secondes, sans compte ni application." />
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
