// Fiche d'un client (super admin) : résumé des frais Rydar (« frais plateforme » des CGV) dus à Rydar, lien vers le
// compte détaillé. Couleur réservée à ce qui demande une action (retard en rouge, échu ou à confirmer en ambre). Mêmes
// mots que le compte et les commissions des centrales : « En retard » (dont la part déclarée, à confirmer), « Prochaine
// échéance » (la part qui tombe à cette date, comme le client la lit, puis le cumul avec le retard).
import { formatPrice, platformDueSummary, type PlatformAccount } from "@rydar/shared";
import { ArrowRight, CircleDollarSign } from "lucide-react";
import Link from "next/link";
import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/wording";
import { ago, lateDeclaredNote, nextDueInfo, overdueInfo } from "./admin-platform-format";

export function OrgPlatformFeesCard({ orgId, account: a, timeZone = "Europe/Paris" }: { orgId: string; account: PlatformAccount; timeZone?: string }) {
  const late = overdueInfo(a, timeZone);
  const summary = platformDueSummary(a, timeZone);
  const lateNote = lateDeclaredNote(a, a.currency);
  // En retard : la prochaine échéance n'est pas dans le badge (qui dit le retard) ; sans retard, le badge la donne déjà
  const next = late ? nextDueInfo(a, timeZone, a.currency) : null;
  const cells: { label: string; value: string; cls: string; sub: React.ReactNode }[] = [
    {
      label: "Solde",
      value: formatPrice(a.balance_cents, a.currency),
      cls: "text-fg",
      sub: a.balance_cents < 0 ? "avance du client" : null,
    },
    {
      label: "En retard",
      value: formatPrice(a.due_cents, a.currency),
      cls: late ? "text-red" : a.due_cents > 0 ? "text-amber" : "text-fg",
      sub:
        late || lateNote ? (
          <>
            {late && <span className="block text-red">{late.text}</span>}
            {lateNote && <span className="block text-amber">{lateNote}</span>}
          </>
        ) : null,
    },
    {
      label: "À confirmer",
      value: formatPrice(a.declared_cents, a.currency),
      cls: a.declared_count ? "text-amber" : "text-fg",
      sub: a.declared_count ? plural(a.declared_count, "paiement déclaré", "paiements déclarés") : null,
    },
    {
      label: "Frais du mois",
      value: formatPrice(a.month.fees_cents, a.currency),
      cls: "text-fg",
      sub: plural(a.month.rides, "course"),
    },
  ];
  return (
    <Card>
      <CardHeader
        title="Frais Rydar"
        icon={<CircleDollarSign />}
        description={
          <>
            Dus à Rydar par {a.dispatch_model === "fleet" ? "cette flotte" : "cette centrale"} · réf.{" "}
            <span className="mono whitespace-nowrap text-fg-muted">{a.reference}</span>
          </>
        }
        action={
          <Button asChild variant="outline" size="sm" className="max-sm:hidden">
            <Link href={`/admin/frais/${orgId}`} prefetch={false}>
              Ouvrir le compte <ArrowRight />
            </Link>
          </Button>
        }
      />
      {/* Quatre cases côte à côte quand la carte a la largeur de la page ; deux par ligne dans la colonne de la fiche */}
      <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4 xl:grid-cols-2">
        {cells.map((c) => (
          <div key={c.label} className="bg-ink-800 px-5 py-3.5">
            <p className="text-[12px] text-fg-subtle">{c.label}</p>
            <p className={cn("num mt-1 text-[18px] font-semibold tracking-tight", c.cls)}>{c.value}</p>
            {c.sub && <div className="mt-0.5 text-[12px] text-fg-muted">{c.sub}</div>}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line px-5 py-3 text-[12.5px] text-fg-muted">
        <Badge tone={summary.tone}>{summary.text}</Badge>
        {next && <span>{next.text}</span>}
        {a.held_by_centrale_cents > 0 && (
          <span>
            <span className="mono text-amber">{formatPrice(a.held_by_centrale_cents, a.currency)}</span> encaissés, pas encore réglés à Rydar
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
                ? `Courses bloquées après ${a.block_after_days} j de retard`
                : "Blocage des courses désactivé"}
        </span>
        <span className="text-fg-muted">{a.last_payment_at ? `Dernier paiement ${ago(a.last_payment_at)}` : "Aucun paiement reçu"}</span>
        <Button asChild variant="outline" size="sm" className="w-full max-sm:h-11 sm:hidden">
          <Link href={`/admin/frais/${orgId}`} prefetch={false}>
            Ouvrir le compte <ArrowRight />
          </Link>
        </Button>
      </div>
    </Card>
  );
}
