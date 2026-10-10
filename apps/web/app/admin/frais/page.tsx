import { formatNumber, formatPrice, type AdminPlatformOverview } from "@rydar/shared";
import { AlarmClock, Ban, Banknote, CircleCheck, CircleDollarSign, HandCoins, Inbox, Network, TrendingUp, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { PlatformLive } from "@/components/platform-fees/admin-platform-live";
import { Metric } from "@/components/platform-fees/admin-platform-metric";
import { AccountsTable, PaymentsToConfirm, PendingReductions } from "@/components/platform-fees/admin-platform-sections";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardHeader } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/misc";
import { requireSuperAdmin } from "@/lib/auth";
import { plural } from "@/lib/wording";

export const metadata: Metadata = { title: "Frais Rydar" };
export const dynamic = "force-dynamic";

const RULES = [
  "Les frais d'une course sont dus par la centrale dès la fin de la course, que le chauffeur l'ait payée ou non.",
  "Flotte : % du prix (0 sans prix) + frais fixes, dus dès la fin de chaque course, au taux en vigueur à ce moment-là.",
  "Seuls les paiements que vous confirmez comptent ; le montant reçu peut différer du montant déclaré.",
  "Une baisse de prix après la course ne réduit les frais qu'après votre décision : refus motivé seulement si elle ne correspond pas à la course réelle ; sans décision sous 30 jours, elle est acceptée automatiquement.",
  "Échéance : fin du cycle (mois ou semaine) + délai (45 jours au plus) ; les paiements soldent les frais les plus anciens d'abord.",
  // Engagements des CGV (art. 5) que le code ne contrôle pas seul : à respecter à la main
  "CGV : frais toutes taxes comprises, facture récapitulative à envoyer dès la fin de chaque cycle (compte de l'organisation › « Frais à facturer » ; le relevé n'est pas une facture).",
  "Seuil de blocage et relances : seulement pour une organisation qui a accepté les CGV en vigueur et reçoit la facture de chaque cycle (sinon, contestables).",
  "CGV : « Frais ajoutés » seulement pour corriger une erreur de calcul, sinon avec l'accord écrit de l'organisation ; cycle, délai et seuil de blocage changés en sa défaveur seulement avec son accord écrit.",
];

/**
 * Frais Rydar (docs/REFONTE-PANELS.md, R5) : ce que les clients doivent à Rydar. Quatre chiffres (les quatre autres
 * repliés, ouverts d'office si un compte est bloqué), « À traiter » (#a-traiter : paiements déclarés, baisses de
 * frais), les comptes des clients, puis la mécanique des frais repliée (8 règles, texte inchangé). Mêmes lectures ;
 * mise à jour en direct (PlatformLive) gardée.
 */
