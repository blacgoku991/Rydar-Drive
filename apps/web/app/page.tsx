import { formatPrice } from "@rydar/shared";
import {
  ArrowRight, Check, Code2, Globe, LayoutDashboard, Lock, MapPinned, MessageSquareOff, Radar, Smartphone, Zap,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Logo, RadarMark } from "@/components/brand/logo";
import { RadarScene } from "@/components/marketing/radar-scene";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: { absolute: "Rydar Drive — Le dispatch VTC, sans WhatsApp" },
  description: "Réservations, dispatch automatique au chauffeur le plus proche et suivi temps réel pour rattacheurs et centrales VTC.",
};

const FEATURES = [
  { icon: Radar, title: "Dispatch par vagues", text: "3 km, puis 5, 8, 12 km : les chauffeurs en ligne, disponibles et compatibles les plus proches sont notifiés en même temps." },
  { icon: Zap, title: "Le premier qui accepte", text: "Verrou transactionnel PostgreSQL : une course n'est jamais attribuée deux fois. Les autres voient « Course déjà attribuée »." },
  { icon: MapPinned, title: "Carte temps réel", text: "Toute votre flotte en direct : disponibles, course proposée, en route, arrivé, en course. Rayons et offres visibles." },
  { icon: Smartphone, title: "App chauffeur iOS & Android", text: "EN LIGNE / HORS LIGNE, sonnerie, ACCEPTER en un geste, cycle de course guidé, position en arrière-plan." },
  { icon: Code2, title: "API & mini-site", text: "Votre site envoie les réservations via l'API, ou activez un mini-site à vos couleurs. Aucun compte client." },
  { icon: Lock, title: "Multi-tenant blindé", text: "Isolation par organisation en base (RLS), clés API hashées, audit, tentatives inter-tenant bloquées en 403." },
];

const TIMELINE = [
  ["14:32:02", "Course créée par le rattacheur", "text-fg-muted"],
  ["14:32:03", "Recherche GPS — rayon 3 km", "text-fg-muted"],
  ["14:32:03", "12 chauffeurs en ligne", "text-fg"],
  ["14:32:04", "5 chauffeurs à moins de 3 km", "text-fg"],
  ["14:32:04", "5 notifications envoyées", "text-brand"],
  ["14:32:11", "Mohamed accepte", "text-brand"],
  ["14:32:11", "Course verrouillée", "text-fg"],
  ["14:32:12", "4 autres offres fermées", "text-fg-muted"],
] as const;

