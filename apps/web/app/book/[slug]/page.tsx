import type { PricingRule, VehicleCategory } from "@rydar/shared";
import { Clock, MapPin, Phone, ShieldCheck, Sparkles, Star } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookingForm } from "@/components/booking/booking-form";
import { RadarMark } from "@/components/brand/logo";
import { getSession } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function load(slug: string) {
  const admin = createAdminClient();
  const { data: org } = await admin
    .from("organizations")
    .select("id, name, status, logo_url, booking:booking_sites(*)")
    .eq("slug", slug)
    .maybeSingle();
  if (!org || (org as any).status !== "active") return null;
  const site = Array.isArray((org as any).booking) ? (org as any).booking[0] : (org as any).booking;
  return { org: org as any, site };
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const data = await load((await params).slug);
  if (!data?.site) return { title: "Réservation" };
  return { title: { absolute: `${data.site.title ?? data.org.name} — Réservation de chauffeur privé` }, description: data.site.tagline ?? undefined };
}

function readableOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.35 ? "#0b0d04" : "#ffffff";
}

export default async function BookingPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ preview?: string }> }) {
  const { slug } = await params;
  const { preview } = await searchParams;
  const data = await load(slug);
  if (!data?.site) notFound();
  const { org, site } = data;
  if (!site.enabled) {
    const session = preview ? await getSession() : null;
    if (!session?.memberships.some((m) => m.org.id === org.id)) notFound();
  }
  const { data: pricing } = await createAdminClient()
    .from("pricing_rules")
    .select("vehicle_category, base_fare_cents, per_km_cents, per_minute_cents, minimum_fare_cents, night_surcharge_percent, night_start, night_end")
    .eq("organization_id", org.id)
    .eq("is_active", true);
  const brand = site.primary_color ?? "#c8f03c";
  const style = { "--color-brand": brand, "--color-brand-strong": brand, "--color-brand-fg": readableOn(brand) } as React.CSSProperties;

  return (
    <main style={style} className="grain relative min-h-dvh overflow-hidden bg-ink-950">
      <div className="pointer-events-none absolute -left-40 -top-40 size-[640px] rounded-full opacity-[0.12] blur-[140px]" style={{ background: brand }} />
      <div className="pointer-events-none absolute -bottom-60 right-0 size-[520px] rounded-full bg-blue/10 blur-[140px]" />
      <div className="grid-bg pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_70%)]" />
      {site.hero_image_url && <div className="pointer-events-none absolute inset-0 bg-cover bg-center opacity-[0.12]" style={{ backgroundImage: `url(${site.hero_image_url})` }} />}

      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-3">
          {site.logo_url ? <img src={site.logo_url} alt={site.title ?? org.name} className="h-9 w-auto" /> : <span className="grid size-9 place-items-center rounded-xl text-[15px] font-bold" style={{ background: brand, color: readableOn(brand) }}>{(site.title ?? org.name).slice(0, 1)}</span>}
          <span className="text-[16px] font-semibold tracking-tight">{site.title ?? org.name}</span>
        </div>
        {site.phone && (
          <a href={`tel:${site.phone.replace(/\s/g, "")}`} className="flex items-center gap-2 rounded-full border border-line-strong bg-white/[0.03] px-4 py-2 text-[13px] font-medium hover:border-white/20">
            <Phone className="size-4 text-brand" /> {site.phone}
          </a>
        )}
      </header>

      <section className="relative z-10 mx-auto grid max-w-6xl gap-10 px-6 pb-20 pt-6 lg:grid-cols-[1fr_480px] lg:pt-14">
        <div className="lg:pt-10">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand/[0.08] px-3 py-1 text-[12px] font-medium text-brand">
            <span className="size-1.5 animate-breathe rounded-full bg-brand" /> Chauffeurs disponibles 24 h/24
          </span>
          <h1 className="mt-6 text-[44px] font-semibold leading-[1.05] tracking-tight sm:text-[56px]">
            <span className="text-gradient">{site.tagline ?? "Votre chauffeur privé,"}</span>
          </h1>
          {site.description && <p className="mt-5 max-w-lg text-[16px] leading-relaxed text-fg-muted">{site.description}</p>}
          <ul className="mt-10 grid max-w-lg gap-4 sm:grid-cols-2">
            {[
              [ShieldCheck, "Chauffeurs VTC professionnels", "Cartes VTC et assurances vérifiées"],
              [Clock, "Ponctualité garantie", "Suivi des vols et attente incluse"],
              [Sparkles, "Véhicules haut de gamme", "Berlines, vans et prestige"],
              [Star, "Prix annoncé à l'avance", "Aucune surprise à l'arrivée"],
            ].map(([Icon, t, d]) => {
              const I = Icon as typeof ShieldCheck;
              return (
                <li key={t as string} className="flex gap-3">
                  <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-white/[0.03]"><I className="size-4 text-brand" /></span>
                  <span>
                    <span className="block text-[14px] font-medium">{t as string}</span>
                    <span className="block text-[12.5px] text-fg-subtle">{d as string}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          {site.service_area && (
            <p className="mt-10 flex items-start gap-2 text-[13px] text-fg-muted"><MapPin className="mt-0.5 size-4 shrink-0 text-brand" /> {site.service_area}</p>
          )}
        </div>
        <div className="glass relative overflow-hidden rounded-3xl">
          <div className="hairline-top border-b border-line px-6 py-5">
            <h2 className="text-[17px] font-semibold tracking-tight">Réserver une course</h2>
            <p className="mt-0.5 text-[12.5px] text-fg-muted">Sans compte · confirmation immédiate</p>
          </div>
          <BookingForm slug={slug} categories={(site.vehicle_categories ?? ["standard"]) as VehicleCategory[]} pricing={(pricing ?? []) as PricingRule[]} showPrice={site.show_price_estimate} phone={site.phone} />
        </div>
      </section>

      <footer className="relative z-10 border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-[12px] text-fg-subtle">
          <span>© {new Date().getFullYear()} {org.name}{site.email ? ` · ${site.email}` : ""}</span>
          <span className="flex items-center gap-2">Réservations propulsées par <RadarMark size={16} /> <span className="text-fg-muted">Rydar Drive</span></span>
        </div>
      </footer>
    </main>
  );
}
