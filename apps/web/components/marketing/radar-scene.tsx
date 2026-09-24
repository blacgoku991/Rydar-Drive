import { cn } from "@/lib/utils";

const BLIPS = [
  { x: 62, y: 34, c: "#c8f03c", d: "0s", label: "Mohamed · 1,8 km" },
  { x: 28, y: 58, c: "#c8f03c", d: "1.1s" },
  { x: 71, y: 67, c: "#ffb020", d: "0.5s" },
  { x: 40, y: 26, c: "#4c9dff", d: "1.7s" },
  { x: 82, y: 46, c: "#22d3ee", d: "2.3s" },
  { x: 22, y: 38, c: "#5f6777", d: "0.9s" },
  { x: 55, y: 80, c: "#c8f03c", d: "1.4s" },
];

/** Scène radar animée (CSS pur) : vagues de dispatch 3 → 12 km autour d'une prise en charge. */
export function RadarScene({ className, showLabels = true }: { className?: string; showLabels?: boolean }) {
  return (
    <div className={cn("relative aspect-square w-full max-w-[640px]", className)}>
      {/* anneaux */}
      {[100, 76, 52, 28].map((s, i) => (
        <div
          key={s}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border"
          style={{
            width: `${s}%`,
            height: `${s}%`,
            borderColor: `rgb(200 240 60 / ${0.05 + i * 0.05})`,
            background: i === 3 ? "radial-gradient(circle, rgb(200 240 60 / 0.07), transparent 70%)" : undefined,
          }}
        >
          {showLabels && (
            <span className="num absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-ink-900 px-1.5 text-[10px] text-fg-subtle">
              {["12 km", "8 km", "5 km", "3 km"][i]}
            </span>
          )}
        </div>
      ))}
      {/* croix */}
      <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-gradient-to-b from-transparent via-white/10 to-transparent" />
      <div className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
      {/* balayage */}
      <div
        className="absolute inset-0 animate-radar rounded-full"
        style={{
          background: "conic-gradient(from 0deg, rgb(200 240 60 / 0.28), rgb(200 240 60 / 0.06) 40deg, transparent 80deg)",
          maskImage: "radial-gradient(circle, black 69%, transparent 70.5%)",
          WebkitMaskImage: "radial-gradient(circle, black 69%, transparent 70.5%)",
        }}
      />
      {/* ondes depuis la prise en charge */}
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="absolute left-1/2 top-1/2 size-[56%] -translate-x-1/2 -translate-y-1/2 animate-ping-ring rounded-full border border-brand/50"
          style={{ animationDelay: `${i * 0.8}s` }}
        />
      ))}
      {/* chauffeurs */}
      {BLIPS.map((b, i) => (
        <div key={i} className="absolute" style={{ left: `${b.x}%`, top: `${b.y}%` }}>
          <span className="absolute -left-3 -top-3 size-6 animate-breathe rounded-full" style={{ background: `radial-gradient(circle, ${b.c}55, transparent 70%)`, animationDelay: b.d }} />
          <span className="absolute -left-[5px] -top-[5px] size-2.5 rounded-full border-2 bg-ink-900" style={{ borderColor: b.c, boxShadow: `0 0 12px ${b.c}` }} />
          {b.label && showLabels && (
            <span className="absolute left-3 top-2 whitespace-nowrap rounded-md border border-white/10 bg-ink-900/90 px-1.5 py-0.5 text-[10.5px] font-medium text-fg">
              {b.label}
            </span>
          )}
        </div>
      ))}
      {/* faisceau vers le chauffeur retenu */}
      <svg className="absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <line x1="50" y1="50" x2="62" y2="34" stroke="#c8f03c" strokeWidth="0.35" strokeDasharray="1.2 1.2" opacity="0.9" />
        <line x1="50" y1="50" x2="71" y2="67" stroke="#ffb020" strokeWidth="0.25" strokeDasharray="1 1.4" opacity="0.6" />
        <line x1="50" y1="50" x2="28" y2="58" stroke="#c8f03c" strokeWidth="0.25" strokeDasharray="1 1.4" opacity="0.5" />
      </svg>
      {/* prise en charge */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <span className="absolute -left-6 -top-6 size-12 rounded-full bg-brand/20 blur-md" />
        <span className="relative block size-4 rounded-full bg-brand shadow-[0_0_0_5px_rgb(200_240_60/0.18),0_0_30px_rgb(200_240_60/0.8)]" />
      </div>
    </div>
  );
}
