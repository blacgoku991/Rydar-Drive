"use client";
import { Check, Copy } from "lucide-react";
import * as React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Copie dans le presse-papiers ; repli execCommand hors contexte sécurisé (http local, ancien navigateur). */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Bouton « Copier » (IBAN, référence, clé, lien) : « Copié » pendant 1,8 s, ou « Copie impossible » (sélectionner le
 * texte à la main) ; le résultat est annoncé aux lecteurs d'écran. `label` : texte visible au repos (« Copier »,
 * « Copier le lien ») ; `what` : objet copié pour le nom accessible quand le libellé seul est ambigu (« Copier l'IBAN »).
 */
export function CopyButton({
  value,
  label = "Copier",
  what,
  variant = "secondary",
  size = "sm",
  className,
  iconOnly = false,
}: {
  value: string;
  label?: string;
  what?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  /** Icône seule (dans une ligne serrée) : le nom accessible reste « Copier … » */
  iconOnly?: boolean;
}) {
  const [state, setState] = React.useState<"idle" | "done" | "failed">("idle");
  const timer = React.useRef<number | null>(null);
  React.useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  const name = what ? `Copier ${what}` : label;
  const text = state === "done" ? "Copié" : state === "failed" ? "Copie impossible" : label;
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={iconOnly ? "icon-sm" : size}
        className={cn(state === "failed" && "text-red", className)}
        aria-label={iconOnly || what ? name : undefined}
        title={iconOnly ? name : undefined}
        onClick={async () => {
          const ok = await copyToClipboard(value);
          setState(ok ? "done" : "failed");
          if (timer.current) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setState("idle"), 1800);
        }}
      >
        {state === "done" ? <Check aria-hidden className="text-green" /> : <Copy aria-hidden />}
        {!iconOnly && text}
      </Button>
      {/* Annonce du résultat (le libellé du bouton change, son nom accessible non) */}
      <span role="status" className="-m-px inline-block size-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]">
        {state === "done" ? "Copié dans le presse-papiers" : state === "failed" ? "Copie impossible\u00a0: sélectionnez le texte à la main" : ""}
      </span>
    </>
  );
}
