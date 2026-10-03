import { isoDayLabel, type OrgPlatformAccount } from "@rydar/shared";
import { Landmark } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { OrgPlatformCard } from "@/components/platform-fees/org-platform-card";
import { feeTermsText } from "@/components/platform-fees/org-platform-format";
import { platformFeesPaths } from "@/components/platform-fees/org-platform-paths";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { isAdminRole, requireOrg } from "@/lib/auth";

export const metadata: Metadata = { title: "Frais Rydar" };
export const dynamic = "force-dynamic";

// Espace insécable ( ) avant « ; » et « : »
const RULES = [
  "Dus dès la fin de chaque course terminée ; une course annulée ne coûte rien.",
  "Montant : le pourcentage s'applique au prix de la course, les frais fixes sont dus même sans prix.",
  "Taux en vigueur à la fin de la course ; un prix corrigé ensuite ajoute une correction (une baisse attend l'accord de Rydar).",
  "Seuls les paiements confirmés par Rydar font baisser le solde ; ils soldent d'abord les échéances les plus anciennes.",
  "Toute hausse de ces frais vous est annoncée au moins 30 jours à l'avance (par e-mail et sur cette page), sauf accord écrit de votre part ; une baisse s'applique tout de suite.",
  "Montants toutes taxes comprises : ce qui est affiché est ce que vous payez. Rydar vous adresse une facture récapitulative à la fin de chaque cycle (le relevé n'en est pas une).",
];

/**
 * « Frais Rydar » d'une FLOTTE (owner / admin) : ce que la flotte doit à Rydar par course terminée, en plus de son
 * abonnement (20260924006400) — solde, échéance, « J'ai payé », paiements, relevé mensuel. Entrée du menu
 * « Organisation » quand des frais sont réglés ; une centrale retrouve la même carte en tête de « Encaissements ».
 */
export default async function FleetPlatformFeesPage() {
  const ctx = await requireOrg();
  if (ctx.org.dispatch_model === "centrale") redirect(platformFeesPaths("centrale").account);
  const paths = platformFeesPaths("fleet");

  if (!isAdminRole(ctx.role)) {
    return (
      <>
        <PageHeader eyebrow="Organisation" title="Frais Rydar" />
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
        <PageHeader eyebrow="Organisation" title="Frais Rydar" />
        <PageBody>
          <Card>
            <EmptyState icon={<Landmark />} title="Frais Rydar indisponibles" description="La lecture de votre compte auprès de Rydar a échoué. Réessayez dans un instant." />
          </Card>
        </PageBody>
      </>
    );
  }
  if (!acc.enabled) {
    return (
      <>
        <PageHeader eyebrow="Organisation" title="Frais Rydar" />
        <PageBody>
          <Card>
            <EmptyState
              icon={<Landmark />}
              title="Aucun frais par course"
              description={"Rydar ne vous facture aucun frais par course : seul votre abonnement est dû (Réglages → Abonnement)."}
            />
          </Card>
        </PageBody>
      </>
    );
  }

  const perRide = Number(acc.account.fee_percent) > 0 || acc.account.fee_fixed_cents > 0;
  return (
    <>
      <PageHeader
        eyebrow="Organisation"
        title="Frais Rydar"
        description={
          <>
            {perRide
              ? `En plus de votre abonnement, Rydar facture ${feeTermsText(acc.account)}.`
              : acc.account.scheduled_change
                ? `Aucun frais par course pour l'instant\u00a0: un changement est annoncé à partir du ${isoDayLabel(acc.account.scheduled_change.effective_on)} (détail ci-dessous).`
                : "Aucun frais par course pour l'instant\u00a0: seuls les montants déjà enregistrés restent à régler."}{" "}
            Réglez Rydar puis déclarez votre paiement ici&nbsp;: Rydar confirme sa réception. Vos chauffeurs ne voient jamais ces frais.
          </>
        }
      />
      <PageBody className="space-y-6">
        <OrgPlatformCard data={acc} serverNow={Date.now()} statementHref={paths.statement} />
        <Card>
          <CardHeader title="Comment sont calculés vos frais Rydar" icon={<Landmark />} />
          <CardBody>
            <ul className="space-y-2.5">
              {RULES.map((r) => (
                <li key={r} className="flex gap-2.5 text-[13px] leading-relaxed text-fg-muted">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-violet" />
                  {r}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </PageBody>
    </>
  );
}
