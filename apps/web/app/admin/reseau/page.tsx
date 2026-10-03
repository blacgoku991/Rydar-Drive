import {
  DISPATCH_MODEL_META, NETWORK_DOCUMENTS, NETWORK_POSITIONING, NETWORK_TERMS_REVIEWED, NETWORK_TERMS_VERSION, ORG_STATUS_META, RIDE_STATUS_META,
  formatDate, formatNumber, formatPercent, formatPrice, formatRelative, formatRideDate,
  type AdminNetworkOrgRow, type AdminNetworkOverview, type NetworkTermsState,
} from "@rydar/shared";
import { CircleAlert, FileText, ListChecks, Route, ShieldAlert, UserX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { MissingIdentity, NetworkReviewActions, NetworkSuspendButton, NetworkSwitchCard } from "@/components/admin/network-admin";
import { APPROVAL_META, FLAG_META, acceptanceRatio, feeLabel, rowFlags, sortOrgRows, termsLines } from "@/components/network-share/admin";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { requireSuperAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Réseau partagé" };
export const dynamic = "force-dynamic";

const TZ = "Europe/Paris";

type PlatformRow = {
  shared_network_enabled: boolean;
  network_terms_version: string;
  network_terms_min_version: string | null;
  network_terms_grace_until: string | null;
  updated_at: string;
};

/** « 3 / 20 (15 %) » */
function acceptance(s: AdminNetworkOrgRow["stats_30d"]) {
  const ratio = acceptanceRatio(s);
  return `${formatNumber(s.offers_accepted)} / ${formatNumber(s.offers_received)}${ratio != null ? ` (${formatPercent(ratio)})` : ""}`;
}

/**
 * Super admin — réseau partagé (spec §12.4) : interrupteur (avec confirmation), convention en vigueur, demandes à
 * valider, tableau des organisations avec les seuils signalés sur 30 jours, suspensions, chauffeurs exclus
 * automatiquement, 50 dernières courses partagées. Lecture : admin_network_overview (super admin) ; écritures :
 * actions serveur + svc_* (auteur revérifié en base, audit_logs).
 */
export default async function AdminNetworkPage() {
  const session = await requireSuperAdmin();
  const [overviewRes, platformRes] = await Promise.all([
    session.supabase.rpc("admin_network_overview"),
    // Interrupteur et convention lus aussi directement (RLS super admin) : la page reste utilisable sans la vue d'ensemble
    session.supabase
      .from("platform_settings")
      .select("shared_network_enabled, network_terms_version, network_terms_min_version, network_terms_grace_until, updated_at")
      .maybeSingle(),
  ]);
  const overview = (overviewRes.error ? null : overviewRes.data) as AdminNetworkOverview | null;
  const platform = (platformRes.error ? null : platformRes.data) as PlatformRow | null;
  const enabled = overview?.enabled ?? platform?.shared_network_enabled === true;
  const terms: NetworkTermsState = overview?.terms ?? {
    version: platform?.network_terms_version ?? NETWORK_TERMS_VERSION,
    min_version: platform?.network_terms_min_version ?? null,
    grace_until: platform?.network_terms_grace_until ?? null,
  };
  const termsInfo = termsLines(terms, TZ);
  const toReview = overview?.to_review ?? [];
  const orgs = sortOrgRows(overview?.organizations ?? []);
  const flagged = orgs.filter((o) => rowFlags(o).length > 0).length;
  const now = new Date();

  return (
    <>
      <PageHeader eyebrow="Plateforme" title="Réseau partagé" description={NETWORK_POSITIONING} />
      <PageBody className="space-y-6">
        {overviewRes.error && (
          <p role="status" className="flex items-center gap-2 rounded-lg border border-line bg-white/[0.02] px-4 py-2.5 text-[12.5px] text-fg-muted">
            <CircleAlert className="size-4 shrink-0 text-amber" /> Vue d&apos;ensemble du réseau momentanément indisponible : seul l&apos;interrupteur est affiché.
          </p>
        )}

        <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
          <NetworkSwitchCard
            enabled={enabled}
            totals={overview ? overview.totals : null}
            updatedLabel={platform?.updated_at ? formatRelative(platform.updated_at) : null}
          />
          <Card>
            <CardHeader icon={<FileText />} title="Convention" description="Changée avec son texte, par migration : une correction du juriste = nouvelle version avec délai de grâce." />
            <CardBody className="space-y-2.5 text-[13px]">
              <p className="font-medium text-fg">{termsInfo.current}</p>
              {termsInfo.grace && <p className="text-fg-muted">{termsInfo.grace}</p>}
              {!NETWORK_TERMS_REVIEWED && (
                <p className="rounded-lg border border-amber/25 bg-amber/[0.07] px-3 py-2 text-[12.5px] text-amber">
                  Textes en cours de relecture juridique : à faire valider avant d&apos;ouvrir le réseau.
                </p>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
                <Link href={NETWORK_DOCUMENTS.network.path} target="_blank" prefetch={false} className="text-fg-muted underline-offset-2 hover:text-fg hover:underline">
                  {NETWORK_DOCUMENTS.network.label}
                </Link>
                <Link href={NETWORK_DOCUMENTS.network_driver.path} target="_blank" prefetch={false} className="text-fg-muted underline-offset-2 hover:text-fg hover:underline">
                  Conditions des chauffeurs
                </Link>
              </div>
            </CardBody>
          </Card>
        </div>

        {/* À valider */}
        <Card id="a-valider">
          <CardHeader
            icon={<ListChecks />}
            title="À valider"
            description="Demandes de participation et validations perdues (nom, raison sociale, SIRET ou n° VTC modifié). Vérification administrative de l'inscription au registre des exploitants VTC."
            action={toReview.length ? <Badge tone="amber">{toReview.length}</Badge> : undefined}
          />
          {toReview.length === 0 ? (
            <EmptyState title="Rien à valider" description="Les demandes des organisations qui acceptent la convention s'affichent ici." />
          ) : (
            <ul className="divide-y divide-line">
              {toReview.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
                      <Link href={`/admin/organizations/${r.id}`} prefetch={false} className="hover:text-brand">{r.name}</Link>
                      <Badge tone={APPROVAL_META[r.approval].tone}>{APPROVAL_META[r.approval].label}</Badge>
                      <Badge tone={r.dispatch_model === "centrale" ? "violet" : "neutral"} dot={false}>{DISPATCH_MODEL_META[r.dispatch_model].short}</Badge>
                    </p>
                    <p className="text-[12.5px] text-fg-muted">
                      {r.legal_name || "Raison sociale manquante"} · SIRET <span className="mono">{r.siret || "—"}</span> · n° VTC{" "}
                      <span className="mono">{r.vtc_registration || "—"}</span>
                    </p>
                    <p className="text-[12px] text-fg-subtle">
                      Frais Rydar : {feeLabel(r)}
                      {r.requested_at ? ` · demandé ${formatRelative(r.requested_at)}` : ""}
                      {r.share_out ? " · veut partager" : ""}
                      {r.share_in ? " · veut recevoir" : ""}
                      {r.terms_ok ? "" : " · convention à accepter"}
                    </p>
                    <MissingIdentity row={r} />
                  </div>
                  <NetworkReviewActions row={r} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Organisations */}
        <Card>
          <CardHeader
            icon={<ShieldAlert />}
            title="Organisations"
            description={
              orgs.length
                ? `${orgs.length} organisation${orgs.length > 1 ? "s" : ""} inscrite${orgs.length > 1 ? "s" : ""}${flagged ? ` · ${flagged} à regarder` : ""} — chiffres des 30 derniers jours.`
                : "Les organisations qui demandent à participer apparaissent ici."
            }
          />
          {orgs.length === 0 ? (
            <EmptyState title="Aucune organisation" description="Personne n'a encore demandé à participer au réseau partagé." />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Organisation</TH>
                  <TH>Partage · réception</TH>
                  <TH>Validation</TH>
                  <TH>Frais Rydar</TH>
                  <TH>30 jours</TH>
                  <TH>Signalements</TH>
                  <TH className="text-right">Action</TH>
                </tr>
              </THead>
              <tbody>
                {orgs.map((o) => {
                  const flags = rowFlags(o);
                  const s = o.stats_30d;
                  return (
                    <TR key={o.id} id={`org-${o.id}`}>
                      <TD className="min-w-[180px]">
                        <Link href={`/admin/organizations/${o.id}`} prefetch={false} className="text-[13px] font-medium hover:text-brand">{o.name}</Link>
                        <p className="text-[11.5px] text-fg-subtle">
                          {DISPATCH_MODEL_META[o.dispatch_model].short}
                          {o.status !== "active" ? ` · ${ORG_STATUS_META[o.status].label.toLowerCase()}` : ""}
                        </p>
                      </TD>
                      <TD className="whitespace-nowrap text-[12.5px]">
                        <span className={o.share_out ? "text-fg" : "text-fg-subtle"}>{o.share_out ? "Partage" : "—"}</span>
                        <span className="text-fg-subtle"> · </span>
                        <span className={o.share_in ? "text-fg" : "text-fg-subtle"}>{o.share_in ? "Réception" : "—"}</span>
                        {o.suspended_at && (
                          <span className="mt-1 block">
                            <Badge tone="red">Suspendue</Badge>
                          </span>
                        )}
                      </TD>
                      <TD className="text-[12.5px]">
                        <Badge tone={APPROVAL_META[o.approval].tone}>{APPROVAL_META[o.approval].label}</Badge>
                        <p className="mt-1 text-[11.5px] text-fg-subtle">{o.terms_ok ? `Convention ${o.terms_version}` : "Convention à accepter"}</p>
                      </TD>
                      <TD className="whitespace-nowrap text-[12.5px]">{feeLabel(o)}</TD>
                      <TD className="min-w-[220px] text-[12px] text-fg-muted">
                        <p>
                          <span className="num text-fg">{formatNumber(s.rides_given)}</span> confiées · <span className="num text-fg">{formatNumber(s.rides_received)}</span> reçues
                        </p>
                        <details className="mt-0.5">
                          <summary className="cursor-pointer text-fg-subtle hover:text-fg">Offres acceptées {acceptance(s)}</summary>
                          <dl className="mt-1.5 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
                            <dt>Offres refusées</dt><dd className="num text-right">{formatNumber(s.offers_declined)}</dd>
                            <dt>Offres expirées</dt><dd className="num text-right">{formatNumber(s.offers_expired)}</dd>
                            <dt>Retraits après acceptation</dt><dd className="num text-right">{formatNumber(s.releases_after_accept)}</dd>
                            <dt>Annulations après acceptation</dt><dd className="num text-right">{formatNumber(s.giver_cancellations_after_accept)}</dd>
                            <dt>Courses contestées</dt><dd className="num text-right">{formatNumber(s.contested_rides)}</dd>
                            <dt>Contestations de chauffeurs</dt><dd className="num text-right">{formatNumber(s.driver_disputes)}</dd>
                            <dt>Versements en retard</dt><dd className="num text-right">{formatNumber(s.overdue_payouts)}</dd>
                          </dl>
                        </details>
                      </TD>
                      <TD className="min-w-[160px]">
                        {flags.length ? (
                          <div className="flex flex-wrap gap-1">
                            {flags.map((f) => (
                              <span key={f} title={FLAG_META[f].hint}>
                                <Badge tone="amber" dot={false}>{FLAG_META[f].label}</Badge>
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[12px] text-fg-subtle">—</span>
                        )}
                        {o.suspended_reason && <p className="mt-1 text-[11.5px] text-fg-subtle">« {o.suspended_reason} »</p>}
                      </TD>
                      <TD className="text-right">
                        <NetworkSuspendButton row={o} />
                      </TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>

        <div className="grid gap-6 xl:grid-cols-[1fr_1.4fr]">
          <Card>
            <CardHeader
              icon={<UserX />}
              title="Chauffeurs exclus automatiquement"
              description="Trois courses partagées retirées en 30 jours : réseau indisponible 30 jours pour ce chauffeur."
            />
            {(overview?.auto_excluded_drivers ?? []).length === 0 ? (
              <EmptyState title="Aucun chauffeur exclu" description="Les exclusions automatiques s'affichent ici." />
            ) : (
              <ul className="divide-y divide-line">
                {overview!.auto_excluded_drivers.map((d, i) => (
                  <li key={`${d.organization.id}-${i}`} className="flex items-center justify-between gap-3 px-5 py-3 text-[13px]">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{d.driver_label}</span>
                      <span className="block truncate text-[12px] text-fg-subtle">
                        <Link href={`/admin/organizations/${d.organization.id}`} prefetch={false} className="hover:text-fg">{d.organization.name}</Link> ·{" "}
                        {formatNumber(d.releases_30d)} retraits
                      </span>
                    </span>
                    <span className="shrink-0 text-[12px] text-fg-muted">jusqu&apos;au {formatDate(d.excluded_until, TZ)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader icon={<Route />} title="Dernières courses partagées" description="Les 50 plus récentes : organisation qui confie, organisation du chauffeur." />
            {(overview?.recent_rides ?? []).length === 0 ? (
              <EmptyState title="Aucune course partagée" description="Les courses acceptées par un chauffeur partenaire s'affichent ici." />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>Date</TH>
                    <TH>Confiée par</TH>
                    <TH>Faite par</TH>
                    <TH>Statut</TH>
                    <TH className="text-right">Prix</TH>
                  </tr>
                </THead>
                <tbody>
                  {overview!.recent_rides.map((r) => (
                    <TR key={r.execution_id}>
                      <TD className="whitespace-nowrap text-[12.5px] text-fg-muted">{formatRideDate(r.accepted_at, TZ, now)}</TD>
                      <TD className="text-[12.5px]">
                        <Link href={`/admin/organizations/${r.giver.id}`} prefetch={false} className="hover:text-brand">{r.giver.name}</Link>
                      </TD>
                      <TD className="text-[12.5px]">
                        <Link href={`/admin/organizations/${r.executor.id}`} prefetch={false} className="hover:text-brand">{r.executor.name}</Link>
                      </TD>
                      <TD>
                        <Badge tone={RIDE_STATUS_META[r.status]?.tone ?? "neutral"}>{RIDE_STATUS_META[r.status]?.short ?? r.status}</Badge>
                      </TD>
                      <TD className="mono text-right text-[12.5px]">{formatPrice(r.price_cents, r.currency)}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      </PageBody>
    </>
  );
}
