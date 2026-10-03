import * as React from "react";
import { cn } from "@/lib/utils";

export const fieldBase =
  "w-full rounded-lg border border-line bg-ink-800 px-3 text-sm text-fg placeholder:text-fg-subtle outline-none transition-colors hover:border-line-strong focus:border-brand/50 focus:ring-4 focus:ring-brand/10 disabled:opacity-50 aria-[invalid=true]:border-red/60 aria-[invalid=true]:ring-red/10";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(fieldBase, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldBase, "min-h-[84px] py-2.5 leading-relaxed", className)} {...props} />;
}

export function NativeSelect({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select className={cn(fieldBase, "h-10 appearance-none pr-9", className)} {...props}>
        {children}
      </select>
      <svg className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-[12.5px] font-medium text-fg-muted", className)} {...props} />;
}

// ---------------------------------------------------------------------------------------------------------------
// Champ accessible : Field relie lui-même son libellé (label for → id du contrôle), son aide ou son erreur
// (aria-describedby) et l'état d'erreur (aria-invalid) au contrôle qu'il contient (WCAG 1.3.1, 3.3.1, 3.3.2, 4.1.2 ;
// RGAA 11.1, 11.2, 11.10). Contrôle reconnu : élément natif input / select / textarea, Input, Textarea, NativeSelect
// ou composant déclaré par asFieldControl (qui doit transmettre id et aria-* à son champ), y compris à l'intérieur de
// conteneurs natifs (div) ; un id ou un aria-invalid déjà posés sont gardés. Rendu par un composant serveur, un
// composant client enfant n'est pas reconnu : passer htmlFor et poser l'id soi-même.

const CONTROL_TAGS = new Set(["input", "select", "textarea"]);
const FIELD_CONTROLS = new Set<unknown>([Input, Textarea, NativeSelect]);

/** Déclare un composant de saisie qui transmet id, aria-describedby et aria-invalid à son champ (UnitInput…). */
export function asFieldControl<T>(component: T): T {
  FIELD_CONTROLS.add(component);
  return component;
}

type Wiring = { id: string; describedBy?: string; invalid: boolean };

/** Relie le premier contrôle trouvé (jusqu'à 3 niveaux de conteneurs natifs) ; id du contrôle relié, ou null. */
function wireControl(node: React.ReactNode, w: Wiring, depth = 0): { node: React.ReactNode; id: string | null } {
  if (!React.isValidElement(node)) return { node, id: null };
  const el = node as React.ReactElement<Record<string, unknown>>;
  if ((typeof el.type === "string" && CONTROL_TAGS.has(el.type)) || FIELD_CONTROLS.has(el.type)) {
    const props = el.props;
    const id = typeof props.id === "string" && props.id ? props.id : w.id;
    const describedBy = [props["aria-describedby"], w.describedBy].filter(Boolean).join(" ");
    const extra: Record<string, unknown> = { id };
    if (describedBy) extra["aria-describedby"] = describedBy;
    if (w.invalid && props["aria-invalid"] === undefined) extra["aria-invalid"] = true;
    return { node: React.cloneElement(el, extra), id };
  }
  if (typeof el.type !== "string" || depth >= 3) return { node, id: null };
  const found = { id: null as string | null };
  const children = React.Children.map(el.props.children as React.ReactNode, (child) => {
    if (found.id) return child;
    const res = wireControl(child, w, depth + 1);
    found.id = res.id;
    return res.node;
  });
  return found.id ? { node: React.cloneElement(el, undefined, children), id: found.id } : { node, id: null };
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
  optional,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: string;
  /** Id du contrôle quand Field ne peut pas le relier lui-même (composant client rendu par un composant serveur) */
  htmlFor?: string;
  className?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  const autoId = React.useId();
  const descriptionId = `${autoId}-description`;
  const description = error || hint ? descriptionId : undefined;
  const wired = wireControl(children, { id: htmlFor || `${autoId}-control`, describedBy: description, invalid: !!error });
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <Label htmlFor={htmlFor || wired.id || undefined} className="flex items-center justify-between">
          <span>{label}</span>
          {optional && <span className="text-[11px] font-normal text-fg-subtle">optionnel</span>}
        </Label>
      )}
      {wired.node}
      {error ? (
        <p id={descriptionId} className="text-xs text-red">
          {error}
        </p>
      ) : hint ? (
        <p id={descriptionId} className="text-xs text-fg-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
