import {
  ORG_LEGAL_VERSION,
  ORG_STATUS_META,
  formatPrice,
  legalAcceptanceState,
  legalDateLabel,
  type AdminPlatformAccount,
  type AdminPlatformOverview,
  type PlatformEntry,
} from "@rydar/shared";
import { AlarmClock, BellRing, Building2, CalendarClock, CircleDollarSign, Download, Inbox, Receipt } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatPlatformFee } from "@/components/admin/fees";
import { ratesText } from "@/components/admin/org-watch";
import { CLIENT_KIND_META, clientKind } from "@/components/admin/platform-data";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { AccountActions, TermsForm } from "@/components/platform-fees/admin-account-actions";
import {
  MONTH_RE, accountIsEmpty, accountStateBadge, ago, cancelledOnboard, invoiceCycles, lastMonths, lateDeclaredNote, monthKey, nextDueInfo, overdueInfo,
  termsSummary, zeroPriceText,
} from "@/components/platform-fees/admin-platform-format";
import { PlatformLive } from "@/components/platform-fees/admin-platform-live";
import { Metric } from "@/components/platform-fees/admin-platform-metric";
import { OriginBreakdown, PaymentsHistory, PaymentsToConfirm, PendingReductions, StatementView } from "@/components/platform-fees/admin-platform-sections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/misc";
import { requireSuperAdmin } from "@/lib/auth";
import { plural } from "@/lib/wording";

