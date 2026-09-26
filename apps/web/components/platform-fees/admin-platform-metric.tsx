// Tuile de chiffre des frais plateforme (même rendu que StatCard, avec toutes les couleurs de statut et un lien).
import type { Tone } from "@rydar/shared";
import Link from "next/link";
import type * as React from "react";
import { toneText } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function Metric({
  label,
  value,
  sub,
  tone,
  icon,
  href,
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Tone;
  icon?: React.ReactNode;
  href?: string;
  className?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12.5px] leading-snug text-fg-subtle">{label}</span>
        {icon && <span className="shrink-0 text-fg-subtle max-sm:hidden [&_svg]:size-4">{icon}</span>}
      </div>
      <div className={cn("num mt-1.5 truncate text-[24px] font-semibold leading-none tracking-tight", tone ? toneText[tone] : "text-fg")}>{value}</div>
      {sub && <div className="mt-1.5 text-[12px] leading-snug text-fg-subtle">{sub}</div>}
    </>
  );
  const base = "surface relative block min-w-0 overflow-hidden rounded-xl px-4 py-3.5";
  if (href) {
    return (
      <Link href={href} className={cn(base, "transition-colors hover:border-line-strong hover:bg-ink-700/60", className)}>
        {body}
      </Link>
    );
  }
  return <div className={cn(base, className)}>{body}</div>;
}

/** Petite ligne « libellé … valeur » (cartes de synthèse). */
export function MoneyLine({
  label,
  value,
  tone,
  hint,
  strong,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  tone?: Tone;
  hint?: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="min-w-0 text-[13px] text-fg-muted">
        {label}
        {hint && <span className="block text-[11.5px] text-fg-subtle">{hint}</span>}
      </span>
      <span className={cn("mono shrink-0 text-[13.5px]", strong && "text-[15px] font-semibold", tone ? toneText[tone] : "text-fg")}>{value}</span>
    </div>
  );
}
