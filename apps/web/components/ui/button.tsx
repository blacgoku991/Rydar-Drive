import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-150 select-none disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:scale-[0.98]",
  {
    variants: {
      variant: {
        primary:
          "bg-brand text-brand-fg font-semibold shadow-[0_1px_0_rgb(255_255_255/0.3)_inset] hover:bg-brand-strong",
        secondary: "bg-ink-600 text-fg border border-line hover:bg-ink-500",
        outline: "border border-line-strong text-fg hover:bg-white/[0.04] hover:border-white/20",
        ghost: "text-fg-muted hover:text-fg hover:bg-white/[0.05]",
        danger: "bg-red/12 text-red border border-red/25 hover:bg-red/20",
        link: "text-brand underline-offset-4 hover:underline px-0 h-auto",
      },
      size: {
        xs: "h-7 px-2.5 text-xs rounded-md",
        sm: "h-8 px-3 text-[13px]",
        md: "h-9 px-4",
        lg: "h-11 px-5 text-[15px] rounded-xl",
        xl: "h-14 px-7 text-base rounded-2xl",
        icon: "size-9",
        "icon-sm": "size-8 rounded-md",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

/**
 * Pendant l'envoi (`loading`), le bouton reste focalisable : aria-disabled et aria-busy plutôt que l'attribut disabled
 * (un bouton désactivé perd le focus, qui tombait sur <body> : WCAG 2.4.3), clic et envoi par Entrée bloqués, nom
 * accessible gardé (libellé transparent, pas invisible) et « en cours » annoncé.
 */
export function Button({ className, variant, size, asChild, loading, children, disabled, onClick, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  const busy = !!loading && !asChild;
  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), busy && "cursor-wait", className)}
      {...props}
      disabled={busy ? undefined : disabled || loading}
      aria-disabled={busy || props["aria-disabled"] || undefined}
      aria-busy={busy || props["aria-busy"] || undefined}
      // Bouton d'envoi : empêcher le clic empêche aussi l'envoi implicite du formulaire par Entrée
      onClick={busy ? (e: React.MouseEvent<HTMLButtonElement>) => e.preventDefault() : onClick}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading && (
            <span aria-hidden className="absolute inset-0 grid place-items-center">
              <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
            </span>
          )}
          <span className={cn("inline-flex items-center gap-2", loading && "opacity-0")}>{children}</span>
          {loading && <span className="sr-only"> (en cours)</span>}
        </>
      )}
    </Comp>
  );
}
