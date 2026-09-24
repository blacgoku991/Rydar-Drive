import type { Metadata } from "next";
import { Logo } from "@/components/brand/logo";
import { RadarScene } from "@/components/marketing/radar-scene";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Connexion" };

const FEED = [
  { t: "14:32:02", m: "Course #1928 reçue via le site", tone: "text-fg-muted" },
  { t: "14:32:03", m: "Recherche GPS — rayon 3 km", tone: "text-fg-muted" },
  { t: "14:32:04", m: "5 chauffeurs à moins de 3 km", tone: "text-fg" },
  { t: "14:32:04", m: "5 notifications envoyées", tone: "text-fg" },
  { t: "14:32:11", m: "Mohamed accepte · course verrouillée", tone: "text-brand" },
];

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.15fr_1fr]">
      {/* Visuel */}
      <section className="grain relative hidden overflow-hidden border-r border-line bg-ink-950 lg:flex lg:flex-col">
        <div className="grid-bg absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
        <div className="absolute -left-40 -top-40 size-[520px] rounded-full bg-brand/[0.07] blur-[120px]" />
        <div className="absolute -bottom-48 right-0 size-[480px] rounded-full bg-blue/[0.06] blur-[120px]" />
        <div className="relative z-10 flex items-center justify-between px-10 pt-9">
          <Logo size={30} />
          <span className="flex items-center gap-2 rounded-full border border-line bg-white/[0.03] px-3 py-1 text-xs text-fg-muted">
            <span className="size-1.5 animate-breathe rounded-full bg-brand" /> Dispatch opérationnel
          </span>
        </div>
        <div className="relative z-10 flex flex-1 items-center justify-center px-10">
          <RadarScene className="max-w-[520px]" />
          <div className="glass absolute bottom-10 left-10 w-[320px] animate-rise rounded-2xl p-4">
            <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-fg-subtle">Journal du dispatch</p>
            <ul className="space-y-1.5">
              {FEED.map((f, i) => (
                <li key={i} className="flex gap-3 text-[12.5px]" style={{ animation: `rise .5s ${0.25 * i + 0.3}s both` }}>
                  <span className="num text-fg-subtle">{f.t}</span>
                  <span className={f.tone}>{f.m}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="relative z-10 px-10 pb-10">
          <h2 className="max-w-lg text-[34px] font-semibold leading-[1.1] tracking-tight">
            <span className="text-gradient">Le dispatch VTC,</span>
            <br />
            <span className="text-brand-gradient">sans WhatsApp.</span>
          </h2>
          <p className="mt-3 max-w-md text-[15px] leading-relaxed text-fg-muted">
            Vos courses arrivent du site ou du dashboard, Rydar notifie les chauffeurs les plus proches et le premier qui accepte
            l'emporte. En temps réel.
          </p>
        </div>
      </section>

      {/* Formulaire */}
      <section className="relative flex flex-col items-center justify-center px-6 py-12">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgb(200_240_60/0.06),transparent_60%)]" />
        <div className="relative w-full max-w-[380px]">
          <div className="mb-10 lg:hidden">
            <Logo size={30} />
          </div>
          <h1 className="text-[26px] font-semibold tracking-tight">Bon retour</h1>
          <p className="mt-1.5 text-[14px] text-fg-muted">Connectez-vous à votre espace de dispatch.</p>
          <div className="mt-8">
            <LoginForm next={next} />
          </div>
          <p className="mt-10 border-t border-line pt-5 text-[12.5px] leading-relaxed text-fg-subtle">
            Espace réservé aux rattacheurs, centrales et à l'équipe Rydar. Chauffeurs : connectez-vous depuis l'application
            mobile Rydar Drive.
          </p>
        </div>
      </section>
    </main>
  );
}
