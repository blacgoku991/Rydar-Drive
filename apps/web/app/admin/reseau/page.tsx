import {
  DISPATCH_MODEL_META, NETWORK_DOCUMENTS, NETWORK_POSITIONING, NETWORK_TERMS_REVIEWED, NETWORK_TERMS_VERSION, ORG_STATUS_META, RIDE_STATUS_META,
  formatDate, formatNumber, formatPercent, formatPrice, formatRelative, formatRideDate, legalDateLabel,
  type AdminNetworkOrgRow, type AdminNetworkOverview, type NetworkTermsState,
} from "@rydar/shared";
import { FileText, ListChecks, Route, ShieldAlert, UserX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { MissingIdentity, NetworkReviewActions, NetworkSuspendButton, NetworkSwitchCard } from "@/components/admin/network-admin";
import { APPROVAL_META, FLAG_META, acceptanceRatio, feeLabel, rowFlags, sortOrgRows, termsLines } from "@/components/network-share/admin";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/misc";
import { NewTabHint } from "@/components/ui/new-tab";
import { DesktopTable, ListCard, MobileList, Table, TD, TH, THead, TR } from "@/components/ui/table";
import { requireSuperAdmin } from "@/lib/auth";
import { plural } from "@/lib/wording";

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

/** Sens demandés par l'organisation, en mots. */
function directions(o: Pick<AdminNetworkOrgRow, "share_out" | "share_in">): string {
  if (o.share_out && o.share_in) return "Partage et reçoit des courses";
  if (o.share_out) return "Partage ses courses";
  if (o.share_in) return "Reçoit des courses";
  return "Ne partage ni ne reçoit";
}

/** Version de la convention en toutes lettres (« du 1er novembre 2026 ») : date ISO, sinon telle quelle. */
const versionLabel = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? `du ${legalDateLabel(v)}` : v);

