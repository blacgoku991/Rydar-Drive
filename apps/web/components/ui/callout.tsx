import { CircleCheck, Info, OctagonAlert, TriangleAlert } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

export type CalloutTone = "neutral" | "info" | "warning" | "danger" | "success";

const TONES: Record<CalloutTone, { box: string; icon: string; Icon: React.ComponentType<{ className?: string }> }> = {
  neutral: { box: "border-line bg-white/[0.02]", icon: "text-fg-subtle", Icon: Info },
  info: { box: "border-blue/25 bg-blue/[0.06]", icon: "text-blue", Icon: Info },
  warning: { box: "border-amber/30 bg-amber/[0.07]", icon: "text-amber", Icon: TriangleAlert },
  danger: { box: "border-red/30 bg-red/[0.07]", icon: "text-red", Icon: OctagonAlert },
  success: { box: "border-green/30 bg-green/[0.07]", icon: "text-green", Icon: CircleCheck },
};

/**
 * Encadré (docs/REFONTE-PANELS.md § 3.9) : un seul composant pour les informations, avertissements et blocages. Tons
 * neutre, info, attention, danger, succès ; texte lisible (fg / fg-muted : jamais la couleur du ton sur le texte) ;
 * rôle `status` par défaut, `alert` pour le ton danger (urgence), `null` pour un encadré purement informatif.
 */
export function Callout({
  tone = "neutral",
  title,
  children,
  icon,
  action,
  role,
  className,
  id,
}: {
  tone?: CalloutTone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  /** Icône à la place de celle du ton ; `false` : aucune */
  icon?: React.ReactNode | false;
  /** Action à droite (lien, bouton), sous le texte sur téléphone */
  action?: React.ReactNode;
  role?: "status" | "alert" | null;
  className?: string;
  id?: string;
}) {
  const t = TONES[tone];
  const effectiveRole = role === undefined ? (tone === "danger" ? "alert" : "status") : role;
  return (
    <div
      id={id}
      role={effectiveRole ?? undefined}
      className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border px-4 py-3 text-[13.5px] leading-relaxed", t.box, className)}
    >
      {icon !== false && (
        <span aria-hidden className={cn("mt-[3px] shrink-0 [&_svg]:size-4", t.icon)}>
          {icon ?? <t.Icon />}
        </span>
      )}
      <div className="min-w-0 flex-1 basis-[min(100%,14rem)]">
        {title && <p className="font-medium text-fg">{title}</p>}
        {children && <div className={cn("text-fg-muted", title ? "mt-0.5" : undefined)}>{children}</div>}
      </div>
      {action && <div className="max-w-full shrink-0 self-center">{action}</div>}
    </div>
  );
}
