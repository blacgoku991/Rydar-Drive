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
  neutral: "bg-white/[0.05]",
  brand: "bg-brand/[0.09]",
  amber: "bg-amber/[0.1]",
  blue: "bg-blue/[0.1]",
  violet: "bg-violet/[0.1]",
  cyan: "bg-cyan/[0.1]",
  green: "bg-green/[0.1]",
  red: "bg-red/[0.1]",
};
export const toneDot: Record<Tone, string> = {
  neutral: "bg-fg-subtle",
  brand: "bg-brand",
  amber: "bg-amber",
  blue: "bg-blue",
  violet: "bg-violet",
  cyan: "bg-cyan",
  green: "bg-green",
  red: "bg-red",
};
export const toneHex: Record<Tone, string> = {
  neutral: "#666d79",
  brand: "#c8f03c",
  amber: "#f5b544",
  blue: "#6aa6ff",
  violet: "#b39dfa",
  cyan: "#45d6e6",
  green: "#4fd58f",
  red: "#f2555a",
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
        "inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[11.5px] font-medium",
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
