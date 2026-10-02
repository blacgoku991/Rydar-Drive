import { formatNumber, formatPrice, type AdminPlatformOverview } from "@rydar/shared";
import { AlarmClock, Ban, Banknote, CircleDollarSign, HandCoins, Inbox, Network, TrendingUp, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { BillingCard } from "@/components/platform-fees/admin-billing";
import { PlatformWhatsAppCard } from "@/components/platform-fees/admin-whatsapp";
import type { WhatsAppRow } from "@/components/whatsapp/whatsapp-card";
import { PlatformLive } from "@/components/platform-fees/admin-platform-live";
import { Metric } from "@/components/platform-fees/admin-platform-metric";
import { CentralesTable, PaymentsToConfirm, PendingReductions } from "@/components/platform-fees/admin-platform-sections";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireSuperAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Frais plateforme" };
export const dynamic = "force-dynamic";

const RULES = [
  "Les frais d'une course sont dus par la centrale dès la fin de la course, que le chauffeur l'ait payée ou non.",
  "Flotte : % du prix (0 sans prix) + frais fixes, dus dès la fin de chaque course, au taux en vigueur à ce moment-là.",
  "Seuls les paiements que vous confirmez comptent ; le montant reçu peut différer du montant déclaré.",
  "Une baisse de prix après la course ne réduit les frais qu'après votre accord.",
  "Échéance : fin du cycle (mois ou semaine) + délai ; les paiements soldent les frais les plus anciens d'abord.",
];

export default async function PlatformFeesPage() {
  const session = await requireSuperAdmin();
  const [{ data, error }, { data: whatsapp }] = await Promise.all([
    session.supabase.rpc("admin_platform_overview"),
    // RLS : super admin (le jeton d'accès n'est jamais lisible)
    session.supabase
      .from("platform_whatsapp")
      .select("phone_number_id, display_phone, verified_name, template, language, enabled, sent_count, last_sent_at, last_error, last_error_at")
      .maybeSingle(),
  ]);
  const o = (data ?? null) as AdminPlatformOverview | null;
  const rows = o?.organizations ?? [];
  const t = o?.totals;
  const accounts = new Map(rows.map((r) => [r.id, r]));
  const overdueRows = rows.filter((r) => r.overdue_since);
  const toReview = (t?.declared_count ?? 0) + (t?.pending_reductions_count ?? 0);

  return (
    <>
      <PageHeader
        eyebrow="Plateforme"
        title="Frais plateforme"
        description="Ce que les centrales et les flottes doivent reverser à Rydar : frais de chaque course terminée, paiements déclarés à confirmer, retards et relances."
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link href="/admin/centrales">
              <Network /> Centrales
            </Link>
          </Button>
        }
      />
      <PageBody className="space-y-6">
        {error && (
          <p className="rounded-xl border border-red/25 bg-red/[0.07] px-4 py-3 text-[13px] text-red">Frais plateforme indisponibles&nbsp;: {error.message}</p>
        )}
        {t && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric
              label="À recevoir"
              value={formatPrice(t.balance_cents)}
              tone={t.balance_cents > 0 ? "amber" : "green"}
              sub={`solde de ${rows.length} compte${rows.length > 1 ? "s" : ""}`}
              icon={<CircleDollarSign />}
            />
            <Metric
              label="Échu"
              value={formatPrice(t.due_cents)}
              tone={t.overdue_count ? "red" : t.due_cents > 0 ? "amber" : undefined}
              sub={
                t.overdue_count
                  ? `${t.overdue_count} en retard : ${overdueRows
                      .slice(0, 2)
                      .map((r) => r.name)
                      .join(", ")}${overdueRows.length > 2 ? "…" : ""}`
                  : "aucun compte en retard"
              }
              icon={<AlarmClock />}
            />
            <Metric
              label="À confirmer"
              value={formatPrice(t.declared_cents)}
              tone={t.declared_count ? "blue" : undefined}
              sub={
                t.declared_count
                  ? `${t.declared_count} paiement${t.declared_count > 1 ? "s" : ""} déclaré${t.declared_count > 1 ? "s" : ""}${t.pending_reductions_count ? ` · ${t.pending_reductions_count} baisse${t.pending_reductions_count > 1 ? "s" : ""}` : ""}`
                  : t.pending_reductions_count
                    ? `${t.pending_reductions_count} baisse${t.pending_reductions_count > 1 ? "s" : ""} à valider`
                    : "rien à traiter"
              }
              icon={<Inbox />}
              href={toReview ? "#a-traiter" : undefined}
            />
            <Metric label="Reçu ce mois" value={formatPrice(t.received_month_cents)} tone="green" sub="paiements confirmés" icon={<HandCoins />} />
            <Metric label="Frais générés ce mois" value={formatPrice(t.fees_month_cents)} tone="violet" sub="courses terminées" icon={<TrendingUp />} />
            <Metric
              label="Encaissé non reversé"
              value={formatPrice(t.held_by_centrales_cents)}
              tone={t.held_by_centrales_cents > 0 ? "amber" : undefined}
              sub="déjà entre les mains des centrales et flottes"
              icon={<Banknote />}
            />
            <Metric label="Chez les chauffeurs" value={formatPrice(t.with_drivers_cents)} sub="règlements pas encore encaissés" icon={<Users />} />
            <Metric
              label="Comptes bloqués"
              value={formatNumber(t.blocked_count)}
              tone={t.blocked_count ? "red" : undefined}
              sub={t.blocked_count ? "création de courses refusée" : "aucun blocage"}
              icon={<Ban />}
            />
          </div>
        )}

        {o && (
          <section id="a-traiter" aria-label="À traiter" className="scroll-mt-6 space-y-4">
            <PaymentsToConfirm payments={o.payments_to_confirm} accounts={accounts} />
            {(o.pending_reductions.length > 0 || rows.length > 0) && <PendingReductions entries={o.pending_reductions} />}
          </section>
        )}

        <Card className="overflow-hidden">
          <CardHeader
            title="Centrales et flottes"
            icon={<Network />}
            description="Triées par montant échu puis par solde. Solde = frais comptabilisés − paiements reçus. Cliquez une ligne pour le détail et le relevé."
          />
          <CentralesTable rows={rows} />
        </Card>

        {o && (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <div className="space-y-6">
              <BillingCard billing={o.billing} />
              <PlatformWhatsAppCard row={(whatsapp ?? null) as WhatsAppRow | null} />
            </div>
            <Card>
              <CardHeader title="Règles" description="Appliquées par la base de données, pour chaque centrale et chaque flotte." />
              <CardBody className="pt-4">
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
          </div>
        )}
      </PageBody>
      <PlatformLive orgs={rows.map((r) => ({ id: r.id, name: r.name }))} />
    </>
  );
}