export default async function Landing() {
  const supabase = await createClient();
  const { data: plans } = await supabase
    .from("plans")
    .select("id, code, name, description, price_monthly_cents, features, highlighted")
    .eq("is_active", true)
    .eq("is_public", true)
    .order("sort_order");

  return (
    <main className="relative overflow-hidden">
      {/* Fond */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[900px]">
        <div className="grid-bg absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_25%,transparent_70%)]" />
        <div className="absolute left-1/2 top-[-240px] size-[900px] -translate-x-1/2 rounded-full bg-brand/[0.08] blur-[160px]" />
      </div>

      <header className="relative z-20 mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Logo size={30} className="shrink-0" />
        <nav className="hidden items-center gap-8 text-[13.5px] text-fg-muted md:flex">
          <a href="#produit" className="hover:text-fg">Produit</a>
          <a href="#fonctionnement" className="hover:text-fg">Fonctionnement</a>
          <a href="#tarifs" className="hover:text-fg">Tarifs</a>
        </nav>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm"><Link href="/login">Connexion</Link></Button>
          <Button asChild variant="primary" size="sm" className="hidden sm:inline-flex"><a href="mailto:contact@rydar.app?subject=Démo Rydar Drive">Demander une démo</a></Button>
        </div>
      </header>

      {/* Hero */}
      <section className="relative z-10 mx-auto grid max-w-6xl items-center gap-12 px-6 pb-24 pt-10 lg:grid-cols-[1.05fr_1fr] lg:pt-16">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-white/[0.03] px-3 py-1 text-[12px] text-fg-muted">
            <MessageSquareOff className="size-3.5 text-brand" /> Fini les courses postées dans 5 groupes WhatsApp
          </span>
          <h1 className="mt-6 text-[38px] font-semibold leading-[1.04] tracking-[-0.03em] min-[400px]:text-[44px] sm:text-[64px]">
            <span className="text-gradient">Le dispatch VTC,</span>
            <br />
            <span className="text-brand-gradient">sans WhatsApp.</span>
          </h1>
          <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-fg-muted">
            Vos réservations arrivent de votre site ou de votre dashboard. Rydar Drive notifie instantanément les chauffeurs de votre
            flotte les plus proches — le premier qui accepte obtient la course. Vous suivez tout, en temps réel.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Button asChild variant="primary" size="lg"><a href="mailto:contact@rydar.app?subject=Démo Rydar Drive">Voir une démo <ArrowRight /></a></Button>
            <Button asChild variant="outline" size="lg"><Link href="/login">Accéder à mon espace</Link></Button>
          </div>
          <dl className="mt-12 grid max-w-lg grid-cols-3 gap-6 border-t border-line pt-6">
            {[["< 1 s", "pour notifier la flotte"], ["0", "double attribution"], ["24/7", "dispatch automatique"]].map(([v, l]) => (
              <div key={l}>
                <dt className="text-[26px] font-semibold tracking-tight">{v}</dt>
                <dd className="mt-1 text-[12.5px] text-fg-subtle">{l}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="relative">
          <RadarScene />
          <div className="glass absolute -bottom-6 left-0 w-[290px] animate-rise rounded-2xl p-4 sm:-left-6">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand">Nouvelle course</span>
              <span className="num text-[11px] text-fg-subtle">#1928</span>
            </div>
            <p className="mt-3 text-[14px] font-medium">La Défense → Paris CDG</p>
            <div className="mt-3 flex items-end justify-between">
              <span className="text-[12px] text-fg-muted">1,8 km du client · 2 passagers</span>
              <span className="text-[22px] font-semibold tracking-tight">65 €</span>
            </div>
            <div className="mt-3 grid h-10 place-items-center rounded-xl bg-brand text-[13px] font-bold text-brand-fg">ACCEPTER</div>
          </div>
          <div className="glass absolute -top-2 right-0 hidden w-[230px] rounded-2xl p-4 sm:block">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-subtle">Aujourd&apos;hui</p>
            <div className="mt-2 flex items-end justify-between">
              <span className="text-[26px] font-semibold tracking-tight text-brand">2 450 €</span>
              <span className="text-[12px] text-fg-muted">34 courses</span>
            </div>
            <div className="mt-3 flex h-8 items-end gap-1">
              {[40, 65, 35, 80, 55, 90, 70, 100, 60, 85].map((h, i) => (
                <span key={i} className="flex-1 rounded-t-[3px] bg-brand/70" style={{ height: `${h}%` }} />
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Deux sources, un moteur */}
      <section id="fonctionnement" className="relative z-10 border-y border-line bg-ink-950/60">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-brand">Fonctionnement</p>
          <h2 className="mt-3 max-w-2xl text-[36px] font-semibold leading-tight tracking-tight">Deux portes d&apos;entrée. Un moteur de dispatch.</h2>
          <div className="mt-12 grid gap-6 lg:grid-cols-[1fr_1fr_1.2fr]">
            <div className="surface flex flex-col rounded-2xl p-6">
              <span className="grid size-10 place-items-center rounded-xl border border-line bg-white/[0.03]"><Globe className="size-5 text-brand" /></span>
              <h3 className="mt-5 text-[17px] font-semibold">Votre site internet</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-fg-muted">Votre formulaire de réservation appelle l&apos;API avec votre clé. La course entre directement dans votre espace.</p>
              <pre className="num mt-5 overflow-hidden rounded-xl border border-line bg-ink-950/80 p-3.5 text-[11.5px] leading-relaxed text-fg-muted lg:mt-auto">
                <span className="text-brand">POST</span> /api/v1/rides{"\n"}
                <span className="text-fg-subtle">Authorization: Bearer rdk_live_…</span>{"\n"}
                <span className="text-emerald-400">201</span> Created · <span className="text-fg">#1928</span> · SEARCHING_DRIVER
              </pre>
            </div>
            <div className="surface flex flex-col rounded-2xl p-6">
              <span className="grid size-10 place-items-center rounded-xl border border-line bg-white/[0.03]"><LayoutDashboard className="size-5 text-brand" /></span>
              <h3 className="mt-5 text-[17px] font-semibold">Votre dashboard</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-fg-muted">Téléphone, hôtel, conciergerie : « Nouvelle course », 20 secondes de saisie, dispatch automatique.</p>
              <div className="mt-5 space-y-2 rounded-xl border border-line bg-ink-950/80 p-3 text-[12px] lg:mt-auto">
                {[
                  ["Départ", "Hôtel Plaza Athénée"],
                  ["Destination", "Aéroport CDG · T2E"],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.03] px-2.5 py-1.5">
                    <span className="text-fg-subtle">{k}</span>
                    <span className="truncate text-fg">{v}</span>
                  </div>
                ))}
                <div className="grid h-8 place-items-center rounded-lg bg-brand text-[12px] font-bold text-brand-fg">Créer et dispatcher</div>
              </div>
            </div>
            <div className="surface rounded-2xl p-6">
              <div className="flex items-center gap-2">
                <RadarMark size={22} animated />
                <span className="text-[13px] font-semibold">Timeline d&apos;une course</span>
              </div>
              <ul className="mt-4 space-y-1.5">
                {TIMELINE.map(([t, m, c]) => (
                  <li key={t + m} className="flex gap-3 text-[13px]">
                    <span className="num text-fg-subtle">{t}</span>
                    <span className={c}>{m}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Fonctionnalités */}
      <section id="produit" className="relative z-10 mx-auto max-w-6xl px-6 py-24">
        <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-brand">Produit</p>
        <h2 className="mt-3 max-w-2xl text-[36px] font-semibold leading-tight tracking-tight">Tout ce qu&apos;il faut pour piloter une flotte VTC haut de gamme.</h2>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <div key={title} className="surface group rounded-2xl p-6 transition-colors hover:border-brand/30">
              <Icon className="size-5 text-brand" />
              <h3 className="mt-4 text-[16px] font-semibold">{title}</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-fg-muted">{text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Tarifs */}
      <section id="tarifs" className="relative z-10 border-t border-line">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <p className="text-center text-[12px] font-semibold uppercase tracking-[0.18em] text-brand">Tarifs</p>
          <h2 className="mt-3 text-center text-[36px] font-semibold tracking-tight">Une offre pour chaque centrale</h2>
          <p className="mx-auto mt-3 max-w-xl text-center text-[15px] text-fg-muted">Sans engagement · 14 jours d&apos;essai · migration de vos chauffeurs offerte</p>
          <div className="mt-12 grid gap-4 lg:grid-cols-3">
            {(plans ?? []).map((p) => (
              <div key={p.id} className={`surface relative flex flex-col rounded-2xl p-7 ${p.highlighted ? "border-brand/40 shadow-[0_0_0_1px_rgb(200_240_60/0.25),0_40px_100px_-50px_rgb(200_240_60/0.6)]" : ""}`}>
                {p.highlighted && <span className="absolute -top-3 left-7 rounded-full bg-brand px-3 py-1 text-[11px] font-bold text-brand-fg">Le plus choisi</span>}
                <p className="text-[17px] font-semibold">{p.name}</p>
                <p className="mt-1 text-[13px] text-fg-muted">{p.description}</p>
                <p className="mt-6"><span className="text-[40px] font-semibold tracking-tight">{formatPrice(p.price_monthly_cents)}</span><span className="text-[13px] text-fg-subtle"> HT / mois</span></p>
                <ul className="mt-6 flex-1 space-y-2.5">
                  {(p.features ?? []).map((f: string) => (
                    <li key={f} className="flex gap-2.5 text-[13.5px] text-fg-muted"><Check className="mt-0.5 size-4 shrink-0 text-brand" /> {f}</li>
                  ))}
                </ul>
                <Button asChild variant={p.highlighted ? "primary" : "secondary"} className="mt-8 w-full">
                  <a href={`mailto:contact@rydar.app?subject=Offre ${p.name}`}>Démarrer avec {p.name}</a>
                </Button>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="relative z-10 border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-[12.5px] text-fg-subtle">
          <Logo size={22} />
          <span>© {new Date().getFullYear()} Rydar Drive — dispatch VTC pour rattacheurs et centrales</span>
        </div>
      </footer>
    </main>
  );
}
