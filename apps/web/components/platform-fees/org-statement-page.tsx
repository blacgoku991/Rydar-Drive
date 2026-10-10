// Relevé mensuel des frais Rydar (owner / admin), rendu serveur commun aux deux modèles — « Relevé des frais Rydar » :
//   • centrale : /dashboard/settlements/rydar (retour « Encaissements ») ;
//   • flotte : /dashboard/rydar/releve (retour « Frais Rydar ») — pas de règlement chauffeur.
//   ?mois=YYYY-MM  (défaut : mois en cours, fuseau de l'organisation)
// En tête : le montant principal (pay-now.ts, la même phrase que la carte et le bandeau) et « J'ai payé ». Mois sans
// activité masqués (sauf le mois en cours) ; montants et export CSV inchangés.
import { formatPrice, type OrgPlatformAccount, type PlatformStatement } from "@rydar/shared";
import { Download, Landmark } from "lucide-react";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { PlatformPayButton } from "@/components/platform-fees/org-pay-dialog";
import { currentMonth, parseMonth } from "@/components/platform-fees/org-payer-context";
import { PLATFORM_STATEMENT_EXPORT, platformFeesPaths } from "@/components/platform-fees/org-platform-paths";
import { PayNowLine } from "@/components/platform-fees/org-platform-ui";
import { StatementEntries, StatementPayments, StatementSummary, capitalizeMonth, monthLabel } from "@/components/platform-fees/org-statement";
import { payNowDetails, payNowSummary } from "@/components/platform-fees/pay-now";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { FilterTabs } from "@/components/ui/filter-tabs";
import { EmptyState } from "@/components/ui/misc";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { orgWords } from "@/lib/wording";

const NB = " ";
const TITLE = "Relevé des frais Rydar";

export async function OrgStatementPage({ searchParams }: { searchParams: Promise<{ mois?: string }> }) {
  const ctx = await requireOrg();
  const sp = await searchParams;
  const tz = ctx.org.timezone || "Europe/Paris";
  const paths = platformFeesPaths(ctx.org.dispatch_model);
  const back = { href: paths.account, label: paths.back };

  if (!isAdminRole(ctx.role)) {
    return (
      <>
        <PageHeader back={back} title={TITLE} />
        <PageBody>
          <Card>
            <EmptyState
              icon={<Landmark />}
              title="Réservé aux administrateurs"
              description={`Le relevé des frais Rydar est visible par le propriétaire et les administrateurs ${orgWords(ctx.org.dispatch_model).ofThe}.`}
            />
          </Card>
        </PageBody>
      </>
    );
  }

  const thisMonth = currentMonth(tz);
  const month = parseMonth(sp.mois) ?? thisMonth;
  const [account, statement] = await Promise.all([
    ctx.supabase.rpc("org_platform_account", { p_org: ctx.org.id }),
    ctx.supabase.rpc("org_platform_statement", { p_org: ctx.org.id, p_month: month }),
  ]);
  const acc = (account.data ?? null) as OrgPlatformAccount | null;
  const s = (statement.data ?? null) as PlatformStatement | null;

  if (account.error || statement.error || !acc || !s) {
    return (
      <>
        <PageHeader back={back} title={TITLE} />
        <PageBody>
          <Callout tone="warning" icon={<Landmark />} title="Relevé indisponible">
            Lecture impossible, réessayez dans un instant.
          </Callout>
        </PageBody>
      </>
    );
  }
  if (!acc.enabled) {
    return (
      <>
        <PageHeader back={back} title={TITLE} />
        <PageBody>
          <Card>
            <EmptyState
              icon={<Landmark />}
              title="Aucun frais Rydar"
              description={`Rydar ne vous facture aucun frais par course${NB}: aucun montant n'est dû en dehors de votre abonnement.`}
            />
          </Card>
        </PageBody>
      </>
    );
  }

  const a = acc.account;
  const cur = a.currency || "EUR";
  const now = Date.now();
  const pay = payNowSummary(a, now, tz);
  const fleet = ctx.org.dispatch_model !== "centrale";
  // Mois de la liste (6 derniers) : sans activité masqués, sauf le mois en cours et le mois affiché
  const known = acc.months.some((m) => m.month === s.month) ? acc.months : [...acc.months, { month: s.month, fees_cents: s.fees_cents, rides: 0, received_cents: s.received_cents }];
  const months = known.filter((m) => m.fees_cents !== 0 || m.rides > 0 || m.received_cents > 0 || m.month === thisMonth || m.month === s.month);

  return (
    <>
      <PageHeader
        back={back}
        title={TITLE}
        description={
          <>
            Chaque course, correction, avoir et paiement du mois. Référence à indiquer sur vos virements{NB}:{" "}
            <span className="mono whitespace-nowrap text-fg">{a.reference}</span>.
          </>
        }
        actions={
          <>
            <PlatformPayButton pay={acc.pay} account={a} timeZone={tz} primary={pay.kind !== "nothing"} className="max-sm:h-11 max-sm:flex-1" />
            <Button asChild variant="outline" className="max-sm:h-11 max-sm:flex-1">
              <a href={`${PLATFORM_STATEMENT_EXPORT}?mois=${s.month}`} download>
                <Download /> Exporter CSV
              </a>
            </Button>
          </>
        }
      />
      <PageBody className="space-y-6">
        <div className="rounded-xl border border-line bg-white/[0.02] px-4 py-3">
          <PayNowLine pay={pay} />
          {payNowDetails(pay) && <p className="mt-1 text-[13px] text-fg-muted">{payNowDetails(pay)}</p>}
        </div>

        {months.length > 1 && (
          <FilterTabs
            label="Mois du relevé"
            items={months.map((m) => ({
              href: `${paths.statement}?mois=${m.month}`,
              label: `${capitalizeMonth(monthLabel(m.month, "short"))} · ${formatPrice(m.fees_cents, cur)}`,
              active: m.month === s.month,
            }))}
          />
        )}

        <h2 className="text-[17px] font-semibold tracking-tight">{capitalizeMonth(monthLabel(s.month))}</h2>
        <StatementSummary s={s} current={s.month === thisMonth} />
        <StatementEntries s={s} now={now} />
        <StatementPayments s={s} />

        <p className="text-[13px] leading-5 text-fg-muted">
          {fleet ? (
            <>
              Vos frais Rydar sont dus dès la fin de chaque course (les frais fixes même sans prix), au taux en vigueur à la fin de la course. Seuls les
              paiements confirmés par Rydar font baisser le solde{NB}; une baisse de frais (prix corrigé après la course) ne compte qu&apos;une fois
              acceptée par Rydar.
            </>
          ) : (
            <>
              Vos frais Rydar sont dus dès la fin de chaque course, que le chauffeur vous ait payé ou non. Seuls les paiements confirmés par Rydar font
              baisser le solde{NB}; une baisse de frais (prix corrigé après la course) ne compte qu&apos;une fois acceptée par Rydar.
            </>
          )}
        </p>
      </PageBody>
    </>
  );
}
