import type { Tone } from "@rydar/shared";
import * as React from "react";
import { cn } from "@/lib/utils";

export const toneText: Record<Tone, string> = {
  neutral: "text-fg-muted",
  brand: "text-brand",
  amber: "text-amber",
  blue: "text-blue",
  violet: "text-violet",
  cyan: "text-cyan",
  green: "text-green",
  red: "text-red",
};
export const toneBg: Record<Tone, string> = {
  neutral: "bg-white/[0.06] border-white/10",
  brand: "bg-brand/10 border-brand/25",
  amber: "bg-amber/10 border-amber/25",
  blue: "bg-blue/10 border-blue/25",
  violet: "bg-violet/10 border-violet/25",
  cyan: "bg-cyan/10 border-cyan/25",
  green: "bg-green/10 border-green/25",
  red: "bg-red/10 border-red/25",
};
export const toneDot: Record<Tone, string> = {
  neutral: "bg-fg-subtle",
  brand: "bg-brand shadow-[0_0_8px_var(--color-brand)]",
  amber: "bg-amber shadow-[0_0_8px_var(--color-amber)]",
  blue: "bg-blue shadow-[0_0_8px_var(--color-blue)]",
  violet: "bg-violet shadow-[0_0_8px_var(--color-violet)]",
  cyan: "bg-cyan shadow-[0_0_8px_var(--color-cyan)]",
  green: "bg-green shadow-[0_0_8px_var(--color-green)]",
  red: "bg-red shadow-[0_0_8px_var(--color-red)]",
};
export const toneHex: Record<Tone, string> = {
  neutral: "#5f6777",
  brand: "#c8f03c",
  amber: "#ffb020",
  blue: "#4c9dff",
  violet: "#a78bfa",
  cyan: "#22d3ee",
  green: "#3ddc97",
  red: "#ff4d5e",
};

export function Badge({
  tone = "neutral",
  dot = true,
  pulse,
  className,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[11.5px] font-medium",
        toneBg[tone],
        toneText[tone],
        className,
      )}
    >
      {dot && <span className={cn("size-1.5 rounded-full", toneDot[tone], pulse && "animate-breathe")} />}
      {children}
    </span>
  );
}
