// Flotte Privée : page du test d'éligibilité (servie à la racine de eligibilite.<domaine> par proxy.ts, et sur
// /eligibilite). Page d'arrivée des publicités : sans la navigation du site vitrine, tutoiement, aucun script tiers.
import { SIMULATOR } from "@rydar/shared";
import { ArrowRight, BadgeCheck, CalendarDays, ChevronDown, Globe, KeyRound, Megaphone, Smartphone, Target, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EligibilityTest } from "@/components/eligibility/eligibility-test";
import { eur } from "@/components/eligibility/format";
import { HeroVisual } from "@/components/eligibility/hero-visual";
import { SimProvider } from "@/components/eligibility/sim-context";
import { Simulator } from "@/components/eligibility/simulator";
import { fr } from "@/components/marketing/typo";
import { env } from "@/lib/env";

const TITLE = "Flotte Privée : ta centrale de réservation, tes propres clients";
const DESCRIPTION = fr(
  "Site pro, pubs Google Ads et Facebook pilotées par nos experts, réservations dans ton appli Rydar Drive : teste ton éligibilité en 1 minute. 15 places pour commencer.",
);

export function generateMetadata(): Metadata {
  const url = `https://eligibilite.${env.rootDomain}/`;
  return {
    title: { absolute: TITLE },
    description: DESCRIPTION,
    alternates: { canonical: url },
    openGraph: { type: "website", locale: "fr_FR", url, siteName: "Flotte Privée · Rydar Drive", title: TITLE, description: DESCRIPTION },
    twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
  };
}

const eyebrow = "text-[12px] font-semibold uppercase tracking-[0.18em] text-brand";
const h2 = "mt-3 text-balance text-[clamp(28px,4.4vw,44px)] font-semibold leading-[1.08] tracking-[-0.02em] text-fg";
const lead = "mt-4 max-w-2xl text-pretty text-[16px] leading-relaxed text-fg-muted sm:text-[17px]";
const ctaPrimary =
  "inline-flex min-h-14 items-center justify-center gap-2 rounded-2xl bg-brand px-7 text-[16px] font-semibold text-brand-fg shadow-glow transition-colors hover:bg-brand-strong";
const ctaOutline =
  "inline-flex min-h-14 items-center justify-center gap-2 rounded-2xl border border-line-strong px-7 text-[16px] font-medium text-fg transition-colors hover:border-white/25 hover:bg-white/[0.04]";

const INCLUDED = [
  {
    icon: Globe,
    title: "Ton site de réservation pro",
    text: "Un site multi-pages à ton nom : tes services, tes tarifs, ta zone, et un formulaire de réservation pensé pour convertir sur téléphone.",
  },
  {
    icon: Megaphone,
    title: "Tes comptes Google Ads et Facebook",
    text: "Nous créons et configurons tes comptes publicitaires : annonces, ciblage de ta zone, suivi des réservations venues de tes pubs.",
  },
  {
    icon: Target,
    title: "La stratégie pilotée par nos experts",
    text: "Nous lançons tes campagnes et les ajustons selon ton budget : les mots-clés qui ramènent des courses, les zones qui paient, les horaires qui marchent.",
  },
  {
    icon: Smartphone,
    title: "Ton accès partenaire à l'appli Rydar Drive",
    text: "Tes identifiants, ton agenda des courses planifiées, et chaque réservation de ton site qui tombe dans ton téléphone. Rien que pour toi.",
  },
];

const STEPS = [
  { title: "Tu passes le test", text: "3 questions sur ton activité, ton budget pub et ta zone. Réponse immédiate." },
  { title: "On t'appelle", text: "On valide ton profil ensemble et on cale ta stratégie : zone, budget, type de courses visées." },
  { title: "Ta centrale démarre", text: "Ton site et tes pubs sont en ligne, les réservations arrivent dans ton appli. Tu roules pour tes clients." },
];

