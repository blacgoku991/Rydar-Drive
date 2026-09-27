import { ArrowRight, Mail } from "lucide-react";
import Link from "next/link";
import { RadarMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CONTACT_EMAIL, DEMO_HREF } from "./contact";
import styles from "./landing.module.css";
import { fr } from "./typo";

export function FinalCta() {
  return (
    <section aria-labelledby="cta-titre" className="relative z-10 px-4 pb-24 sm:px-6">
      <div
        className={cn(
          "relative mx-auto max-w-6xl overflow-hidden rounded-[28px] border border-line-strong bg-ink-850 px-6 py-16 text-center sm:px-12 sm:py-20",
          styles.reveal,
        )}
      >
        {/* Anneaux radar en fond */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="grid-bg absolute inset-0 opacity-70 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]" />
          {[30, 52, 74, 96].map((s) => (
            <span
              key={s}
              className="absolute left-1/2 top-full -translate-x-1/2 -translate-y-1/2 rounded-full border border-brand/[0.12]"
              style={{ width: `${s * 12}px`, height: `${s * 12}px` }}
            />
          ))}
          <div className="absolute left-1/2 top-full size-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/[0.1] blur-[110px]" />
        </div>
        <div className="relative">
          <RadarMark size={40} animated className="mx-auto" />
          <h2 id="cta-titre" className="mx-auto mt-6 max-w-2xl text-balance text-[32px] font-semibold leading-[1.08] tracking-[-0.03em] sm:text-[48px]">
            <span className="text-gradient">Passez au dispatch automatique.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-pretty text-[16px] leading-relaxed text-fg-muted">
            {fr("Montrez-nous comment vous travaillez aujourd'hui : nous vous montrons la même journée sur Rydar Drive.")}
          </p>
          <div className="mt-9 flex flex-col justify-center gap-3 min-[400px]:flex-row">
            <Button asChild variant="primary" size="lg">
              <a href={DEMO_HREF}>
                Demander une démo <ArrowRight aria-hidden />
              </a>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/login">Se connecter</Link>
            </Button>
          </div>
          <p className="mt-6 inline-flex items-center gap-2 text-[13.5px] text-fg-muted">
            <Mail className="size-4" aria-hidden />
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline decoration-white/20 underline-offset-4 transition-colors hover:text-fg">
              {CONTACT_EMAIL}
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
