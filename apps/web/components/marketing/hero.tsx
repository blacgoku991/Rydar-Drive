import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import type { CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PRICING_HREF } from "./contact";
import { HeroVisual } from "./hero-visual";
import styles from "./landing.module.css";
import { fr } from "./typo";

const delay = (ms: number) => ({ "--delay": `${ms}ms` }) as CSSProperties;

/** Garanties réelles : CGV (article 1 ; article 8 : export sur demande) et accord de traitement des données (article 7). */
const REASSURANCE = ["Vos courses restent les vôtres", "Hébergement dans l'UE", "Export CSV sur demande"];

/** Faits produit (aucune statistique inventée). */
const FACTS = [
  { value: "4 → 16 km", label: "Vagues de dispatch automatiques, rayon après rayon" },
  { value: "1 seul chauffeur", label: "par course : l'attribution est verrouillée en base" },
  { value: "iOS & Android", label: "App chauffeur avec offre sonore et guidage" },
  { value: "0 compte client", label: "Vos clients réservent sans inscription" },
];

const WAVES = ["4 km", "8 km", "12 km", "16 km"];

/** Carte « offre reçue » de l'app chauffeur, posée sur le globe. */
function OfferCard() {
  return (
    <div
      className={cn("glass absolute bottom-0 left-0 w-[240px] rounded-2xl p-3.5 sm:bottom-[3%] sm:w-[282px] sm:p-4 lg:-left-4", styles.enter)}
      style={delay(900)}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand">Nouvelle course</span>
        <span className="num text-[11px] text-fg-muted">#1928</span>
      </div>
      <p className="mt-2.5 text-[14px] font-medium">La Défense → Paris CDG</p>
      <div className="mt-2.5 flex items-end justify-between gap-3">
        <span className="text-[12px] text-fg-muted">{fr("À 1,8 km · 2 passagers")}</span>
        <span className="num text-[22px] font-semibold tracking-tight">{fr("65 €")}</span>
      </div>
      <div className="mt-3 grid h-10 place-items-center rounded-xl bg-brand text-[13px] font-bold tracking-wide text-brand-fg">ACCEPTER</div>
    </div>
  );
}

/** Carte « recherche en cours » : vague 2 sur 4. */
function SearchCard() {
  return (
    <div
      className={cn("glass absolute right-0 top-[4%] hidden w-[236px] rounded-2xl p-4 min-[480px]:block lg:-right-2", styles.enter)}
      style={delay(1100)}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-muted">Recherche</span>
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber">
          <span className="size-1.5 rounded-full bg-amber" /> Vague 2 sur 4
        </span>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-1">
        {WAVES.map((w, i) => (
          <span key={w} className={cn("h-1.5 rounded-full", i < 2 ? "bg-brand" : "bg-white/10")} />
        ))}
      </div>
      <div className="mt-1.5 grid grid-cols-4 gap-1">
        {WAVES.map((w, i) => (
          <span key={w} className={cn("num text-[10.5px]", i < 2 ? "text-fg" : "text-fg-muted")}>
            {fr(w)}
          </span>
        ))}
      </div>
      <p className="mt-3 text-[12px] text-fg-muted">Chauffeurs en ligne, libres et compatibles</p>
    </div>
  );
}

export function Hero() {
  return (
    <section aria-labelledby="hero-titre" className="relative z-10">
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-10 sm:px-6 sm:pt-14 lg:grid-cols-[1.02fr_1fr] lg:gap-4 lg:pb-24 lg:pt-16">
        <div className="relative z-10">
          <p
            className={cn(
              "inline-flex items-center gap-2 rounded-full border border-line-strong bg-white/[0.03] px-3 py-1 text-[12.5px] text-fg-muted",
              styles.enter,
            )}
          >
            <span className="size-1.5 rounded-full bg-brand shadow-[0_0_8px_rgb(200_240_60/0.9)]" />
            Logiciel de dispatch VTC · centrales et flottes
          </p>
          <h1
            id="hero-titre"
            className={cn("mt-6 text-[40px] font-semibold leading-[1.02] tracking-[-0.035em] min-[400px]:text-[46px] sm:text-[64px] xl:text-[70px]", styles.enter)}
            style={delay(80)}
          >
            <span className="text-gradient">Le dispatch VTC,</span>
            <br />
            <span className="text-brand-gradient">sans WhatsApp.</span>
          </h1>
          <p className={cn("mt-6 max-w-xl text-pretty text-[16px] leading-relaxed text-fg-muted sm:text-[17px]", styles.enter)} style={delay(160)}>
            {fr(
              "Chaque course de votre centrale est proposée automatiquement à vos chauffeurs les plus proches, par vagues de 4 à 16 km. Le premier qui accepte l'obtient, les autres sont prévenus aussitôt. Carte en direct, alertes, commissions : vous pilotez tout depuis un seul écran.",
            )}
          </p>
          <div className={cn("mt-9 flex flex-col gap-3 min-[400px]:flex-row", styles.enter)} style={delay(240)}>
            <Button asChild variant="primary" size="lg">
              <Link href={PRICING_HREF}>
                Demander un tarif <ArrowRight aria-hidden />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/services">Découvrir les services</Link>
            </Button>
          </div>
          <ul className={cn("mt-7 flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-fg-muted", styles.enter)} style={delay(320)}>
            {REASSURANCE.map((r) => (
              <li key={r} className="flex items-center gap-1.5">
                <Check className="size-3.5 text-brand" aria-hidden /> {fr(r)}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative mx-auto w-full max-w-[560px] lg:mx-0 lg:max-w-none xl:w-[112%]">
          <div aria-hidden className="pointer-events-none absolute inset-[8%] rounded-full bg-brand/[0.07] blur-[90px]" />
          <HeroVisual
            label={fr(
              "Illustration : une course de la centrale est proposée à ses chauffeurs les plus proches, vague après vague de 4 à 16 km, jusqu'à ce que l'un d'eux l'accepte.",
            )}
          >
            <OfferCard />
            <SearchCard />
          </HeroVisual>
        </div>
      </div>

      {/* Bandeau de faits produit */}
      <div className="relative z-10 border-y border-line bg-ink-950/50">
        <dl className="mx-auto grid max-w-6xl grid-cols-2 gap-px px-4 sm:px-6 lg:grid-cols-4">
          {FACTS.map((f) => (
            <div key={f.value} className="px-1 py-7 sm:px-4 lg:py-8">
              <dt className="num text-[21px] font-semibold tracking-tight text-fg sm:text-[24px]">{fr(f.value)}</dt>
              <dd className="mt-1.5 text-[13px] leading-snug text-fg-muted">{fr(f.label)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
