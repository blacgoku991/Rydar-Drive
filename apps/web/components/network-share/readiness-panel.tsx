// En-tête de l'onglet « Réseau partagé » : état lisible de chaque sens (partage, réception) et, pour chaque condition
// manquante, son explication avec UNE action (spec §6.4). Composant serveur (aucun état) ; lecture seule pour un
// dispatcher (les actions sont réservées au propriétaire et aux administrateurs).
import { ArrowRight, CircleAlert, Info } from "lucide-react";
import Link from "next/link";
import type { OrgReadinessView, ReadinessSide, SideState } from "@/components/network-share/readiness";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DOT: Record<SideState, string> = { active: "bg-green", pending: "bg-amber", off: "bg-fg-subtle" };
const TEXT: Record<SideState, string> = { active: "text-green", pending: "text-amber", off: "text-fg-muted" };

export function ReadinessPanel({ view, canManage }: { view: OrgReadinessView; canManage: boolean }) {
  return (
    <div className="space-y-3 pb-5">
      <div className="grid gap-2 sm:grid-cols-2">
        {(["out", "in"] as ReadinessSide[]).map((k) => {
          const s = view.sides[k];
          return (
            <div key={k} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-white/[0.02] px-4 py-2.5">
              <p className="flex min-w-0 items-center gap-2 text-[13px]">
                <span className={cn("size-2 shrink-0 rounded-full", DOT[s.state])} aria-hidden />
                <span className="truncate text-fg-muted">{s.title}</span>
                <span className={cn("font-semibold", TEXT[s.state])}>{s.text}</span>
              </p>
              {canManage && s.action && (
                <Link href={s.action.href} prefetch={false} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-brand hover:underline">
                  {s.action.label} <ArrowRight className="size-3.5" />
                </Link>
              )}
            </div>
          );
        })}
      </div>
      {view.items.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Ce qu'il reste à faire">
          {view.items.map((item) => (
            <li key={item.code} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="flex min-w-[240px] flex-1 items-start gap-2.5">
                {item.blocking ? (
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber" aria-hidden />
                ) : (
                  <Info className="mt-0.5 size-4 shrink-0 text-blue" aria-hidden />
                )}
                <div className="min-w-0">
                  <p className="text-[13.5px] font-medium text-fg">{item.label}</p>
                  <p className="text-[12.5px] text-fg-muted">{item.hint}</p>
                </div>
              </div>
              {canManage && item.action && (
                <Button asChild variant={item.blocking ? "secondary" : "outline"} size="sm">
                  {item.action.href.startsWith("/dashboard") ? (
                    <Link href={item.action.href} prefetch={false}>{item.action.label}</Link>
                  ) : (
                    <a href={item.action.href} target="_blank" rel="noopener">{item.action.label}</a>
                  )}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!canManage && view.items.some((i) => i.action) && (
        <p className="text-[12px] text-fg-subtle">Ces réglages sont faits par le propriétaire ou un administrateur de l&apos;organisation.</p>
      )}
    </div>
  );
}
