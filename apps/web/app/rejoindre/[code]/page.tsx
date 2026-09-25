import type { JoinInfo } from "@rydar/shared";
import { BadgeEuro, HandCoins, Link2Off, MapPin, Navigation, Phone } from "lucide-react";
import type { Metadata } from "next";
import { cache } from "react";
import { Logo, RadarMark } from "@/components/brand/logo";
import { JoinForm } from "@/components/network/join-form";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const CODE_RE = /^[a-z0-9]{10,32}$/;
const NOINDEX: Metadata["robots"] = { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } };

/** Centrale derrière un code d'inscription (service role, une seule lecture par requête). */
const loadJoin = cache(async (raw: string): Promise<JoinInfo | null> => {
  const code = String(raw ?? "").trim().toLowerCase();
  if (!CODE_RE.test(code)) return null;
  const { data } = await createAdminClient().rpc("svc_join_info", { p_code: code });
  const info = data as JoinInfo | null;
  return info?.ok && info.organization ? info : null;
});

export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const info = await loadJoin((await params).code);
  if (!info?.organization) return { title: { absolute: "Lien d'inscription — Rydar Drive" }, robots: NOINDEX };
  return {
    title: { absolute: `Rejoindre ${info.organization.name} — Chauffeurs VTC` },
    description: `Inscrivez-vous comme chauffeur VTC indépendant dans le réseau ${info.organization.name} sur Rydar Drive.`,
    robots: NOINDEX,
  };
}

/** Couleur de marque de la centrale (#RRGGBB), lime Rydar par défaut. */
function brandColor(value: string | null | undefined) {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : "#c8f03c";
}
/** Texte lisible sur la couleur de marque. */
function readableOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.35 ? "#0b0d04" : "#ffffff";
}

const BENEFITS = [
  { icon: Navigation, title: "Courses près de vous", text: "Proposées selon votre position : vous acceptez celles qui vous conviennent." },
  { icon: BadgeEuro, title: "Votre part affichée avant d'accepter", text: "Chaque offre indique ce que vous gagnez, commission déjà déduite." },
  { icon: HandCoins, title: "Commission réglée en 2 clics depuis l'app", text: "Lien de paiement, espèces ou virement : pas de relance par message." },
];

function InvalidLink() {
  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-6">
      <div className="grid-bg absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]" />
      <div className="relative w-full max-w-sm text-center">
        <div className="mb-10 flex justify-center"><Logo size={28} /></div>
        <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl border border-line-strong bg-ink-700 text-fg-muted">
          <Link2Off className="size-6" />
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight">Lien invalide ou désactivé</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-fg-muted">
          Ce lien d&apos;inscription n&apos;est plus actif. Demandez le lien à jour à la centrale qui vous l&apos;a envoyé.
        </p>
      </div>
    </main>
  );
}

export default async function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const info = await loadJoin(code);
  if (!info?.organization) return <InvalidLink />;
  const org = info.organization;
  const brand = brandColor(org.brand_color);
  const style = { "--color-brand": brand, "--color-brand-strong": brand, "--color-brand-fg": readableOn(brand) } as React.CSSProperties;
  const autoApprove = !!info.auto_approve;

  return (
    <main style={style} className="grain relative min-h-dvh overflow-x-clip bg-ink-950">
      <div className="pointer-events-none absolute -left-40 -top-40 size-[520px] rounded-full opacity-[0.14] blur-[120px]" style={{ background: brand }} />
      <div className="pointer-events-none absolute -right-40 top-[40%] size-[420px] rounded-full bg-blue/10 blur-[140px]" />
      <div className="grid-bg pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_15%,transparent_65%)]" />

      <div className="relative z-10 mx-auto w-full max-w-xl px-4 pb-10 pt-5 sm:px-6 lg:max-w-6xl">
        <header className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {org.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={org.logo_url} alt={org.name} className="h-10 w-auto max-w-[140px] rounded-lg object-contain" />
            ) : (
              <span className="grid size-10 shrink-0 place-items-center rounded-xl text-[17px] font-bold" style={{ background: brand, color: readableOn(brand) }}>
                {org.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold tracking-tight">{org.name}</span>
              {org.city && (
                <span className="flex items-center gap-1 text-[12px] text-fg-subtle">
                  <MapPin className="size-3" /> {org.city}
                </span>
              )}
            </span>
          </div>
          {org.phone && (
            <a
              href={`tel:${org.phone.replace(/\s/g, "")}`}
              className="flex shrink-0 items-center gap-2 rounded-full border border-line-strong bg-white/[0.03] px-3 py-2 text-[12.5px] font-medium hover:border-white/20"
              aria-label={`Appeler ${org.name}`}
            >
              <Phone className="size-3.5 text-brand" />
              <span className="num hidden sm:inline">{org.phone}</span>
              <span className="sm:hidden">Appeler</span>
            </a>
          )}
        </header>

        <div className="mt-8 grid gap-8 lg:mt-14 lg:grid-cols-[1fr_520px] lg:gap-12">
          <section className="lg:sticky lg:top-10 lg:self-start lg:pt-6">
            <span className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand/[0.08] px-3 py-1 text-[12px] font-medium text-brand">
              <span className="size-1.5 animate-breathe rounded-full bg-brand" /> Recrutement chauffeurs VTC
            </span>
            <h1 className="mt-4 text-[30px] font-semibold leading-[1.08] tracking-tight sm:text-[40px] lg:text-[48px]">
              <span className="text-gradient">Rejoignez le réseau {org.name}</span>
            </h1>
            <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-fg-muted">
              Inscription en 2 minutes.{" "}
              {autoApprove ? "Votre compte est actif dès l'inscription" : "La centrale valide votre profil"}, puis vous recevez les courses dans
              l&apos;application Rydar Drive.
            </p>
            <ul className="mt-6 grid gap-3 lg:mt-10 lg:gap-5">
              {BENEFITS.map((b) => (
                <li key={b.title} className="flex gap-3">
                  <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-white/[0.03]">
                    <b.icon className="size-4 text-brand" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium">{b.title}</span>
                    <span className="block text-[12.5px] leading-relaxed text-fg-subtle">{b.text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-label="Formulaire d'inscription" className="glass relative overflow-hidden rounded-3xl">
            <div className="hairline-top border-b border-line px-5 py-4 sm:px-7">
              <h2 className="text-[17px] font-semibold tracking-tight">{autoApprove ? "Créer mon compte chauffeur" : "Ma candidature"}</h2>
              <p className="mt-0.5 text-[12.5px] text-fg-muted">
                Chauffeur VTC indépendant · {autoApprove ? "activation immédiate" : `réponse de ${org.name}`}
              </p>
            </div>
            <JoinForm code={code.toLowerCase()} organizationName={org.name} autoApprove={autoApprove} />
          </section>
        </div>

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-[12px] text-fg-subtle">
          <span>© {new Date().getFullYear()} {org.name}{org.email ? ` · ${org.email}` : ""}</span>
          <span className="flex items-center gap-2">
            Propulsé par <RadarMark size={16} /> <span className="text-fg-muted">Rydar Drive</span>
          </span>
        </footer>
      </div>
    </main>
  );
}
