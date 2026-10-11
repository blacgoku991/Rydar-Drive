import { formatCompactPrice, formatNumber, formatRelative } from "@rydar/shared";
import { ChevronRight, CircleCheck, Globe, Radar, Route, UsersRound, Wallet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PlatformDailyChart } from "@/components/admin/admin-widgets";
import { adminLegalTodo, adminTodoItems, type AdminTodoItem } from "@/components/admin/admin-todo";
import { ClientsActivityCard, HeadcountCards } from "@/components/admin/headcount";
import { clientActivityRows, getAdminTodo, getPlatformHeadcount, type PlatformHeadcount, type PlatformOverview } from "@/components/admin/platform-data";
import { PageBody, PageHeader, StatCard } from "@/components/layout/page-header";
import { toneDot, toneText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/misc";
import { requireSuperAdmin } from "@/lib/auth";
import { getLegalInfo } from "@/lib/legal";
import { legalNoticeGaps } from "@/lib/legal-notice";
import { cn } from "@/lib/utils";
import { dispatchLevel, plural } from "@/lib/wording";

export const metadata: Metadata = { title: "Vue d'ensemble" };
export const dynamic = "force-dynamic";

/** Alertes récentes affichées (les autres : Supervision › Dispatch & erreurs). */
const RECENT_ALERTS = 5;

/**
 * Vue d'ensemble du super admin (docs/REFONTE-PANELS.md, R3) : d'abord ce qui demande une décision (« À traiter » :
 * mêmes compteurs que les pastilles du menu), puis quatre chiffres, la santé du dispatch en une ligne, l'activité de
 * chaque client, les effectifs détaillés (repliés), le graphique des courses et les dernières alertes.
 */
export default async function AdminOverview() {
  const session = await requireSuperAdmin();
  const [overview, headcount, editor, legal, todo] = await Promise.all([
    session.supabase.rpc("platform_overview"),
    // Effectifs (clients, chauffeurs, comptes, super admins) : lecture RLS du super admin
    getPlatformHeadcount(session.supabase).catch((err: unknown): PlatformHeadcount | null => {
      console.error("[admin] effectifs", err);
      return null;
    }),
    // Identité de l'éditeur (partie aux CGV) : sans raison sociale, siège et immatriculation, accept_legal_documents
    // refuse les CGV et l'accord de traitement (LEGAL_EDITOR_MISSING, 20260924007400)
    session.supabase.from("platform_legal").select("company_name, address, registration").maybeSingle(),
    getLegalInfo(),
    // Mêmes compteurs que les pastilles du menu (layout) : une seule lecture par rendu (cache de React)
    getAdminTodo(session.supabase),
  ]);
  if (overview.error) console.error("[admin] vue d'ensemble", overview.error.message);
  if (editor.error) console.error("[admin] éditeur", editor.error.message);
  const o = (overview.error ? null : overview.data) as PlatformOverview | null;
  const t = o?.totals ?? null;
  const items = adminTodoItems(
    todo,
    adminLegalTodo({
      error: editor.error,
      editor: (editor.data ?? null) as { company_name: string | null; address: string | null; registration: string | null } | null,
      missingNotices: legalNoticeGaps({ ...legal, companyName: legal.nameSet ? legal.name : "" }).filter((g) => g.required).length,
    }),
  );
  const clients = clientActivityRows(o?.organizations ?? null, headcount?.perOrg ?? null);
  const alerts = (o?.recent_errors ?? []).slice(0, RECENT_ALERTS);

  return (
    <>
      <PageHeader
        title="Vue d'ensemble"
        description="Ce qui demande votre attention, puis l'activité de vos clients."
        actions={
          // Sur téléphone, le chiffre « Chauffeurs en ligne » mène à la carte : bouton réservé au grand écran
          <Button asChild variant="secondary" size="sm" className="max-sm:hidden">
            <Link href="/admin/carte" prefetch={false}>
              <Globe /> Carte en direct
            </Link>
          </Button>
        }
      />
      <PageBody className="space-y-4 sm:space-y-6">
        <TodoCard items={items} />

        {!t && (
          <Callout tone="warning" title="Chiffres indisponibles">
            Lecture impossible, réessayez dans un instant.
          </Callout>
        )}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Chauffeurs en ligne"
            value={t ? `${formatNumber(t.drivers_online)}\u00a0/\u00a0${formatNumber(t.drivers)}` : "—"}
            sub="Voir sur la carte en direct"
            icon={<span className="max-sm:hidden"><UsersRound /></span>}
            href="/admin/carte"
            className="max-sm:px-3"
          />
          <StatCard
            label="Courses aujourd'hui"
            value={formatNumber(t?.rides_today)}
            // Courses actives : en recherche, attribuées ou en cours, toutes dates (platform_overview.active_rides)
            sub={t ? `${formatNumber(t.active_rides)} en cours ou à venir` : undefined}
            icon={<span className="max-sm:hidden"><Route /></span>}
            className="max-sm:px-3"
          />
          <StatCard label="Volume du mois" value={formatCompactPrice(t?.gmv_month_cents)} sub="courses terminées" icon={<span className="max-sm:hidden"><Radar /></span>} className="max-sm:px-3" />
          <StatCard label="Abonnements par mois" value={formatCompactPrice(t?.mrr_cents)} sub="abonnements en cours" icon={<span className="max-sm:hidden"><Wallet /></span>} className="max-sm:px-3" />
        </div>

        {t && (
          // Téléphone : trois tuiles côte à côte (nombre, puis ce qu'il compte) ; grand écran : une ligne de liens compacts
          <section aria-labelledby="sante" className="space-y-2 sm:flex sm:flex-wrap sm:items-center sm:gap-2 sm:space-y-0">
            <h2 id="sante" className="text-[13px] font-medium text-fg-muted sm:mr-1">
              Santé
            </h2>
            <div className="grid grid-cols-3 gap-2 sm:contents">
              <HealthLink href="/admin/dispatch" n={t.no_driver_24h} tone="red" one="course sans chauffeur" many="courses sans chauffeur" period={"24\u00a0h"} />
              <HealthLink
                href="/admin/notifications"
                n={t.notifications_failed_24h}
                tone="amber"
                one="notification en échec"
                many="notifications en échec"
                period={"24\u00a0h"}
              />
              <HealthLink
                href="/admin/audit?severity=security"
                n={t.security_events_7d}
                tone="amber"
                one="alerte de sécurité"
                many="alertes de sécurité"
                period={"7\u00a0j"}
              />
            </div>
          </section>
        )}

        <ClientsActivityCard rows={clients} unavailable={!o && !headcount} />

        <Disclosure
          title="Effectifs détaillés"
          hint="clients, chauffeurs, comptes"
          className="surface rounded-xl px-4"
          contentClassName="pb-4 pt-1"
        >
          {headcount ? (
            <HeadcountCards hc={headcount} />
          ) : (
            <p className="text-[13px] text-fg-muted">Lecture impossible, réessayez dans un instant.</p>
          )}
        </Disclosure>

        <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
          <Card>
            <CardHeader title="Courses sur la plateforme" description="30 derniers jours, tous clients." />
            <CardBody>
              {o ? <PlatformDailyChart data={o.daily ?? []} /> : <p className="text-[13px] text-fg-muted">Lecture impossible, réessayez dans un instant.</p>}
            </CardBody>
          </Card>
          <Card className="overflow-hidden">
            <CardHeader
              title="Alertes récentes"
              description="Dispatch, 7 derniers jours."
              action={
                <Link href="/admin/dispatch" prefetch={false} className="inline-flex min-h-11 items-center text-[13px] font-medium text-brand hover:underline sm:min-h-8">
                  Tout voir<span className="sr-only">{"\u00a0: alertes du dispatch"}</span>
                </Link>
              }
            />
            {!o ? (
              <CardBody className="text-[13px] text-fg-muted">Lecture impossible, réessayez dans un instant.</CardBody>
            ) : alerts.length === 0 ? (
              <EmptyState size="compact" icon={<CircleCheck />} title="Aucune alerte." description="Rien à signaler sur les 7 derniers jours." />
            ) : (
              <ul className="divide-y divide-line">
                {alerts.map((e) => {
                  const level = dispatchLevel(e.level);
                  return (
                    <li key={e.id} className="flex items-start gap-3 px-5 py-2.5">
                      <span aria-hidden className={cn("mt-[7px] size-2 shrink-0 rounded-full", toneDot[level.tone])} />
                      <div className="min-w-0">
                        <p className="text-[13px] text-fg [overflow-wrap:anywhere]">{e.message}</p>
                        <p className="mt-0.5 text-[12px] text-fg-muted">
                          <span className={toneText[level.tone]}>{level.label}</span> · {e.organization} · {formatRelative(e.created_at)}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </PageBody>
    </>
  );
}

/** « À traiter » : une ligne par sujet (verbe + nombre), toute la ligne mène à la page où le traiter. */
function TodoCard({ items }: { items: AdminTodoItem[] }) {
  return (
    <Card id="a-traiter" data-tour="sa-todo" className="scroll-mt-6 overflow-hidden">
      <CardHeader title="À traiter" />
      {items.length === 0 ? (
        <EmptyState size="compact" icon={<CircleCheck />} title="Rien à traiter, tout est à jour." />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => (
            <li key={item.key}>
              <Link href={item.href} prefetch={false} className="flex min-h-12 items-center gap-3 px-5 py-2.5 transition-colors hover:bg-white/[0.03]">
                <span aria-hidden className={cn("size-2 shrink-0 rounded-full", toneDot[item.tone])} />
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-[14px] font-medium", item.unreadable ? "text-fg-muted" : "text-fg")}>{item.label}</span>
                  {item.detail && <span className="mt-0.5 block text-[12.5px] text-fg-muted">{item.detail}</span>}
                </span>
                <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-subtle" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Lien de la ligne « Santé » : rouge ou ambre seulement au-dessus de zéro. Téléphone : tuile (nombre en grand, puis ce
 * qu'il compte) ; grand écran : lien compact « 6 courses sans chauffeur (24 h) ». Nom accessible : la phrase entière.
 */
function HealthLink({ href, n, tone, one, many, period }: { href: string; n: number; tone: "red" | "amber"; one: string; many: string; period: string }) {
  // Même accord que partout (plural : 0 et 1 au singulier) ; le nombre est mis en avant à part sur téléphone
  const count = formatNumber(n);
  const noun = plural(n, one, many).slice(count.length + 1);
  const label = `${count} ${noun} (${period})`;
  return (
    <Link
      href={href}
      prefetch={false}
      aria-label={label}
      className={cn(
        "grid min-h-11 grid-cols-[auto_1fr] content-start items-center gap-x-2 gap-y-1 rounded-xl border px-3 py-2.5 text-[12px] leading-snug transition-colors",
        "sm:inline-flex sm:min-h-9 sm:gap-1 sm:rounded-full sm:px-3.5 sm:py-0 sm:text-[13px]",
        n > 0 ? (tone === "red" ? "border-red/30 text-fg hover:bg-red/[0.06]" : "border-amber/30 text-fg hover:bg-amber/[0.06]") : "border-line text-fg-muted hover:text-fg",
      )}
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full sm:mr-1", n > 0 ? toneDot[tone] : "bg-fg-subtle")} />
      <span className="num text-[16px] font-semibold leading-none sm:text-[13px] sm:font-normal sm:leading-normal">{count}</span>
      <span className="col-span-2 sm:col-span-1">
        {noun} ({period})
      </span>
    </Link>
  );
}