export default async function PlatformFeesPage() {
  const session = await requireSuperAdmin();
  // Coordonnées de paiement de Rydar et WhatsApp de Rydar : page « Réglages de la plateforme » (/admin/reglages).
  // Clients Flotte Privée : lecture seule de leur identifiant (badge de type des comptes), même session et même RLS.
  const [{ data, error }, privateFleets] = await Promise.all([
    session.supabase.rpc("admin_platform_overview"),
    session.supabase.from("organizations").select("id").eq("private_fleet", true),
  ]);
  if (error) console.error("[admin] frais Rydar : vue d'ensemble", error.message);
  const o = (data ?? null) as AdminPlatformOverview | null;
  const rows = o?.organizations ?? [];
  const t = o?.totals;
  const accounts = new Map(rows.map((r) => [r.id, r]));
  const overdueRows = rows.filter((r) => r.overdue_since && r.due_cents > 0);
  const privateIds = new Set(((privateFleets.data ?? []) as { id: string }[]).map((r) => r.id));
  const payments = o?.payments_to_confirm ?? [];
  const reductions = o?.pending_reductions ?? [];
  const toReview = (t?.declared_count ?? 0) + (t?.pending_reductions_count ?? 0);

  return (
    <>
      <PageHeader
        title="Frais Rydar"
        description={"Ce que vos clients doivent à Rydar : paiements à confirmer, retards et encaissements."}
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link href="/admin/centrales" prefetch={false}>
              <Network /> Commissions des centrales
            </Link>
          </Button>
        }
      />
      <PageBody className="space-y-6">
        {!o ? (
          <Callout tone="danger" title="Lecture impossible, réessayez dans un instant." />
        ) : (
          <>
            {/* Coordonnées absentes : vos clients ne savent pas comment payer (elles se règlent dans Réglages de la plateforme) */}
            {!(o.billing.iban || o.billing.payment_link) && (
              <Callout
                tone="warning"
                title="Vos clients ne voient aucune coordonnée de paiement"
                action={
                  <Link href="/admin/reglages" prefetch={false} className="inline-flex min-h-11 items-center text-[13px] font-medium text-brand hover:underline sm:min-h-0">
                    Réglages de la plateforme
                  </Link>
                }
              >
                Renseignez au moins un IBAN ou un lien de paiement.
              </Callout>
            )}

            {t && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Metric label="À recevoir" value={formatPrice(t.balance_cents)} sub={`solde de ${plural(rows.length, "client")}`} icon={<CircleDollarSign />} />
                  <Metric
                    label="En retard"
                    value={formatPrice(t.due_cents)}
                    tone={t.due_cents > 0 ? "red" : undefined}
                    sub={
                      overdueRows.length
                        ? `${plural(overdueRows.length, "client")} : ${overdueRows
                            .slice(0, 2)
                            .map((r) => r.name)
                            .join(", ")}${overdueRows.length > 2 ? "…" : ""}`
                        : "aucun retard"
                    }
                    icon={<AlarmClock />}
                  />
                  <Metric
                    label="À confirmer"
                    value={formatPrice(t.declared_cents)}
                    tone={toReview ? "amber" : undefined}
                    sub={
                      [
                        t.declared_count ? plural(t.declared_count, "paiement déclaré", "paiements déclarés") : null,
                        t.pending_reductions_count ? plural(t.pending_reductions_count, "baisse de frais", "baisses de frais") : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "rien à traiter"
                    }
                    icon={<Inbox />}
                    href={toReview ? "#a-traiter" : undefined}
                  />
                  <Metric label="Reçu ce mois" value={formatPrice(t.received_month_cents)} sub="paiements confirmés" icon={<HandCoins />} />
                </div>
                <Disclosure
                  title="Plus de chiffres"
                  hint={t.blocked_count ? plural(t.blocked_count, "compte bloqué", "comptes bloqués") : undefined}
                  forceOpen={t.blocked_count > 0}
                  className="surface rounded-xl px-4"
                  contentClassName="grid grid-cols-2 gap-3 pb-4 pt-1 md:grid-cols-4"
                >
                  <Metric label="Frais générés ce mois" value={formatPrice(t.fees_month_cents)} sub="courses terminées" icon={<TrendingUp />} />
                  <Metric label="Encaissé non réglé" value={formatPrice(t.held_by_centrales_cents)} sub="déjà entre les mains des clients" icon={<Banknote />} />
                  <Metric label="Chez les chauffeurs" value={formatPrice(t.with_drivers_cents)} sub="règlements pas encore encaissés" icon={<Users />} />
                  <Metric
                    label="Comptes bloqués"
                    value={formatNumber(t.blocked_count)}
                    tone={t.blocked_count ? "red" : undefined}
                    sub={t.blocked_count ? "création de courses refusée" : "aucun blocage"}
                    icon={<Ban />}
                  />
                </Disclosure>
              </div>
            )}

            {/* À traiter : ancre des liens de la vue d'ensemble et des pastilles (/admin/frais#a-traiter) */}
            <section id="a-traiter" aria-label="À traiter" className="scroll-mt-6 space-y-4">
              {payments.length > 0 && <PaymentsToConfirm payments={payments} accounts={accounts} />}
              {reductions.length > 0 && <PendingReductions entries={reductions} />}
              {!payments.length && !reductions.length && (
                <Card>
                  <EmptyState
                    size="compact"
                    icon={<CircleCheck />}
                    title="Rien à traiter."
                    description="Les paiements déclarés par vos clients et leurs baisses de frais arrivent ici."
                  />
                </Card>
              )}
            </section>
          </>
        )}

        {o && (
          <Card className="overflow-hidden">
            <CardHeader
              title="Comptes des clients"
              icon={<Users />}
              description={"Triés par retard, puis par solde (frais − paiements reçus). Une ligne ouvre le compte et son relevé."}
            />
            <AccountsTable rows={rows} privateIds={privateIds} />
          </Card>
        )}

        <Disclosure
          title={"Comment sont calculés les frais\u00a0?"}
          hint={plural(RULES.length, "règle")}
          className="surface max-w-4xl rounded-xl px-4 sm:px-5"
          contentClassName="pb-5 pt-1"
        >
          <p className="mb-3 text-[13px] text-fg-muted">Appliquées par la base de données, pour chaque centrale et chaque flotte.</p>
          <ul className="space-y-2.5">
            {RULES.map((r) => (
              <li key={r} className="flex gap-2.5 text-[13px] leading-relaxed text-fg-muted">
                <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-fg-subtle" />
                {r}
              </li>
            ))}
          </ul>
        </Disclosure>
      </PageBody>
      <PlatformLive orgs={rows.map((r) => ({ id: r.id, name: r.name }))} />
    </>
  );
}
