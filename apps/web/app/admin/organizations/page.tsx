import { DISPATCH_MODEL_META, ORG_STATUS_META, formatDate, type DispatchModel, type OrgStatus } from "@rydar/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { CreateOrganizationSheet } from "@/components/admin/admin-widgets";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { requireSuperAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Rattacheurs" };
export const dynamic = "force-dynamic";

export default async function OrganizationsPage() {
  const session = await requireSuperAdmin();
  const [{ data: orgs }, { data: plans }] = await Promise.all([
    session.supabase.from("organizations").select("id, name, slug, status, city, email, created_at, dispatch_model, plan:plans(name)").order("created_at", { ascending: false }),
    session.supabase.from("plans").select("code, name").eq("is_active", true).order("sort_order"),
  ]);
  return (
    <>
      <PageHeader eyebrow="Plateforme" title="Rattacheurs" description="Chaque rattacheur est un tenant isolé (RLS) : données, chauffeurs, courses, API et mini-site." actions={<CreateOrganizationSheet plans={plans ?? []} />} />
      <PageBody>
        <Card className="overflow-hidden">
          <Table>
            <THead>
              <tr><TH>Rattacheur</TH><TH>Modèle</TH><TH>Identifiant</TH><TH>Offre</TH><TH>Contact</TH><TH>Créé le</TH><TH>Statut</TH></tr>
            </THead>
            <tbody>
              {(orgs ?? []).map((o: any) => (
                <TR key={o.id} className="relative">
                  <TD><Link href={`/admin/organizations/${o.id}`} className="absolute inset-0" aria-label={o.name} /><p className="font-medium">{o.name}</p><p className="text-[12px] text-fg-subtle">{o.city}</p></TD>
                  <TD>
                    <Badge tone={o.dispatch_model === "centrale" ? "violet" : "neutral"} dot={false}>
                      {o.dispatch_model === "centrale" ? "Centrale" : DISPATCH_MODEL_META[(o.dispatch_model ?? "fleet") as DispatchModel].label}
                    </Badge>
                  </TD>
                  <TD className="num text-[12.5px] text-fg-muted">{o.slug}</TD>
                  <TD><Badge tone="neutral" dot={false}>{(Array.isArray(o.plan) ? o.plan[0] : o.plan)?.name ?? "—"}</Badge></TD>
                  <TD className="text-[12.5px] text-fg-muted">{o.email}</TD>
                  <TD className="text-[12.5px] text-fg-muted">{formatDate(o.created_at)}</TD>
                  <TD><Badge tone={ORG_STATUS_META[o.status as OrgStatus].tone}>{ORG_STATUS_META[o.status as OrgStatus].label}</Badge></TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      </PageBody>
    </>
  );
}