/**
 * Super admin — réseau partagé (spec §12.4 ; docs/REFONTE-PANELS.md, R6) : interrupteur (avec confirmation), convention
 * en vigueur, puis le suivi : demandes à valider, organisations avec les seuils signalés sur 30 jours, suspensions,
 * chauffeurs exclus automatiquement, 50 dernières courses partagées. Réseau fermé sans aucune ligne : une seule ligne
 * « Rien à suivre » à la place des quatre cartes vides. Le positionnement (texte des conventions) est dans un repli.
 * Lecture : admin_network_overview (super admin) ; écritures : actions serveur + svc_* (auteur revérifié en base,
 * audit_logs).
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
  // Versions en toutes lettres (« Version du 1er novembre 2026 »), délai de grâce compris
  const termsInfo = termsLines({ ...terms, min_version: terms.min_version ? versionLabel(terms.min_version).replace(/^du /, "") : null }, TZ);
  const toReview = overview?.to_review ?? [];
  const orgs = sortOrgRows(overview?.organizations ?? []);
  const excluded = overview?.auto_excluded_drivers ?? [];
  const rides = overview?.recent_rides ?? [];
  const flagged = orgs.filter((o) => rowFlags(o).length > 0).length;
  // Réseau fermé et rien d'inscrit : une ligne au lieu de quatre cartes vides (vue d'ensemble lue, jamais un faux vide)
  const nothingToFollow = !!overview && !enabled && !toReview.length && !orgs.length && !excluded.length && !rides.length;
  const now = new Date();

  return (
    <>
      <PageHeader title="Réseau partagé" description="Ouverture du réseau, convention, organisations à valider et suivi des courses partagées." />
      <PageBody className="space-y-6">
        <Disclosure
          title="Ce que fait le réseau partagé"
          className="surface rounded-xl px-4 sm:px-5"
          contentClassName="max-w-3xl pb-4 text-[13.5px] leading-relaxed text-fg-muted"
        >
          <p>{NETWORK_POSITIONING}</p>
        </Disclosure>

        {overviewRes.error && (
          <Callout tone="warning" title="Suivi du réseau momentanément indisponible">
            Seuls l&apos;interrupteur et la convention sont affichés{"\u00a0"}: réessayez dans un instant.
          </Callout>
        )}

        <div className="grid items-start gap-6 xl:grid-cols-[1.4fr_1fr]">
          <NetworkSwitchCard
            enabled={enabled}
            totals={overview ? overview.totals : null}
            updatedLabel={platform?.updated_at ? formatRelative(platform.updated_at) : null}
          />
          <Card>
            <CardHeader
              icon={<FileText />}
              title="Convention"
              description={"Mise à jour par l'équipe technique\u00a0; une correction du juriste donne une nouvelle version avec un délai de grâce."}
            />
            <CardBody className="space-y-3 text-[13px]">
              <p className="font-medium text-fg">Version {versionLabel(terms.version)}</p>
              {termsInfo.grace && <p className="text-fg-muted">{termsInfo.grace}</p>}
              {!NETWORK_TERMS_REVIEWED && (
                <Callout tone="warning" className="text-[13px]">
                  Textes en cours de relecture juridique{"\u00a0"}: à faire valider avant d&apos;ouvrir le réseau.
                </Callout>
              )}
              <ul className="space-y-1 text-[13px]">
                <li>
                  <Link href={NETWORK_DOCUMENTS.network.path} target="_blank" prefetch={false} className="inline-flex min-h-8 items-center text-brand hover:underline">
                    {NETWORK_DOCUMENTS.network.label} <span aria-hidden className="ml-1">↗</span>
                    <NewTabHint />
                  </Link>
                </li>
                <li>
                  <Link href={NETWORK_DOCUMENTS.network_driver.path} target="_blank" prefetch={false} className="inline-flex min-h-8 items-center text-brand hover:underline">
                    Conditions des chauffeurs <span aria-hidden className="ml-1">↗</span>
                    <NewTabHint />
                  </Link>
                </li>
              </ul>
            </CardBody>
          </Card>
        </div>

        {nothingToFollow ? (
          <Card>
            <EmptyState
              size="compact"
              title="Rien à suivre tant que le réseau est fermé."
              description="Les demandes à valider, les organisations inscrites et les courses partagées apparaîtront ici."
            />
          </Card>
        ) : overview ? (
          <>
            {/* À valider */}
            <Card id="a-valider">
              <CardHeader
                icon={<ListChecks />}
                title="À valider"
                description="Demandes de participation et validations perdues (nom, raison sociale, SIRET ou n° VTC modifié). Vérification administrative de l'inscription au registre des exploitants VTC."
                action={toReview.length ? <Badge tone="amber">{formatNumber(toReview.length)}</Badge> : undefined}
              />
              {toReview.length === 0 ? (
                <EmptyState size="compact" title="Rien à valider." description="Les demandes des organisations qui acceptent la convention s'affichent ici." />
              ) : (
                <ul className="divide-y divide-line">
                  {toReview.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
                      <div className="min-w-0 space-y-1">
                        <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
                          <Link href={`/admin/organizations/${r.id}`} prefetch={false} className="hover:text-brand">
                            {r.name}
                          </Link>
                          <Badge tone={APPROVAL_META[r.approval].tone}>{APPROVAL_META[r.approval].label}</Badge>
                          <Badge tone="neutral" dot={false}>
                            {DISPATCH_MODEL_META[r.dispatch_model].label}
                          </Badge>
                        </p>
                        <p className="text-[12.5px] text-fg-muted [overflow-wrap:anywhere]">
                          {r.legal_name || "Raison sociale manquante"} · SIRET <span className="mono">{r.siret || "—"}</span> · n° VTC{" "}
                          <span className="mono">{r.vtc_registration || "—"}</span>
                        </p>
                        <p className="text-[12px] text-fg-muted">
                          Frais Rydar{"\u00a0"}: {feeLabel(r)}
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

            {/* Organisations : une seule liste (l'action « Suspendre » n'est rendue qu'une fois), colonnes à partir de lg */}
            <Card>
              <CardHeader
                icon={<ShieldAlert />}
                title="Organisations"
                description={
                  orgs.length
                    ? `${plural(orgs.length, "organisation inscrite", "organisations inscrites")}${flagged ? ` · ${formatNumber(flagged)} à regarder` : ""}, chiffres des 30 derniers jours.`
                    : "Les organisations qui demandent à participer apparaissent ici."
                }
              />
              {orgs.length === 0 ? (
                <EmptyState size="compact" title="Aucune organisation." description="Personne n'a encore demandé à participer au réseau partagé." />
              ) : (
                <ul className="divide-y divide-line">
                  {orgs.map((o) => {
                    const flags = rowFlags(o);
                    const s = o.stats_30d;
                    return (
                      <li
                        key={o.id}
                        id={`org-${o.id}`}
                        className="space-y-3 px-5 py-4 lg:grid lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1.1fr)_minmax(0,1fr)_8.5rem] lg:items-start lg:gap-6 lg:space-y-0"
                      >
                        <div className="min-w-0 space-y-1">
                          <p className="flex flex-wrap items-center gap-2">
                            <Link href={`/admin/organizations/${o.id}`} prefetch={false} className="text-[14px] font-semibold hover:text-brand">
                              {o.name}
                            </Link>
                            <Badge tone={APPROVAL_META[o.approval].tone}>{APPROVAL_META[o.approval].label}</Badge>
                            {o.suspended_at && <Badge tone="red">Suspendue</Badge>}
                          </p>
                          <p className="text-[12.5px] text-fg-muted">
                            {DISPATCH_MODEL_META[o.dispatch_model].label}
                            {o.status !== "active" ? ` · ${ORG_STATUS_META[o.status].label.toLowerCase()}` : ""} · {directions(o)}
                          </p>
                          <p className="text-[12.5px] text-fg-muted">
                            {o.terms_ok && o.terms_version ? `Convention ${versionLabel(o.terms_version)}` : "Convention à accepter"} · Frais Rydar{"\u00a0"}:{" "}
                            {feeLabel(o)}
                          </p>
                        </div>
                        <div className="min-w-0 text-[12.5px] text-fg-muted">
                          <p>
                            <span className="num text-fg">{formatNumber(s.rides_given)}</span> confiées ·{" "}
                            <span className="num text-fg">{formatNumber(s.rides_received)}</span> reçues (30 jours)
                          </p>
                          <Disclosure
                            title={`Offres acceptées ${acceptance(s)}`}
                            summaryClassName="text-[12.5px] font-normal text-fg-muted hover:text-fg"
                            contentClassName="pb-1"
                          >
                            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[12px]">
                              <dt>Offres refusées</dt>
                              <dd className="num text-right text-fg">{formatNumber(s.offers_declined)}</dd>
                              <dt>Offres expirées</dt>
                              <dd className="num text-right text-fg">{formatNumber(s.offers_expired)}</dd>
                              <dt>Retraits après acceptation</dt>
                              <dd className="num text-right text-fg">{formatNumber(s.releases_after_accept)}</dd>
                              <dt>Annulations après acceptation</dt>
                              <dd className="num text-right text-fg">{formatNumber(s.giver_cancellations_after_accept)}</dd>
                              <dt>Courses contestées</dt>
                              <dd className="num text-right text-fg">{formatNumber(s.contested_rides)}</dd>
                              <dt>Contestations de chauffeurs</dt>
                              <dd className="num text-right text-fg">{formatNumber(s.driver_disputes)}</dd>
                              <dt>Versements en retard</dt>
                              <dd className="num text-right text-fg">{formatNumber(s.overdue_payouts)}</dd>
                            </dl>
                          </Disclosure>
                        </div>
                        <div className="min-w-0">
                          {flags.length ? (
                            <ul className="flex flex-wrap gap-1" aria-label="Signalements">
                              {flags.map((f) => (
                                <li key={f} title={FLAG_META[f].hint}>
                                  <Badge tone="amber" dot={false}>
                                    {FLAG_META[f].label}
                                  </Badge>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-[12.5px] text-fg-muted">Aucun signalement</p>
                          )}
                          {o.suspended_reason && (
                            <p className="mt-1 text-[12px] text-fg-muted [overflow-wrap:anywhere]">
                              Motif de la suspension{"\u00a0"}: «{"\u00a0"}{o.suspended_reason}{"\u00a0"}»
                            </p>
                          )}
                        </div>
                        <div className="lg:text-right">
                          <NetworkSuspendButton row={o} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>

            <div className="grid items-start gap-6 xl:grid-cols-[1fr_1.4fr]">
              <Card>
                <CardHeader
                  icon={<UserX />}
                  title="Chauffeurs exclus automatiquement"
                  description={"Trois courses partagées retirées en 30 jours\u00a0: réseau indisponible 30 jours pour ce chauffeur."}
                />
                {excluded.length === 0 ? (
                  <EmptyState size="compact" title="Aucun chauffeur exclu." description="Les exclusions automatiques s'affichent ici." />
                ) : (
                  <ul className="divide-y divide-line">
                    {excluded.map((d, i) => (
                      <li key={`${d.organization.id}-${i}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-3 text-[13px]">
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{d.driver_label}</span>
                          <span className="block truncate text-[12px] text-fg-muted">
                            <Link href={`/admin/organizations/${d.organization.id}`} prefetch={false} className="hover:text-fg">
                              {d.organization.name}
                            </Link>{" "}
                            · {plural(d.releases_30d, "retrait")}
                          </span>
                        </span>
                        <span className="shrink-0 text-[12px] text-fg-muted">jusqu&apos;au {formatDate(d.excluded_until, TZ)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card className="overflow-hidden">
                <CardHeader icon={<Route />} title="Dernières courses partagées" description={"Les 50 plus récentes\u00a0: organisation qui confie, organisation du chauffeur."} />
                {rides.length === 0 ? (
                  <EmptyState size="compact" title="Aucune course partagée." description="Les courses acceptées par un chauffeur partenaire s'affichent ici." />
                ) : (
                  <>
                    <MobileList>
                      {rides.map((r) => (
                        <ListCard
                          key={r.execution_id}
                          title={
                            <>
                              <Link href={`/admin/organizations/${r.giver.id}`} prefetch={false} className="hover:text-brand">
                                {r.giver.name}
                              </Link>{" "}
                              →{" "}
                              <Link href={`/admin/organizations/${r.executor.id}`} prefetch={false} className="hover:text-brand">
                                {r.executor.name}
                              </Link>
                            </>
                          }
                          status={<Badge tone={RIDE_STATUS_META[r.status]?.tone ?? "neutral"}>{RIDE_STATUS_META[r.status]?.short ?? "Statut inconnu"}</Badge>}
                          lines={[
                            <span key="d" className="num">
                              {formatRideDate(r.accepted_at, TZ, now)} · {formatPrice(r.price_cents, r.currency)}
                            </span>,
                          ]}
                        />
                      ))}
                    </MobileList>
                    <DesktopTable>
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
                          {rides.map((r) => (
                            <TR key={r.execution_id}>
                              <TD className="whitespace-nowrap text-[12.5px] text-fg-muted">{formatRideDate(r.accepted_at, TZ, now)}</TD>
                              <TD className="text-[12.5px]">
                                <Link href={`/admin/organizations/${r.giver.id}`} prefetch={false} className="hover:text-brand">
                                  {r.giver.name}
                                </Link>
                              </TD>
                              <TD className="text-[12.5px]">
                                <Link href={`/admin/organizations/${r.executor.id}`} prefetch={false} className="hover:text-brand">
                                  {r.executor.name}
                                </Link>
                              </TD>
                              <TD>
                                <Badge tone={RIDE_STATUS_META[r.status]?.tone ?? "neutral"}>{RIDE_STATUS_META[r.status]?.short ?? "Statut inconnu"}</Badge>
                              </TD>
                              <TD className="num whitespace-nowrap text-right text-[12.5px]">{formatPrice(r.price_cents, r.currency)}</TD>
                            </TR>
                          ))}
                        </tbody>
                      </Table>
                    </DesktopTable>
                  </>
                )}
              </Card>
            </div>
          </>
        ) : null}
      </PageBody>
    </>
  );
}
