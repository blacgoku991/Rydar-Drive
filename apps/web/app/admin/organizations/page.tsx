import { DISPATCH_MODEL_META, ORG_STATUS_META, formatDate, type DispatchModel, type OrgStatus } from "@rydar/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { CreateOrganizationSheet } from "@/components/admin/admin-widgets";
import { CreatePrivateFleetSheet } from "@/components/admin/private-fleet";
import { apiAccessOf, effectiveLimits } from "@/components/admin/private-fleet-state";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { requireSuperAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Clients" };
export const dynamic = "force-dynamic";

/** Filtres de la liste (?type=) : tous, ou les clients Flotte Privée seulement. */
const FILTERS = [
  { key: "tous", label: "Tous", privateFleet: false },
  { key: "flotte-privee", label: "Flotte Privée", privateFleet: true },
] as const;

export default async function OrganizationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSuperAdmin();
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f.key === sp.type) ?? FILTERS[0];
  const db = session.supabase;
  let list = db
    .from("organizations")
    .select("id, name, slug, status, city, email, created_at, dispatch_model, private_fleet, plan:plans(name)")
    .order("created_at", { ascending: false });
  if (filter.privateFleet) list = list.eq("private_fleet", true);
  const [{ data: orgs }, { data: plans }, all, privateFleets] = await Promise.all([
    list,
    db.from("plans").select("id, code, name, limits").eq("is_active", true).order("sort_order"),
    db.from("organizations").select("id", { count: "exact", head: true }),
    db.from("organizations").select("id", { count: "exact", head: true }).eq("private_fleet", true),
  ]);
  const activePlans = (plans ?? []) as { id: string; code: string; name: string; limits: Record<string, unknown> | null }[];
  const counts: Record<string, number> = { tous: all.count ?? 0, "flotte-privee": privateFleets.count ?? 0 };
  return (
    <>
      <PageHeader
        eyebrow="Plateforme"
        title="Clients"
        description="Chaque rattacheur est un tenant isolé (RLS) : données, chauffeurs, courses, API et mini-site."
        actions={
          <div className="flex flex-wrap gap-2">
            <CreatePrivateFleetSheet
              rootDomain={env.rootDomain}
              plans={activePlans.map((p) => ({
                id: p.id,
                name: p.name,
                api: apiAccessOf(effectiveLimits({ planId: p.id, planLimits: p.limits, override: null, privateFleet: false })),
              }))}
            />
            <CreateOrganizationSheet plans={activePlans.map((p) => ({ code: p.code, name: p.name }))} />
          </div>
        }
      />
      <PageBody className="space-y-4">
        <nav aria-label="Filtrer les rattacheurs" className="flex flex-wrap gap-2">
          {FILTERS.map((f) => {
            const active = f.key === filter.key;
            return (
              <Link
                key={f.key}
                href={f.privateFleet ? `/admin/organizations?type=${f.key}` : "/admin/organizations"}
                prefetch={false}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-[13px] transition-colors",
                  active ? "border-brand/40 bg-brand/[0.08] text-fg" : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
                )}
              >
                {f.label}
                <span className="num text-[12px] text-fg-muted">{counts[f.key] ?? 0}</span>
              </Link>
            );
          })}
        </nav>
        <Card className="overflow-hidden">
          <Table>
            <THead>
              <tr><TH>Rattacheur</TH><TH>Modèle</TH><TH>Identifiant</TH><TH>Offre</TH><TH>Contact</TH><TH>Créé le</TH><TH>Statut</TH></tr>
            </THead>
            <tbody>
              {(orgs ?? []).map((o: any) => (
                <TR key={o.id} className="relative">
                  <TD><Link href={`/admin/organizations/${o.id}`} prefetch={false} className="absolute inset-0" aria-label={o.name} /><p className="font-medium">{o.name}</p><p className="text-[12px] text-fg-subtle">{o.city}</p></TD>
                  <TD>
                    {o.private_fleet ? (
                      <Badge tone="brand" dot={false}>Flotte Privée</Badge>
                    ) : (
                      <Badge tone={o.dispatch_model === "centrale" ? "violet" : "neutral"} dot={false}>
                        {o.dispatch_model === "centrale" ? "Centrale" : DISPATCH_MODEL_META[(o.dispatch_model ?? "fleet") as DispatchModel].label}
                      </Badge>
                    )}
                  </TD>
                  <TD className="num text-[12.5px] text-fg-muted">{o.slug}</TD>
                  <TD><Badge tone="neutral" dot={false}>{(Array.isArray(o.plan) ? o.plan[0] : o.plan)?.name ?? "—"}</Badge></TD>
                  <TD className="text-[12.5px] text-fg-muted">{o.email}</TD>
                  <TD className="text-[12.5px] text-fg-muted">{formatDate(o.created_at)}</TD>
                  <TD><Badge tone={ORG_STATUS_META[o.status as OrgStatus].tone}>{ORG_STATUS_META[o.status as OrgStatus].label}</Badge></TD>
                </TR>
              ))}
              {!orgs?.length && (
                <TR>
                  <TD colSpan={7} className="py-8 text-center text-[13px] text-fg-muted">
                    {filter.privateFleet ? "Aucun client Flotte Privée pour l'instant." : "Aucun rattacheur pour l'instant."}
                  </TD>
                </TR>
              )}
            </tbody>
          </Table>
        </Card>
      </PageBody>
    </>
  );
}
