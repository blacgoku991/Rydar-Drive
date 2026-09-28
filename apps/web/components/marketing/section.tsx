import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import styles from "./landing.module.css";

/** Section du site vitrine : ancre sous l'en-tête collant, largeur commune, marges verticales. */
export function Section({
  id,
  labelledBy,
  className,
  inner,
  children,
}: {
  id?: string;
  labelledBy?: string;
  className?: string;
  inner?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cn("relative z-10 scroll-mt-16", className)}>
      <div className={cn("mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28", inner)}>{children}</div>
    </section>
  );
}

/** Titre de section (h2) : surtitre lime, titre, introduction. */
export function SectionHeading({
  id,
  eyebrow,
  title,
  intro,
  center,
}: {
  id: string;
  eyebrow: ReactNode;
  title: ReactNode;
  intro?: ReactNode;
  center?: boolean;
}) {
  return (
    <div className={cn("max-w-2xl", center && "mx-auto text-center", styles.reveal)}>
      <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-brand">{eyebrow}</p>
      <h2 id={id} className="mt-3 text-balance text-[30px] font-semibold leading-[1.1] tracking-[-0.025em] sm:text-[40px]">
        {title}
      </h2>
      {intro && <p className="mt-4 text-pretty text-[16px] leading-relaxed text-fg-muted">{intro}</p>}
    </div>
  );
}