export const metadata: Metadata = { title: "Compte des frais Rydar" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Compte des frais Rydar d'un client (docs/REFONTE-PANELS.md, R5) : identité et « À surveiller », quatre chiffres,
 * « À traiter » (#a-traiter), d'où vient l'argent et les conditions (résumé, formulaire inchangé replié), frais à
 * facturer, paiements, relevé (15 premières lignes, les suivantes repliées ; mois et export CSV inchangés). Compte sans
 * frais ni historique : état vide qui renvoie à la fiche du client, actions gardées. Mêmes lectures et mêmes actions.
 */
export default async function PlatformAccountPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ mois?: string }> }) {
  const [{ orgId }, { mois }] = await Promise.all([params, searchParams]);
  if (!UUID.test(orgId)) notFound();
  const session = await requireSuperAdmin();
  const month = mois && MONTH_RE.test(mois) ? mois : null;
  const [{ data, error }, acceptances, kindRow] = await Promise.all([
    session.supabase.rpc("admin_platform_account", { p_org: orgId, p_month: month }),
    // CGV + accord de traitement au nom de l'organisation (« dpa » suffit : enregistrés ensemble)
    session.supabase.from("legal_acceptances").select("version").eq("organization_id", orgId).eq("document", "dpa"),
    // Type du client (badge : Flotte Privée ?) : lecture seule, même session et même RLS
    session.supabase.from("organizations").select("private_fleet").eq("id", orgId).maybeSingle(),
  ]);
  if (error) {
    console.error("[admin] compte des frais Rydar", error.message);
    return (
      <>
        <PageHeader back={{ href: "/admin/frais", label: "Frais Rydar" }} title="Compte des frais Rydar" />
        <PageBody>
          <Callout tone="danger" title="Lecture impossible, réessayez dans un instant." />
        </PageBody>
      </>
    );
  }
  const d = (data ?? null) as AdminPlatformAccount | null;
  if (!d?.account) notFound();
  const { organization: org, account: a, payments, statement } = d;
  const tz = org.timezone || "Europe/Paris";
  const cur = a.currency;

  // Baisses en attente de ce client (toutes périodes confondues)
  let pending: PlatformEntry[] = [];
  if (a.pending_reductions_count > 0) {
    const { data: overview } = await session.supabase.rpc("admin_platform_overview");
    pending = ((overview ?? null) as AdminPlatformOverview | null)?.pending_reductions.filter((e) => e.organization_id === orgId) ?? [];
  }
  const declared = payments.filter((p) => p.status === "declared");
  const late = overdueInfo(a, tz);
  const lateNote = lateDeclaredNote(a, cur);
  const nextDue = nextDueInfo(a, tz, cur);
  const state = accountStateBadge(a, tz);
  const months = lastMonths(monthKey(new Date(), tz), 12);
  const basePath = `/admin/frais/${orgId}`;
  const kind = CLIENT_KIND_META[clientKind({ dispatch_model: org.dispatch_model, private_fleet: (kindRow.data as { private_fleet?: boolean } | null)?.private_fleet })];
  const empty = accountIsEmpty(a, payments.length);
  const onboard = cancelledOnboard(a);
  // CGV en vigueur pas encore acceptées : relances, blocage et pénalités s'appuieraient sur des conditions que le client
  // n'a pas acceptées (CGV non opposables, art. 1119 du Code civil) — null : lecture en échec
  if (acceptances.error) console.error("[admin] compte des frais Rydar : acceptation des CGV", acceptances.error.message);
  const terms = acceptances.error ? null : legalAcceptanceState(((acceptances.data ?? []) as { version: string }[]).map((x) => x.version), ORG_LEGAL_VERSION);
  // Factures récapitulatives : le cycle en cours et les précédents (frais pris en compte pendant chaque cycle)
  const cycles = invoiceCycles(a.cycle, new Date(), tz, a.cycle === "weekly" ? 8 : 6);

  // « À surveiller » : ce qui fragilise une relance ou un blocage, la hausse annoncée, les signaux du mois
  const watch: { key: string; text: string; link?: { href: string; label: string } }[] = [];
  if (terms === null) watch.push({ key: "terms", text: "Acceptation des CGV : lecture impossible, réessayez dans un instant." });
  else if (terms !== "accepted") {
    watch.push({
      key: "terms",
      text:
        `CGV du ${legalDateLabel(ORG_LEGAL_VERSION)} pas encore acceptées par le client (${terms === "updated" ? "version antérieure seulement" : "aucune version"}) : ` +
        "seuil de blocage, relances et pénalités s'appuieraient sur des conditions qu'il n'a pas acceptées.",
    });
  }
  if (a.scheduled_change) {
    watch.push({
      key: "scheduled",
      text: `Hausse des frais programmée le ${legalDateLabel(a.scheduled_change.effective_on)} : ${formatPlatformFee(a.scheduled_change.percent, a.scheduled_change.fixed_cents)} par course.`,
      link: { href: `/admin/organizations/${orgId}#modele-et-frais`, label: "Gérer sur la fiche" },
    });
  }
  if (a.month.zero_price_rides > 0 || a.month.cancelled_assigned_rides > 0) {
    const n = a.month.cancelled_assigned_rides;
    watch.push({
      key: "month",
      text: `Ce mois-ci : ${[
        a.month.zero_price_rides ? zeroPriceText(a.month.zero_price_rides, org.dispatch_model) : null,
        n ? `${plural(n, "course annulée", "courses annulées")} après attribution à un chauffeur${onboard ? `, dont ${onboard} après la prise en charge du client (aucuns frais)` : ""}` : null,
      ]
        .filter(Boolean)
        .join(" · ")}.`,
    });
  }

  return (
    <>
      <PageHeader
        back={{ href: "/admin/frais", label: "Frais Rydar" }}
        title={org.name}
        badges={
          <>
            <Badge tone={state.tone}>{state.text}</Badge>
            {a.blocked && <Badge tone="red">Création de courses bloquée</Badge>}
            {!a.blocked && a.block_suspended && <Badge tone="amber">Blocage suspendu (paiement déclaré à confirmer)</Badge>}
            {org.status !== "active" && <Badge tone={ORG_STATUS_META[org.status].tone}>{ORG_STATUS_META[org.status].label}</Badge>}
            <Badge tone={kind.tone} dot={false}>
              {kind.label}
            </Badge>
          </>
        }
        meta={
          <>
            <span>
              Référence de virement <span className="mono text-fg">{a.reference}</span> · {ratesText(Number(a.fee_percent), a.fee_fixed_cents, cur)}
            </span>
            {a.reminded_at && (
              <span className="mt-0.5 flex items-start gap-1.5">
                <BellRing aria-hidden className="mt-[3px] size-3.5 shrink-0" />
                <span>
                  Relancé {ago(a.reminded_at)}
                  {a.reminder_note ? ` : « ${a.reminder_note} »` : ""}
                </span>
              </span>
            )}
          </>
        }
        actions={
          <>
            <AccountActions orgId={orgId} orgName={org.name} account={a} timeZone={tz} />
            <Button asChild variant="ghost" size="sm" className="max-sm:h-11">
              <Link href={`/admin/organizations/${orgId}`} prefetch={false}>
                <Building2 /> Fiche du client
              </Link>
            </Button>
          </>
        }
      />

      <PageBody className="space-y-4 sm:space-y-6">
        {watch.length > 0 && (
          <Callout tone="warning" title="À surveiller">
            <ul className="mt-1 space-y-1.5">
              {watch.map((w) => (
                <li key={w.key} className="flex gap-2.5">
                  <span aria-hidden className="mt-[8px] size-1.5 shrink-0 rounded-full bg-amber" />
                  <span className="min-w-0 text-fg">
                    {w.text}
                    {w.link && (
                      <>
                        {" "}
                        <Link href={w.link.href} prefetch={false} className="font-medium text-brand underline-offset-2 hover:underline">
                          {w.link.label}
                        </Link>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Callout>
        )}

        {empty ? (
          <Card>
            <EmptyState
              size="compact"
              icon={<CircleDollarSign />}
              title="Aucun frais Rydar pour ce client."
              description={"Réglez-les depuis sa fiche («\u00a0Modèle et frais Rydar\u00a0»)."}
              action={
                <Link
                  href={`/admin/organizations/${orgId}#modele-et-frais`}
                  prefetch={false}
                  className="inline-flex min-h-11 items-center text-[13px] font-medium text-brand hover:underline sm:min-h-0"
                >
                  Ouvrir sa fiche
                </Link>
              }
            />
          </Card>
        ) : (
          <>
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Metric
                  label="Solde"
                  value={formatPrice(a.balance_cents, cur)}
                  sub={a.balance_cents < 0 ? "avance du client" : "frais − paiements reçus"}
                  icon={<CircleDollarSign />}
                />
                {/* Mêmes mots que la fiche du client et les commissions des centrales : le client lit « À payer
                    maintenant » = retard moins la part déclarée */}
                <Metric
                  label="En retard"
                  value={formatPrice(a.due_cents, cur)}
                  tone={a.due_cents > 0 ? "red" : undefined}
                  sub={
                    late || lateNote ? (
                      <>
                        {late && <span className="block">{late.since}</span>}
                        {lateNote && <span className="block text-amber">{lateNote}</span>}
                      </>
                    ) : (
                      "aucun retard"
                    )
                  }
                  icon={<AlarmClock />}
                />
                <Metric
                  label="À confirmer"
                  value={formatPrice(a.declared_cents, cur)}
                  tone={a.declared_count ? "amber" : undefined}
                  sub={a.declared_count ? plural(a.declared_count, "paiement déclaré", "paiements déclarés") : "aucune déclaration"}
                  icon={<Inbox />}
                  href={a.declared_count ? "#a-traiter" : undefined}
                />
                {/* La part qui tombe à cette date (celle que lit le client), puis le cumul avec le retard */}
                <Metric
                  label="Prochaine échéance"
                  value={nextDue ? nextDue.amount : "—"}
                  sub={
                    nextDue ? (
                      <>
                        <span className="block">au plus tard le {nextDue.day}</span>
                        {nextDue.withLate && <span className="block">{nextDue.withLate}</span>}
                      </>
                    ) : (
                      "rien à venir"
                    )
                  }
                  icon={<CalendarClock />}
                />
              </div>
              <p className="text-[13px] text-fg-muted">
                Ce mois-ci{" "}: {formatPrice(a.month.fees_cents, cur)} de frais ({plural(a.month.rides, "course")}), {formatPrice(a.month.received_cents, cur)}{" "}
                reçus · Reçu au total{" "}: {formatPrice(a.received_cents, cur)}
                {a.last_payment_at ? `, dernier paiement ${ago(a.last_payment_at)}` : ", aucun paiement reçu"}.
              </p>
            </div>

            {(declared.length > 0 || pending.length > 0) && (
              <section id="a-traiter" aria-label="À traiter" className="scroll-mt-6 space-y-4">
                {declared.length > 0 && <PaymentsToConfirm payments={declared} orgName={org.name} timeZone={tz} />}
                {pending.length > 0 && <PendingReductions entries={pending} orgName={org.name} timeZone={tz} />}
              </section>
            )}
          </>
        )}

        <div className="grid items-start gap-4 sm:gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          {!empty && <OriginBreakdown account={a} />}
          <Card>
            <CardHeader
              title="Conditions"
              icon={<CalendarClock />}
              description={"Échéance de chaque frais : fin du cycle dans le fuseau du client, plus le délai."}
            />
            <CardBody className="space-y-3">
              <p className="text-[13.5px] text-fg">{termsSummary(a)}</p>
              <Disclosure title="Modifier les conditions" className="rounded-xl border border-line px-4" contentClassName="pb-4 pt-1">
                <TermsForm orgId={orgId} cycle={a.cycle} paymentDays={a.payment_days} blockAfterDays={a.block_after_days} />
              </Disclosure>
            </CardBody>
          </Card>
        </div>

        {!empty && (
          <>
            <Card>
              <CardHeader
                title="Frais à facturer"
                icon={<Receipt />}
                description={"Facture récapitulative de chaque cycle, à envoyer au client dès la fin du cycle (CGV, article 5)."}
              />
              <CardBody className="space-y-2 pt-4">
                <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {cycles.map((c) => (
                    <li key={c.from}>
                      <a
                        href={`${basePath}/factures?du=${c.from}&au=${c.to}`}
                        download
                        className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-[13px] text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
                      >
                        <span className="min-w-0 truncate">
                          <span className="sr-only">Télécharger les frais à facturer{" "}: </span>
                          {c.label}
                          {c.current ? " (en cours)" : ""}
                        </span>
                        <Download aria-hidden className="size-4 shrink-0" />
                      </a>
                    </li>
                  ))}
                </ul>
                <Disclosure
                  title="Ce que contient l'export"
                  summaryClassName="text-[13px] text-fg-muted hover:text-fg"
                  contentClassName="pb-1 text-[13px] leading-relaxed text-fg-muted"
                >
                  <p>
                    Les frais pris en compte pendant le cycle (lignes enregistrées, baisses acceptées), toutes taxes comprises. Une ligne enregistrée après
                    coup arrive dans le cycle de son enregistrement, jamais dans un cycle déjà facturé. Le relevé mensuel ci-dessous, lui, range chaque
                    ligne à la date de sa course.
                  </p>
                </Disclosure>
              </CardBody>
            </Card>

            <PaymentsHistory payments={payments} orgName={org.name} currency={cur} timeZone={tz} />

            <StatementView statement={statement} months={months} basePath={basePath} />
          </>
        )}
      </PageBody>
      <PlatformLive orgs={[{ id: org.id, name: org.name }]} />
    </>
  );
}
