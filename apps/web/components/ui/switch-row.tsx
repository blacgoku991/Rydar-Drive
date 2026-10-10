"use client";
import * as React from "react";
import { Switch } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

/**
 * Interrupteur avec son titre et une aide qui dit ce que fait l'état COURANT (`hintOn` / `hintOff`, sinon `hint`) :
 * « Lien actif : les chauffeurs peuvent postuler » / « Lien coupé : personne ne peut postuler ». Toute la ligne est
 * cliquable (libellé) ; nom accessible de l'interrupteur = le titre, aide reliée en description.
 */
export function SwitchRow({
  title,
  hint,
  hintOn,
  hintOff,
  checked,
  onCheckedChange,
  disabled,
  name,
  className,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  hintOn?: React.ReactNode;
  hintOff?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Champ envoyé avec un formulaire (« on » quand allumé) */
  name?: string;
  className?: string;
}) {
  const id = React.useId();
  const help = (checked ? hintOn : hintOff) ?? hint;
  return (
    <label
      className={cn(
        "flex items-center justify-between gap-4 rounded-xl border border-line bg-white/[0.02] px-4 py-3",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
        className,
      )}
    >
      <span className="min-w-0">
        <span id={`${id}-title`} className="block text-[13.5px] font-medium text-fg">
          {title}
        </span>
        {help && (
          <span id={`${id}-hint`} className="mt-0.5 block text-[12.5px] text-fg-muted">
            {help}
          </span>
        )}
      </span>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        name={name}
        aria-labelledby={`${id}-title`}
        aria-describedby={help ? `${id}-hint` : undefined}
      />
    </label>
  );
}
