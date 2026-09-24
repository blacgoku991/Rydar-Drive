"use client";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function CodeBlock({ code, language, className }: { code: string; language?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("group relative overflow-hidden rounded-xl border border-line bg-ink-950", className)}>
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span className="num text-[11px] uppercase tracking-[0.12em] text-fg-subtle">{language}</span>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="flex items-center gap-1.5 text-[11.5px] text-fg-subtle hover:text-fg"
        >
          {copied ? <Check className="size-3.5 text-brand" /> : <Copy className="size-3.5" />} {copied ? "Copié" : "Copier"}
        </button>
      </div>
      <pre className="num overflow-x-auto p-4 text-[12.5px] leading-relaxed text-fg-muted">
        <code>{code}</code>
      </pre>
    </div>
  );
}
