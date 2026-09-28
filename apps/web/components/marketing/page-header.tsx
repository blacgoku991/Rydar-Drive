import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import styles from "./landing.module.css";

const delay = (ms: number) => ({ "--delay": `${ms}ms` }) as CSSProperties;

/** En-tête d'une page du site vitrine (hors accueil) : surtitre, titre principal (h1), introduction, contenu libre. */
export function PageHeader({
  id,
  eyebrow,
  title,
  intro,
  children,
  className,
}: {
  id: string;
  eyebrow: string;
  title: ReactNode;
  intro?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn("relative z-10", className)}>
      <div className="mx-auto max-w-6xl px-4 pb-10 pt-12 sm:px-6 sm:pb-14 sm:pt-20 lg:pt-24">
        <p
          className={cn(
            "inline-flex items-center gap-2 rounded-full border border-line-strong bg-white/[0.03] px-3 py-1 text-[12.5px] text-fg-muted",
            styles.enter,
          )}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-brand shadow-[0_0_8px_var(--color-brand)]" />
          {eyebrow}
        </p>
        <h1
          id={id}
          className={cn(
            "mt-6 max-w-4xl text-balance text-[34px] font-semibold leading-[1.06] tracking-[-0.035em] min-[400px]:text-[38px] sm:text-[52px] lg:text-[58px]",
            styles.enter,
          )}
          style={delay(80)}
        >
          <span className="text-gradient">{title}</span>
        </h1>
        {intro && (
          <p className={cn("mt-6 max-w-2xl text-pretty text-[16px] leading-relaxed text-fg-muted sm:text-[17px]", styles.enter)} style={delay(160)}>
            {intro}
          </p>
        )}
        {children && (
          <div className={cn("mt-9", styles.enter)} style={delay(240)}>
            {children}
          </div>
        )}
      </div>
    </section>
  );
}
