import { formatNumber, formatPrice } from "@rydar/shared";
import { Check, CreditCard, X } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PlanEditor } from "@/components/admin/admin-widgets";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/ui/misc";
import { requireSuperAdmin } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/wording";

export const metadata: Metadata = { title: "Offres & limites" };
export const dynamic = "force-dynamic";

/** Lignes des cartes : limites (nombre, vide = illimité) puis options, aux mêmes libellés que la fenêtre de l'offre. */
const ROWS: { key: string; label: string; days?: boolean }[] = [
  { key: "max_drivers", label: "Chauffeurs" },
  { key: "max_rides_per_month", label: "Courses par mois" },
  { key: "max_admins", label: "Administrateurs" },
  { key: "api_access", label: "API de réservation" },
  { key: "booking_site", label: "Mini-site" },
  { key: "custom_domain", label: "Domaine personnalisé" },
  { key: "advanced_stats", label: "Statistiques avancées" },
  { key: "history_days", label: "Historique", days: true },
];
/** Lignes servies seulement quand les mini-sites sont activés par la plateforme. */
const SITE_ROWS = new Set(["booking_site", "custom_domain"]);

/**
 * Offres & limites (docs/REFONTE-PANELS.md, R5) : ce que comprend chaque abonnement. Cartes sans le code technique (il est
 * dans la fenêtre de l'offre), nombre de clients par offre ; mêmes lectures, création et modification par PlanEditor.
 */
export default async function PlansPage() {
  const session = await requireSuperAdmin();
  const [{ data: plans, error }, { data: counts, error: countError }, { data: platform }] = await Promise.all([
    session.supabase.from("plans").select("*").order("sort_order"),
    session.supabase.from("organizations").select("plan_id").neq("status", "archived"),
    // Interrupteur plateforme des mini-sites (lecture RLS du super admin ; il se règle dans « Réglages de la
    // plateforme ») : mention « coupé » des options qu'il retire ; absent = coupé, comme la base
    session.supabase.from("platform_settings").select("booking_sites_enabled").maybeSingle(),
  ]);
  if (error) console.error("[admin] offres", error.message);
  if (countError) console.error("[admin] offres : clients par offre", countError.message);
  const sitesOff = (platform as { booking_sites_enabled: boolean } | null)?.booking_sites_enabled !== true;
  const usage = new Map<string, number>();
  for (const c of counts ?? []) usage.set(c.plan_id, (usage.get(c.plan_id) ?? 0) + 1);
  const list = (plans ?? []) as any[];
  return (
    <>
      <PageHeader title="Offres & limites" description="Ce que comprend chaque abonnement." actions={<PlanEditor plan={null} />} />
      <PageBody className="space-y-6">
        {/* Explique la mention « coupé » des cartes ; l'interrupteur est dans Réglages de la plateforme */}
        {sitesOff && (
          <Callout
            tone="info"
            title="Mini-sites coupés pour toute la plateforme"
            action={
              <Link href="/admin/reglages" prefetch={false} className="inline-flex min-h-11 items-center text-[13px] font-medium text-brand hover:underline sm:min-h-0">
                Réglages de la plateforme
              </Link>
            }
          >
            Les options «&nbsp;Mini-site&nbsp;» et «&nbsp;Domaine personnalisé&nbsp;» des offres ne sont servies nulle part tant qu&apos;ils
            sont coupés.
          </Callout>
        )}
        {error ? (
          <Callout tone="danger" title="Lecture impossible, réessayez dans un instant." />
        ) : !list.length ? (
          <EmptyState
            icon={<CreditCard />}
            title="Aucune offre"
            description="Sans offre, un client n'a aucune limite. Créez une offre pour proposer un abonnement."
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-3">
            {list.map((p) => {
              const clients = usage.get(p.id) ?? 0;
              return (
                <section
                  key={p.id}
                  aria-labelledby={`offre-${p.id}`}
                  className={cn("surface rounded-2xl p-5 sm:p-6", p.highlighted && "ring-1 ring-inset ring-brand/40")}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 id={`offre-${p.id}`} className="text-[16px] font-semibold text-fg">
                        {p.name}
                      </h2>
                      {p.description && <p className="mt-1 text-[13px] text-fg-muted">{p.description}</p>}
                    </div>
                    <PlanEditor plan={p} />
                  </div>
                  <p className="mt-4">
                    <span className="num text-[28px] font-semibold tracking-tight">{formatPrice(p.price_monthly_cents)}</span>
                    <span className="text-[13px] text-fg-muted"> HT / mois</span>
                  </p>
                  {p.price_yearly_cents > 0 && <p className="text-[13px] text-fg-muted">{formatPrice(p.price_yearly_cents)} HT / an</p>}
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Badge tone={p.is_active ? "green" : "neutral"}>{p.is_active ? "Active" : "Inactive"}</Badge>
                    {p.is_public && <Badge tone="blue">Publique</Badge>}
                    {p.highlighted && (
                      <Badge tone="brand" dot={false}>
                        Mise en avant
                      </Badge>
                    )}
                    {!countError && (
                      <Badge tone="neutral" dot={false}>
                        {plural(clients, "client")}
                      </Badge>
                    )}
                  </div>
                  <ul className="mt-5 space-y-2 border-t border-line pt-4">
                    {ROWS.map(({ key, label, days }) => {
                      const v = p.limits?.[key];
                      return (
                        <li key={key} className="flex items-center justify-between gap-3 text-[13px]">
                          <span className="text-fg-muted">
                            {label}
                            {/* Interrupteur plateforme coupé : inclus dans l'offre mais servi nulle part */}
                            {sitesOff && SITE_ROWS.has(key) && <span className="text-amber"> · coupé</span>}
                          </span>
                          {typeof v === "boolean" ? (
                            v ? (
                              <span className="inline-flex items-center text-brand">
                                <Check aria-hidden className="size-4" />
                                <span className="sr-only">Inclus</span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center text-fg-subtle">
                                <X aria-hidden className="size-4" />
                                <span className="sr-only">Non inclus</span>
                              </span>
                            )
                          ) : typeof v === "number" ? (
                            <span className="num text-fg">{days ? plural(v, "jour") : formatNumber(v)}</span>
                          ) : (
                            <span className="text-fg">Illimité</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </PageBody>
    </>
  );
}
