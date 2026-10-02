// Relevé mensuel des frais plateforme reversés à Rydar (owner / admin), rendu serveur commun aux deux modèles :
//   • centrale : /dashboard/settlements/rydar (retour « Encaissements ») ;
//   • flotte : /dashboard/rydar/releve (retour « Frais Rydar ») — pas de colonne « règlement chauffeur ».
//   ?mois=YYYY-MM  (défaut : mois en cours, fuseau de l'organisation)
import { formatPrice, platformDueSummary, type OrgPlatformAccount, type PlatformStatement } from "@rydar/shared";
import { ArrowLeft, Download, Landmark } from "lucide-react";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { currentMonth, parseMonth } from "@/components/platform-fees/org-payer-context";
import { price } from "@/components/platform-fees/org-platform-format";
import { PLATFORM_STATEMENT_EXPORT, platformFeesPaths } from "@/components/platform-fees/org-platform-paths";
import { StatementEntries, StatementPayments, StatementSummary, monthLabel } from "@/components/platform-fees/org-statement";
import { toneText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { cn } from "@/lib/utils";

export async function OrgStatementPage({ searchParams }: { searchParams: Promise<{ mois?: string }> }) {
  const ctx = await requireOrg();
  const sp = await searchParams;
  const tz = ctx.org.timezone || "Europe/Paris";
  const fleet = ctx.org.dispatch_model !== "centrale";
  const paths = platformFeesPaths(ctx.org.dispatch_model);
  const title = fleet ? "Relevé des frais Rydar" : "Relevé des frais plateforme";
  const back = (
    <Link href={paths.account} className="inline-flex items-center gap-1 hover:text-fg">
      <ArrowLeft className="size-3.5" /> {paths.back}
    </Link>
  );

  if (!isAdminRole(ctx.role)) {
    return (
      <>
        <PageHeader eyebrow={back} title={title} />
        <PageBody>
          <Card>
            <EmptyState
              icon={<Landmark />}
              title="Réservé aux administrateurs"
              description={`Le relevé des frais reversés à Rydar est visible par le propriétaire et les administrateurs ${fleet ? "de la flotte" : "de la centrale"}.`}
            />
          </Card>
        </PageBody>
      </>
    );
  }

  const month = parseMonth(sp.mois) ?? currentMonth(tz);
  const [account, statement] = await Promise.all([
    ctx.supabase.rpc("org_platform_account", { p_org: ctx.org.id }),
    ctx.supabase.rpc("org_platform_statement", { p_org: ctx.org.id, p_month: month }),
  ]);
  const acc = (account.data ?? null) as OrgPlatformAccount | null;
  const s = (statement.data ?? null) as PlatformStatement | null;

  if (account.error || statement.error || !acc || !s) {
    return (
      <>
        <PageHeader eyebrow={back} title={title} />
        <PageBody>
          <Card>
            <EmptyState icon={<Landmark />} title="Relevé indisponible" description="La lecture de votre compte auprès de Rydar a échoué. Réessayez dans un instant." />
          </Card>
        </PageBody>
      </>
    );
  }
  if (!acc.enabled) {
    return (
      <>
        <PageHeader eyebrow={back} title={title} />
        <PageBody>
          <Card>
            <EmptyState
              icon={<Landmark />}
              title="Aucun frais Rydar"
              description={"Rydar ne vous facture aucun frais par course : aucun montant n'est dû en dehors de votre abonnement."}
            />
          </Card>
        </PageBody>
      </>
    );
  }

  const a = acc.account;
  const cur = a.currency || "EUR";
  const due = platformDueSummary(a, tz);
  const months = acc.months.some((m) => m.month === s.month) ? acc.months : [...acc.months, { month: s.month, fees_cents: s.fees_cents, rides: 0, received_cents: s.received_cents }];

  return (
    <>
      <PageHeader
        eyebrow={back}
        title={title}
        description={
          <>
            Frais reversés à Rydar par {acc.organization.name} : chaque course, correction, avoir et paiement du mois. Référence à indiquer sur vos
            virements : <span className="mono whitespace-nowrap text-fg">{a.reference}</span>.
          </>
        }
        actions={
          <Button asChild variant="outline">
            <a href={`${PLATFORM_STATEMENT_EXPORT}?mois=${s.month}`} download>
              <Download /> Exporter CSV
            </a>
          </Button>
        }
      />
      <PageBody className="space-y-6">
        {/* Mois (6 derniers) */}
        <nav aria-label="Mois du relevé" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {months.map((m) => {
            const active = m.month === s.month;
            return (
              <Link
                key={m.month}
                href={`${paths.statement}?mois=${m.month}`}
                aria-current={active ? "page" : undefined}
                scroll={false}
                className={cn(
                  "flex min-w-[118px] shrink-0 flex-col rounded-xl border px-3.5 py-2.5 transition-colors",
                  active ? "border-brand/50 bg-brand/[0.06]" : "border-line bg-ink-800 hover:border-line-strong",
                )}
              >
                <span className={cn("text-[12.5px] font-medium capitalize", active ? "text-fg" : "text-fg-muted")}>{monthLabel(m.month, "short")}</span>
                <span className="mono mt-0.5 text-[13px] text-fg">{formatPrice(m.fees_cents, cur)}</span>
                <span className="text-[11.5px] text-fg-muted">{m.received_cents > 0 ? `${formatPrice(m.received_cents, cur)} reçus` : m.rides > 0 ? `${m.rides} course${m.rides > 1 ? "s" : ""}` : "aucune course"}</span>
              </Link>
            );
          })}
        </nav>

        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-[17px] font-semibold capitalize tracking-tight">{monthLabel(s.month)}</h2>
          <p className="text-[12.5px] text-fg-muted">
            Solde actuel <span className={cn("mono font-semibold", a.balance_cents > 0 ? "text-amber" : "text-green")}>{price(Math.max(0, a.balance_cents), cur)}</span> ·{" "}
            <span className={toneText[due.tone]}>{due.text}</span>
          </p>
        </div>

        <StatementSummary s={s} />
        <StatementEntries s={s} />
        <StatementPayments s={s} />

        <p className="text-[12px] leading-5 text-fg-muted">
          {fleet ? (
            <>
              Vos frais Rydar sont dus dès la fin de chaque course (les frais fixes même sans prix), au taux en vigueur à la fin de la course. Seuls les
              paiements confirmés par Rydar font baisser le solde&nbsp;; une baisse de frais (prix corrigé après la course) ne compte qu&apos;une fois
              acceptée par Rydar.
            </>
          ) : (
            <>
              Vos frais plateforme sont dus dès la fin de chaque course, que le chauffeur vous ait payé ou non. Seuls les paiements confirmés par Rydar font
              baisser le solde ; une baisse de frais (prix corrigé après la course) ne compte qu&apos;une fois acceptée par Rydar.
            </>
          )}
        </p>
      </PageBody>
    </>
  );
}