const FAQ = [
  {
    q: "Les clients sont vraiment à moi ?",
    a: "Oui. Ta centrale, tes clients, tes courses et tes prix t'appartiennent. Rydar Drive est le logiciel qui reçoit et organise tes réservations.",
  },
  {
    q: "Je dois arrêter les applis ?",
    a: "Non. Tu continues à rouler comme tu veux : ta centrale remplit ton agenda à côté, et tu choisis les courses que tu prends.",
  },
  {
    q: "Combien je dois mettre en pub ?",
    a: "Tu choisis ton budget. On peut démarrer dès 150 € par mois ; plus le budget est élevé, plus tes pubs touchent de clients. Le simulateur te donne un ordre d'idée.",
  },
  {
    q: "Vous garantissez un nombre de courses ?",
    a: "Non, et personne d'honnête ne le peut : les résultats dépendent de ta zone, de la concurrence et de la saison. Nos experts pilotent tes campagnes pour en tirer le maximum, et tu suis tout dans ton appli.",
  },
  {
    q: "Pourquoi seulement 15 places ?",
    a: "Chaque centrale est lancée et suivie à la main par notre équipe. Pour bien faire les choses, on commence avec 15 chauffeurs.",
  },
  {
    q: "Qui peut postuler ?",
    a: "Les chauffeurs VTC en règle (carte professionnelle, inscription au registre VTC, assurance), qui veulent développer leur propre clientèle.",
  },
];

