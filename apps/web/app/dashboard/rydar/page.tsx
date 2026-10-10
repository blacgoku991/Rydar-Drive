import { isoDayLabel, type OrgPlatformAccount } from "@rydar/shared";
import { Landmark } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { OrgPlatformCard } from "@/components/platform-fees/org-platform-card";
import { feeTermsText } from "@/components/platform-fees/org-platform-format";
import { platformFeesPaths } from "@/components/platform-fees/org-platform-paths";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/misc";
import { isAdminRole, requireOrg } from "@/lib/auth";
import { isPrivateFleet } from "@/lib/private-fleet";

export const metadata: Metadata = { title: "Frais Rydar" };
export const dynamic = "force-dynamic";

const NB = " ";
// Espace insécable ( ) avant « ; » et « : »
const RULES = [
  "Dus dès la fin de chaque course terminée ; une course annulée ne coûte rien.",
  "Montant : le pourcentage s'applique au prix de la course, les frais fixes sont dus même sans prix.",
  "Taux en vigueur à la fin de la course ; un prix corrigé ensuite ajoute une correction (une baisse attend l'accord de Rydar).",
  "Seuls les paiements confirmés par Rydar font baisser le solde ; ils soldent d'abord les échéances les plus anciennes.",
  "Toute hausse de ces frais vous est annoncée au moins 30 jours à l'avance (par e-mail et sur cette page), sauf accord écrit de votre part ; une baisse s'applique tout de suite.",
  "Montants toutes taxes comprises : ce qui est affiché est ce que vous payez. Rydar vous adresse une facture récapitulative à la fin de chaque cycle (le relevé n'en est pas une).",
];

/** Lien vers l'onglet « Abonnement » des réglages. */
const BILLING_HREF = "/dashboard/settings?tab=billing";

/**
 * « Frais Rydar » d'une FLOTTE ou d'une Flotte Privée (owner / admin) : ce que l'organisation doit à Rydar par course
 * terminée, en plus de son abonnement (20260924006400) — la carte (montant principal, échéance, solde, hausse annoncée,
 * « J'ai payé », relevé) puis les règles de calcul, repliées. Une centrale retrouve la même carte en tête d'« Encaissements ».
 */
export default async function FleetPlatformFeesPage() {
  const ctx = await requireOrg();
  if (ctx.org.dispatch_model === "centrale") redirect(platformFeesPaths("centrale").account);
  const paths = platformFeesPaths("fleet");
  const privateFleet = isPrivateFleet(ctx.org);

  if (!isAdminRole(ctx.role)) {
    return (
      <>
        <PageHeader title="Frais Rydar" />
        <PageBody>
          <Card>
            <EmptyState
              icon={<Landmark />}
              title="Réservé aux administrateurs"
              description="Les frais dus à Rydar sont visibles par le propriétaire et les administrateurs de la flotte."
            />
          </Card>
        </PageBody>
      </>
    );
  }

  const { data, error } = await ctx.supabase.rpc("org_platform_account", { p_org: ctx.org.id });
  const acc = (data ?? null) as OrgPlatformAccount | null;
  if (error || !acc) {
    return (
      <>
        <PageHeader title="Frais Rydar" />
        <PageBody>
          <Callout tone="warning" icon={<Landmark />} title="Frais Rydar">
            Lecture impossible, réessayez dans un instant.
          </Callout>
        </PageBody>
      </>
    );
  }
  if (!acc.enabled) {
    return (
      <>
        <PageHeader title="Frais Rydar" />
        <PageBody>
          <Callout tone="neutral" icon={<Landmark />} title="Aucun frais par course">
            Rydar ne vous facture aucun frais par course{NB}: seul votre abonnement est dû (
            <Link href={BILLING_HREF} prefetch={false} className="text-fg underline underline-offset-2 hover:text-brand">
              Réglages › Abonnement
            </Link>
            ).
          </Callout>
        </PageBody>
      </>
    );
  }

  const perRide = Number(acc.account.fee_percent) > 0 || acc.account.fee_fixed_cents > 0;
  return (
    <>
      <PageHeader
        title="Frais Rydar"
        description={
          <>
            {perRide
              ? `En plus de votre abonnement, Rydar facture ${feeTermsText(acc.account)}.`
              : acc.account.scheduled_change
                ? `Aucun frais par course pour l'instant${NB}: un changement est annoncé à partir du ${isoDayLabel(acc.account.scheduled_change.effective_on)} (détail ci-dessous).`
                : `Aucun frais par course pour l'instant${NB}: seuls les montants déjà enregistrés restent à régler.`}{" "}
            Réglez Rydar puis déclarez votre paiement ici{NB}: Rydar confirme sa réception.
            {/* Flotte Privée : le propriétaire est le seul chauffeur, la phrase n'a pas de sens */}
            {privateFleet ? null : " Vos chauffeurs ne voient jamais ces frais."}
          </>
        }
      />
      <PageBody className="space-y-6">
        <OrgPlatformCard data={acc} serverNow={Date.now()} statementHref={paths.statement} />
        <Disclosure
          title="Comment sont calculés vos frais Rydar"
          className="surface rounded-xl"
          summaryClassName="px-4 sm:px-5"
          contentClassName="border-t border-line px-4 py-4 sm:px-5"
        >
          <ul className="space-y-2.5">
            {RULES.map((r) => (
              <li key={r} className="flex gap-2.5 text-[13px] leading-relaxed text-fg-muted">
                <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-fg-muted" />
                {r}
              </li>
            ))}
          </ul>
        </Disclosure>
      </PageBody>
    </>
  );
}
