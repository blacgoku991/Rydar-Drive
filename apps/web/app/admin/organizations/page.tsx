import { ORG_STATUS_META, formatDate } from "@rydar/shared";
import { Building2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { NewClientButton } from "@/components/admin/new-client";
import {
  CLIENT_FILTERS, CLIENT_KIND_META, clientFilterCounts, clientFilterOf, clientKind, getClientList, matchesClientFilter, matchesClientSearch,
  type ClientFilterKey, type ClientListRow,
} from "@/components/admin/platform-data";
import { apiAccessOf, effectiveLimits } from "@/components/admin/private-fleet-state";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { FilterTabs } from "@/components/ui/filter-tabs";
import { EmptyState } from "@/components/ui/misc";
import { SearchField } from "@/components/ui/search-field";
import { DesktopTable, ListCard, MobileList, Table, TD, TH, THead, TR } from "@/components/ui/table";
import { requireSuperAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { plural } from "@/lib/wording";

export const metadata: Metadata = { title: "Clients" };
export const dynamic = "force-dynamic";

const PATH = "/admin/organizations";

/** Adresse de la liste pour un filtre et une recherche (« Tous » sans paramètre, comme avant). */
function listHref(filter: ClientFilterKey, q: string): string {
  const qs = new URLSearchParams();
  if (filter !== "tous") qs.set("type", filter);
  if (q) qs.set("q", q);
  const query = qs.toString();
  return query ? `${PATH}?${query}` : PATH;
}

function KindBadge({ row }: { row: ClientListRow }) {
  const meta = CLIENT_KIND_META[clientKind(row)];
  return (
    <Badge tone={meta.tone} dot={false}>
      {meta.label}
    </Badge>
  );
}

function StatusBadge({ row }: { row: ClientListRow }) {
  const meta = ORG_STATUS_META[row.status];
  return <Badge tone={meta?.tone ?? "neutral"}>{meta?.label ?? "Statut inconnu"}</Badge>;
}

/**
 * Clients du super admin (docs/REFONTE-PANELS.md, R3) : une seule lecture des organisations, filtres par type (?type=,
 * compteurs) et recherche (?q=, nom, ville, e-mail, identifiant ; casse et accents ignorés) en TypeScript, sans requête
 * `ilike` ; un seul bouton de création, « Nouveau client », qui demande le type. Cartes sous 768 px, tableau au-delà.
 */
export default async function OrganizationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSuperAdmin();
  const sp = await searchParams;
  const filter = clientFilterOf(sp.type);
  const q = (Array.isArray(sp.q) ? sp.q[0] : sp.q)?.trim().slice(0, 100) ?? "";
  const db = session.supabase;
  const [clients, { data: plans }] = await Promise.all([
    getClientList(db).catch((err: unknown): ClientListRow[] | null => {
      console.error("[admin] clients", err);
      return null;
    }),
    db.from("plans").select("id, code, name, limits").eq("is_active", true).order("sort_order"),
  ]);
  const activePlans = (plans ?? []) as { id: string; code: string; name: string; limits: Record<string, unknown> | null }[];

  const found = (clients ?? []).filter((c) => matchesClientSearch(c, q));
  const counts = clients ? clientFilterCounts(found) : null;
  const rows = found.filter((c) => matchesClientFilter(c, filter));
  const filterLabel = CLIENT_FILTERS.find((f) => f.key === filter)!.label;

  return (
    <>
      <PageHeader
        title="Clients"
        description={"Vos clients\u00a0: flottes, centrales et chauffeurs Flotte Privée."}
        actions={
          <NewClientButton
            rootDomain={env.rootDomain}
            plans={activePlans.map((p) => ({ code: p.code, name: p.name }))}
            privateFleetPlans={activePlans.map((p) => ({
              id: p.id,
              name: p.name,
              api: apiAccessOf(effectiveLimits({ planId: p.id, planLimits: p.limits, override: null, privateFleet: false })),
            }))}
          />
        }
      />
      <PageBody className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <FilterTabs
            label="Filtrer les clients"
            items={CLIENT_FILTERS.map((f) => ({
              href: listHref(f.key, q),
              label: f.label,
              active: f.key === filter,
              count: counts ? counts[f.key] : null,
              countLabel: counts ? plural(counts[f.key], "client", "clients") : undefined,
            }))}
          />
          <SearchField
            action={PATH}
            defaultValue={q}
            label="Rechercher un client"
            placeholder={"ex.\u00a0: nom, ville, e-mail"}
            params={{ type: filter === "tous" ? null : filter }}
            className="lg:w-[26rem]"
          />
        </div>

        {clients === null ? (
          <Callout tone="warning" title="Lecture impossible, réessayez dans un instant." />
        ) : clients.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Building2 />}
              title="Aucun client pour l'instant"
              description={"Créez votre premier client avec «\u00a0Nouveau client\u00a0»\u00a0: flotte, centrale à commission ou Flotte Privée."}
            />
          </Card>
        ) : rows.length === 0 ? (
          <Card>
            <EmptyState
              size="compact"
              title={q ? `Aucun client ne correspond à «\u00a0${q}\u00a0»${filter === "tous" ? "" : ` dans «\u00a0${filterLabel}\u00a0»`}.` : `Aucun client dans «\u00a0${filterLabel}\u00a0».`}
              action={
                <Link href={PATH} prefetch={false} className="inline-flex min-h-11 items-center text-[13px] font-medium text-brand hover:underline sm:min-h-8">
                  Voir tous les clients
                </Link>
              }
            />
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <MobileList>
              {rows.map((c) => (
                <ListCard
                  key={c.id}
                  href={`${PATH}/${c.id}`}
                  title={c.name}
                  status={<StatusBadge row={c} />}
                  lines={[
                    <span className="inline-flex items-center gap-2">
                      <KindBadge row={c} />
                      {c.plan ? `Offre ${c.plan}` : "Sans offre"}
                    </span>,
                    [c.city, c.slug].filter(Boolean).join(" · "),
                    c.email ? <span title={c.email}>{c.email}</span> : null,
                  ]}
                />
              ))}
            </MobileList>
            <DesktopTable>
              <Table>
                <THead>
                  <tr>
                    <TH>Client</TH>
                    <TH>Type</TH>
                    <TH>Offre</TH>
                    <TH>Contact</TH>
                    <TH>Créé le</TH>
                    <TH>Statut</TH>
                  </tr>
                </THead>
                <tbody>
                  {rows.map((c) => (
                    <TR key={c.id} className="relative">
                      <TD className="py-2.5">
                        <Link href={`${PATH}/${c.id}`} prefetch={false} className="absolute inset-0" aria-label={c.name} />
                        <span className="block text-[14px] font-medium">{c.name}</span>
                        <span className="block text-[12.5px] text-fg-muted">
                          {c.city ? `${c.city} · ` : ""}
                          <span className="num text-[12px] text-fg-subtle">{c.slug}</span>
                        </span>
                      </TD>
                      <TD>
                        <KindBadge row={c} />
                      </TD>
                      <TD className="text-[13px]">{c.plan ?? <span className="text-fg-muted">Sans offre</span>}</TD>
                      <TD className="text-[13px] text-fg-muted">
                        <span className="block max-w-[16rem] truncate" title={c.email ?? undefined}>
                          {c.email ?? "—"}
                        </span>
                      </TD>
                      <TD className="num whitespace-nowrap text-[13px] text-fg-muted">{formatDate(c.created_at)}</TD>
                      <TD>
                        <StatusBadge row={c} />
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            </DesktopTable>
          </Card>
        )}
      </PageBody>
    </>
  );
}