export default function EligibilityPage() {
  const site = env.appUrl.replace(/\/+$/, "");
  return (
    <SimProvider>
      <a
        href="#contenu"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-brand focus:px-4 focus:py-2 focus:text-[14px] focus:font-semibold focus:text-brand-fg"
      >
        Aller au contenu
      </a>
      <header className="sticky top-0 z-50 border-b border-line bg-ink-900/90 backdrop-blur-xl [@media(max-height:30rem)]:static">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <a href="#contenu" className="flex items-center gap-2.5 rounded-lg" aria-label="Flotte Privée, par Rydar Drive : haut de page">
            <span className="grid size-9 place-items-center rounded-xl bg-brand text-brand-fg">
              <KeyRound className="size-[18px]" strokeWidth={2.4} aria-hidden />
            </span>
            <span className="flex flex-col leading-none">
              <span className="text-[16px] font-semibold tracking-tight text-fg">Flotte Privée</span>
              <span className="mt-1 text-[10.5px] font-medium uppercase tracking-[0.14em] text-fg-muted">par Rydar Drive</span>
            </span>
          </a>
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-2 rounded-full border border-brand/30 bg-brand/[0.07] px-3 py-1.5 text-[12.5px] font-medium text-fg sm:inline-flex">
              <span className="size-1.5 rounded-full bg-brand" aria-hidden /> 15 places pour commencer
            </span>
            <a href="#test" className="inline-flex min-h-10 items-center rounded-xl bg-brand px-4 text-[14px] font-semibold text-brand-fg transition-colors hover:bg-brand-strong">
              Tester<span className="hidden sm:inline">&nbsp;mon éligibilité</span>
            </a>
          </div>
        </div>
      </header>

      <main id="contenu" tabIndex={-1} className="relative overflow-x-clip outline-none">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[1000px]">
          <div className="grid-bg absolute inset-0 [mask-image:radial-gradient(ellipse_at_60%_10%,black_15%,transparent_65%)]" />
          <div className="absolute right-[-10%] top-[-20%] size-[900px] rounded-full bg-brand/[0.06] blur-[170px]" />
        </div>

        {/* Haut de page */}
        <section aria-labelledby="hero-titre" className="relative">
          <div className="mx-auto grid max-w-6xl items-center gap-14 px-4 pb-20 pt-12 sm:px-6 lg:grid-cols-[1.08fr_0.92fr] lg:pb-28 lg:pt-20">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-white/[0.03] px-3.5 py-1.5 text-[13px] text-fg-muted">
                <span className="relative flex size-2" aria-hidden>
                  <span className="animate-ping absolute inline-flex size-full rounded-full bg-brand opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-brand" />
                </span>
                <span>
                  <span className="hidden sm:inline">Programme </span>
                  {fr("Flotte Privée · 15 places pour commencer")}
                </span>
              </p>
              <h1 id="hero-titre" className="mt-6 text-balance text-[clamp(38px,6.4vw,68px)] font-semibold leading-[1.02] tracking-[-0.03em] text-fg">
                Arrête de rouler pour les applis.{" "}
                <span className="text-brand-gradient">Roule pour tes clients.</span>
              </h1>
              <p className="mt-6 max-w-xl text-pretty text-[17px] leading-relaxed text-fg-muted sm:text-[18px]">
                {fr(
                  "Nous montons ta centrale de réservation : ton site pro, tes pubs Google Ads et Facebook lancées et pilotées par nos experts selon ton budget, et chaque réservation qui tombe dans ton appli Rydar Drive. Rien que pour toi.",
                )}
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <a href="#test" className={ctaPrimary}>
                  Tester mon éligibilité <ArrowRight className="size-5" aria-hidden />
                </a>
                <a href="#simulateur" className={ctaOutline}>
                  Simuler mes gains
                </a>
              </div>
              <dl className="mt-10 grid max-w-xl grid-cols-3 gap-3">
                {[
                  { v: SIMULATOR.fare.rangeLabel.replace(" à ", "–"), l: "course moyenne d'une centrale" },
                  { v: SIMULATOR.app.rangeLabel.replace(" à ", "–"), l: "course moyenne sur les applis" },
                  { v: "100 %", l: "de tes clients sont à toi" },
                ].map((s, i) => (
                  <div key={s.l} className="flex flex-col rounded-xl border border-line bg-ink-850/80 px-3 py-3 sm:px-4">
                    <dt className="order-2 mt-1 text-[12px] leading-snug text-fg-muted">{fr(s.l)}</dt>
                    <dd className={`order-1 num text-[clamp(16px,2.6vw,22px)] font-semibold leading-tight ${i === 1 ? "text-fg-muted" : "text-fg"}`}>{fr(s.v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <HeroVisual />
          </div>
        </section>

        {/* Test d'éligibilité */}
        <section id="test" aria-labelledby="test-titre" className="relative scroll-mt-16 border-y border-line bg-ink-950/50">
          <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6 lg:py-24">
            <div className="text-center">
              <p className={eyebrow}>{fr("Test d'éligibilité")}</p>
              <h2 id="test-titre" className={h2}>
                {fr("Vérifie si tu peux décrocher l'une des 15 places")}
              </h2>
              <p className={`${lead} mx-auto`}>{fr("3 questions, 1 minute, réponse immédiate. Aucun engagement.")}</p>
            </div>
            <div className="hairline-top relative mt-10 overflow-hidden rounded-3xl border border-line-strong bg-ink-800 p-5 shadow-float sm:p-9">
              <EligibilityTest />
            </div>
          </div>
        </section>

        {/* Simulateur */}
        <section id="simulateur" aria-labelledby="sim-titre" className="relative scroll-mt-16">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-28">
            <div className="max-w-3xl">
              <p className={eyebrow}>Simulateur</p>
              <h2 id="sim-titre" className={h2}>
                {fr("Combien tes pubs peuvent te rapporter ?")}
              </h2>
              <p className={lead}>
                {fr(
                  `Sur les applis, une course te rapporte ${SIMULATOR.app.rangeLabel}, commission déduite en plus. Sur ta centrale, nos courses tournent autour de ${SIMULATOR.fare.rangeLabel}. Règle ton budget et vois ce que ça donne.`,
                )}
              </p>
            </div>
            <div className="mt-10">
              <Simulator />
            </div>
          </div>
        </section>

        {/* Ce qui est compris */}
        <section aria-labelledby="inclus-titre" className="relative border-t border-line">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-28">
            <div className="max-w-3xl">
              <p className={eyebrow}>Ce que comprend Flotte Privée</p>
              <h2 id="inclus-titre" className={h2}>
                {fr("Une centrale de réservation qui t'appartient, clé en main")}
              </h2>
              <p className={lead}>{fr("Tu t'occupes de rouler. Nous, on s'occupe de faire venir les clients.")}</p>
            </div>
            <ul className="mt-12 grid gap-4 sm:grid-cols-2">
              {INCLUDED.map((it) => (
                <li key={it.title} className="group relative overflow-hidden rounded-2xl border border-line bg-ink-800 p-6 transition-colors hover:border-brand/30 sm:p-7">
                  <span className="grid size-12 place-items-center rounded-xl border border-brand/30 bg-brand/[0.08]">
                    <it.icon className="size-5 text-brand" aria-hidden />
                  </span>
                  <h3 className="mt-5 text-[19px] font-semibold tracking-tight text-fg">{fr(it.title)}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-fg-muted">{fr(it.text)}</p>
                </li>
              ))}
            </ul>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              {[
                { icon: CalendarDays, t: "Agenda complet de tes courses planifiées" },
                { icon: Users, t: "Tes réservations et leur suivi au même endroit" },
                { icon: BadgeCheck, t: "Accompagnement de notre équipe dès le lancement" },
              ].map((x) => (
                <div key={x.t} className="flex items-center gap-3 rounded-2xl border border-line bg-white/[0.02] px-5 py-4">
                  <x.icon className="size-5 shrink-0 text-brand" aria-hidden />
                  <p className="text-[14px] text-fg">{fr(x.t)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Étapes */}
        <section aria-labelledby="etapes-titre" className="relative border-t border-line bg-ink-950/50">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
            <p className={eyebrow}>Comment ça marche</p>
            <h2 id="etapes-titre" className={h2}>
              {fr("3 étapes jusqu'à tes premiers clients")}
            </h2>
            <ol className="mt-12 grid gap-4 md:grid-cols-3">
              {STEPS.map((s, i) => (
                <li key={s.title} className="relative rounded-2xl border border-line bg-ink-800 p-6 sm:p-7">
                  <span className="num text-[44px] font-semibold leading-none text-brand/80" aria-hidden>
                    0{i + 1}
                  </span>
                  <h3 className="mt-4 text-[19px] font-semibold tracking-tight text-fg">{fr(s.title)}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-fg-muted">{fr(s.text)}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Questions */}
        <section aria-labelledby="faq-titre" className="relative border-t border-line">
          <div className="mx-auto max-w-3xl px-4 py-20 sm:px-6 lg:py-24">
            <p className={eyebrow}>Questions</p>
            <h2 id="faq-titre" className={h2}>
              Tu te demandes peut-être…
            </h2>
            <div className="mt-10 divide-y divide-line rounded-2xl border border-line bg-ink-800">
              {FAQ.map((f) => (
                <details key={f.q} className="group px-5 sm:px-6">
                  <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-4 text-[16px] font-medium text-fg [&::-webkit-details-marker]:hidden">
                    {fr(f.q)}
                    <ChevronDown className="size-5 shrink-0 text-fg-muted transition-transform group-open:rotate-180" aria-hidden />
                  </summary>
                  <p className="pb-5 text-[15px] leading-relaxed text-fg-muted">{fr(f.a)}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Appel final */}
        <section aria-labelledby="fin-titre" className="relative px-4 pb-24 sm:px-6">
          <div className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl border border-brand/30 bg-ink-850 px-6 py-16 text-center sm:px-12 sm:py-20">
            <div aria-hidden className="grid-bg absolute inset-0 [mask-image:radial-gradient(ellipse_at_50%_0%,black,transparent_70%)]" />
            <div aria-hidden className="absolute left-1/2 top-0 size-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand/[0.12] blur-[120px]" />
            <div className="relative">
              <p className={eyebrow}>Flotte Privée</p>
              <h2 id="fin-titre" className="mx-auto mt-3 max-w-3xl text-balance text-[clamp(30px,5vw,54px)] font-semibold leading-[1.05] tracking-[-0.02em] text-fg">
                {fr("15 places seulement pour commencer.")}
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-[17px] leading-relaxed text-fg-muted">
                {fr(`Teste ton éligibilité maintenant : 1 minute, réponse immédiate. Pubs dès ${eur(SIMULATOR.budget.min)} par mois.`)}
              </p>
              <a href="#test" className={`${ctaPrimary} mt-8`}>
                Tester mon éligibilité <ArrowRight className="size-5" aria-hidden />
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-ink-950/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-10 text-[13px] text-fg-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>
            {fr("Flotte Privée est un programme de ")}
            <a href={site} className="text-fg underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-brand">
              Rydar Drive
            </a>
            {fr(", logiciel de réservation et de dispatch VTC.")}
          </p>
          <nav aria-label="Informations légales">
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              {[
                { href: "/mentions-legales", label: "Mentions légales" },
                { href: "/confidentialite", label: "Confidentialité" },
                { href: "/cookies", label: "Cookies" },
                { href: "/accessibilite", label: "Accessibilité : non conforme" },
              ].map((l) => (
                <li key={l.href}>
                  <Link href={l.href} prefetch={false} className="inline-flex min-h-6 items-center transition-colors hover:text-fg">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </footer>
    </SimProvider>
  );
}
