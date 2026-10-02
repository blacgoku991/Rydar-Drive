// Fiche rattacheur (super admin) : résumé des frais plateforme dus à Rydar, lien vers le compte détaillé.
import { formatPrice, platformDueSummary, type PlatformAccount } from "@rydar/shared";
import { ArrowRight, CircleDollarSign } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ago, overdueInfo } from "./admin-platform-format";

export function OrgPlatformFeesCard({ orgId, account: a, timeZone = "Europe/Paris" }: { orgId: string; account: PlatformAccount; timeZone?: string }) {
  const late = overdueInfo(a, timeZone);
  const summary = platformDueSummary(a, timeZone);
  const cells = [
    {
      label: "Solde",
      value: formatPrice(a.balance_cents, a.currency),
      cls: a.balance_cents > 0 ? "text-amber" : a.balance_cents < 0 ? "text-green" : "text-fg",
    },
    {
      label: "Échu",
      value: formatPrice(a.due_cents, a.currency),
      cls: late ? "text-red" : a.due_cents > 0 ? "text-amber" : "text-fg",
      sub: late ? late.text : null,
    },
    { label: "À confirmer", value: formatPrice(a.declared_cents, a.currency), cls: a.declared_count ? "text-blue" : "text-fg" },
    {
      label: "Frais du mois",
      value: formatPrice(a.month.fees_cents, a.currency),
      cls: "text-violet",
      sub: `${a.month.rides} course${a.month.rides > 1 ? "s" : ""}`,
    },
  ];
  return (
    <Card>
      <CardHeader
        title="Frais plateforme"
        icon={<CircleDollarSign />}
        description={
          <>
            Dus à Rydar par {a.dispatch_model === "fleet" ? "cette flotte" : "cette centrale"} · réf.{" "}
            <span className="mono whitespace-nowrap text-fg-muted">{a.reference}</span>
          </>
        }
        action={
          <Button asChild variant="outline" size="sm" className="max-sm:hidden">
            <Link href={`/admin/frais/${orgId}`}>
              Ouvrir le compte <ArrowRight />
            </Link>
          </Button>
        }
      />
      <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
        {cells.map((c) => (
          <div key={c.label} className="bg-ink-800 px-5 py-3.5">
            <p className="text-[12px] text-fg-subtle">{c.label}</p>
            <p className={cn("num mt-1 text-[18px] font-semibold tracking-tight", c.cls)}>{c.value}</p>
            {c.sub && <p className={cn("text-[11.5px]", late && c.label === "Échu" ? "text-red" : "text-fg-subtle")}>{c.sub}</p>}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line px-5 py-3 text-[12.5px] text-fg-muted">
        <Badge tone={summary.tone}>{summary.text}</Badge>
        {a.held_by_centrale_cents > 0 && (
          <span>
            <span className="mono text-amber">{formatPrice(a.held_by_centrale_cents, a.currency)}</span> encaissés et pas reversés
          </span>
        )}
        {a.pending_reductions_count > 0 && (
          <span className="text-amber">
            {a.pending_reductions_count} baisse{a.pending_reductions_count > 1 ? "s" : ""} à valider
          </span>
        )}
        <span className={a.blocked ? "text-red" : a.block_suspended ? "text-amber" : undefined}>
          {a.blocked
            ? "Création de courses bloquée"
            : a.block_suspended
              ? "Blocage suspendu (paiement déclaré à confirmer)"
              : a.block_after_days
                ? `Blocage après ${a.block_after_days} j de retard`
                : "Blocage désactivé"}
        </span>
        <span className="text-fg-subtle">{a.last_payment_at ? `Dernier paiement ${ago(a.last_payment_at)}` : "Aucun paiement reçu"}</span>
        <Button asChild variant="outline" size="sm" className="w-full sm:hidden">
          <Link href={`/admin/frais/${orgId}`}>
            Ouvrir le compte <ArrowRight />
          </Link>
        </Button>
      </div>
    </Card>
  );
}
