import { cn } from "@/lib/utils";

/** Emblème radar Rydar Drive (balayage lime + écho). */
export function RadarMark({ size = 28, animated = false, className }: { size?: number; animated?: boolean; className?: string }) {
  return (
    <span className={cn("relative inline-block shrink-0", className)} style={{ width: size, height: size }}>
      <svg viewBox="0 0 32 32" width={size} height={size} fill="none" aria-hidden>
        <defs>
          <radialGradient id="rd-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#c8f03c" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#c8f03c" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="16" cy="16" r="15" fill="url(#rd-core)" />
        <circle cx="16" cy="16" r="14.25" stroke="#c8f03c" strokeOpacity="0.9" strokeWidth="1.5" />
        <circle cx="16" cy="16" r="8.5" stroke="#c8f03c" strokeOpacity="0.35" strokeWidth="1.2" />
        <circle cx="16" cy="16" r="2.6" fill="#c8f03c" />
        <circle cx="23.4" cy="9.2" r="1.9" fill="#eaff9a" />
      </svg>
      <span
        className={cn("absolute inset-[2px] rounded-full", animated && "animate-radar")}
        style={{
          background: "conic-gradient(from 0deg, rgb(200 240 60 / 0.55), rgb(200 240 60 / 0) 70deg, transparent 360deg)",
          maskImage: "radial-gradient(circle, black 60%, transparent 62%)",
          WebkitMaskImage: "radial-gradient(circle, black 66%, transparent 68%)",
        }}
      />
    </span>
  );
}

export function Logo({ size = 28, className, subtitle }: { size?: number; className?: string; subtitle?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <RadarMark size={size} animated />
      <span className="flex flex-col leading-none">
        <span className="text-[15px] font-semibold tracking-tight text-fg">
          Rydar<span className="font-normal text-fg-muted"> Drive</span>
        </span>
        {subtitle && <span className="mt-1 text-[10.5px] font-medium uppercase tracking-[0.14em] text-fg-subtle">{subtitle}</span>}
      </span>
    </span>
  );
}
