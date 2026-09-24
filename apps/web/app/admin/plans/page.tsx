import { formatPrice } from "@rydar/shared";
import { Check, X } from "lucide-react";
import type { Metadata } from "next";
import { PlanEditor } from "@/components/admin/admin-widgets";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { requireSuperAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Offres" };
export const dynamic = "force-dynamic";

const ROWS: [string, string][] = [
  ["max_drivers", "Chauffeurs"], ["max_rides_per_month", "Courses / mois"], ["max_admins", "Administrateurs"],
  ["api_access", "API de réservation"], ["booking_site", "Mini-site"], ["custom_domain", "Domaine personnalisé"],
  ["advanced_stats", "Statistiques avancées"], ["history_days", "Historique (jours)"],
];

export default async function PlansPage() {
  const session = await requireSuperAdmin();
  const [{ data: plans }, { data: counts }] = await Promise.all([
    session.supabase.from("plans").select("*").order("sort_order"),
    session.supabase.from("organizations").select("plan_id").neq("status", "archived"),
  ]);
  const usage = new Map<string, number>();
  for (const c of counts ?? []) usage.set(c.plan_id, (usage.get(c.plan_id) ?? 0) + 1);
  return (
    <>
      <PageHeader eyebrow="Plateforme" title="Offres & limites" description="Les limites sont appliquées en base (triggers) : impossible de les contourner côté client." actions={<PlanEditor plan={null} />} />
      <PageBody>
        <div className="grid gap-4 lg:grid-cols-3">
          {(plans ?? []).map((p: any) => (
            <div key={p.id} className={`surface rounded-2xl p-6 ${p.highlighted ? "border-brand/40" : ""}`}>
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[16px] font-semibold">{p.name} <span className="num text-[12px] text-fg-subtle">{p.code}</span></p>
                  <p className="mt-1 text-[12.5px] text-fg-muted">{p.description}</p>
                </div>
                <PlanEditor plan={p} />
              </div>
              <p className="mt-4 text-[28px] font-semibold tracking-tight">{formatPrice(p.price_monthly_cents)}<span className="text-[13px] font-normal text-fg-subtle"> / mois</span></p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge tone={p.is_active ? "green" : "neutral"}>{p.is_active ? "Active" : "Inactive"}</Badge>
                {p.is_public && <Badge tone="blue">Publique</Badge>}
                <Badge tone="neutral" dot={false}>{usage.get(p.id) ?? 0} rattacheurs</Badge>
              </div>
              <ul className="mt-5 space-y-2 border-t border-line pt-4">
                {ROWS.map(([k, label]) => {
                  const v = p.limits?.[k];
                  return (
                    <li key={k} className="flex items-center justify-between text-[13px]">
                      <span className="text-fg-muted">{label}</span>
                      {typeof v === "boolean" ? (v ? <Check className="size-4 text-brand" /> : <X className="size-4 text-fg-subtle" />) : <span className="num">{v ?? "∞"}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </PageBody>
    </>
  );
}
