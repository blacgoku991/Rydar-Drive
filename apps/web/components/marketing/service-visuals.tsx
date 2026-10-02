import {
  DRIVER_BLOCKER_META,
  FLEET_REPORT_META,
  formatPrice,
  PRESENCE_META,
  RIDE_ALERT_META,
  SETTLEMENT_METHOD_META,
  SETTLEMENT_STATUS_META,
  TRUST_LEVEL_META,
  WHATSAPP_TEMPLATES,
  type Tone,
} from "@rydar/shared";
import {
  CalendarClock,
  Car,
  CarFront,
  CircleCheck,
  CirclePause,
  Clock3,
  ClockAlert,
  Construction,
  CornerUpRight,
  Download,
  FileCheck2,
  FileUp,
  Globe,
  KeyRound,
  Link2,
  Lock,
  MessagesSquare,
  Plane,
  Radar,
  RotateCw,
  Route,
  SatelliteDish,
  ScrollText,
  ShieldCheck,
  Smartphone,
  TimerOff,
  TriangleAlert,
  UserCheck,
  UserCog,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import styles from "./landing.module.css";
import { fr } from "./typo";

/*
 * Visuels des services (page Services) : maquettes en HTML des écrans réels du produit, remplies avec des exemples.
 * Les libellés viennent de @rydar/shared quand ils existent (statuts, alertes, moyens de paiement, signalements).
 */

const DOT: Record<Tone, string> = {
  brand: "bg-brand",
  amber: "bg-amber",
  blue: "bg-blue",
  violet: "bg-violet",
  cyan: "bg-cyan",
  green: "bg-green",
  red: "bg-red",
  neutral: "bg-fg-subtle",
};

function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border border-line bg-white/[0.03] px-2.5 py-1 text-[12px] text-fg-muted", className)}>
      {children}
    </span>
  );
}

/** Mini-site de réservation d'une centrale : cadre de navigateur, formulaire rempli et prix estimé (exemple). */
export function BookingSiteVisual() {
  // Couleur de marque de la centrale (réglage « Couleur principale » du mini-site) : ici un autre jeton que le lime
  const brand = { "--color-brand": "var(--color-cyan)", "--color-brand-fg": "var(--color-ink-950)" } as CSSProperties;
  const field = "flex items-center gap-3 rounded-xl border border-line bg-white/[0.03] px-3 py-2.5";
  return (
    <div
      role="img"
      aria-label={fr(
        "Exemple de mini-site de réservation à l'adresse reservation.votre-centrale.fr : départ, destination, date et heure, prix estimé de 48 € et bouton Réserver.",
      )}
      className="mx-auto w-full max-w-[460px] overflow-hidden rounded-2xl border border-line-strong bg-ink-950 shadow-[0_30px_80px_-40px_rgb(0_0_0/0.9)]"
    >
      {/* Barre du navigateur */}
      <div className="flex items-center gap-3 border-b border-line bg-ink-850 px-3.5 py-2.5">
        <span className="flex shrink-0 gap-1.5">
          <span className="size-2.5 rounded-full bg-white/[0.12]" />
          <span className="size-2.5 rounded-full bg-white/[0.12]" />
          <span className="size-2.5 rounded-full bg-white/[0.12]" />
        </span>
        <span className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md bg-white/[0.05] px-3 py-1 text-[11.5px] text-fg-muted">
          <Lock className="size-3 shrink-0" />
          <span className="truncate">reservation.votre-centrale.fr</span>
        </span>
        {/* Contrepoids des pastilles : adresse centrée (sauf sur petit écran, où elle a besoin de la place) */}
        <span className="hidden w-[42px] shrink-0 sm:block" />
      </div>

      <div style={brand} className="relative p-4 sm:p-5">
        <div aria-hidden className="pointer-events-none absolute -left-16 -top-24 size-56 rounded-full bg-brand/[0.12] blur-3xl" />
        <div className="relative flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg bg-brand text-[12px] font-bold text-brand-fg">V</span>
          <span className="text-[13.5px] font-semibold tracking-tight">Votre centrale</span>
        </div>
        <p className="relative mt-4 text-[15px] font-semibold tracking-tight">Réserver une course</p>
        <p className="relative text-[11.5px] text-fg-muted">Sans compte · confirmation immédiate</p>

        <div className="relative mt-3.5 space-y-2">
          <div className={field}>
            <span className="size-2.5 shrink-0 rounded-full bg-amber ring-4 ring-amber/15" />
            <span className="min-w-0">
              <span className="block text-[10.5px] text-fg-muted">Départ</span>
              <span className="block truncate text-[12.5px]">Gare de Lyon, Paris</span>
            </span>
          </div>
          <div className={field}>
            <span className="size-2.5 shrink-0 rounded-[3px] bg-fg" />
            <span className="min-w-0">
              <span className="block text-[10.5px] text-fg-muted">Destination</span>
              <span className="block truncate text-[12.5px]">Aéroport Paris-Orly</span>
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className={field}>
              <CalendarClock className="size-4 shrink-0 text-brand" />
              <span className="min-w-0">
                <span className="block text-[10.5px] text-fg-muted">Date</span>
                <span className="block truncate text-[12.5px]">Demain</span>
              </span>
            </div>
            <div className={field}>
              <Clock3 className="size-4 shrink-0 text-brand" />
              <span className="min-w-0">
                <span className="block text-[10.5px] text-fg-muted">Heure</span>
                <span className="num block text-[12.5px]">08:30</span>
              </span>
            </div>
          </div>
        </div>

        <div className="relative mt-3 flex items-end justify-between gap-3 rounded-xl border border-line bg-white/[0.02] px-3.5 py-3">
          <span className="text-[11.5px] text-fg-muted">
            <span className="num text-fg">{fr("19 km")}</span> · <span className="num text-fg">{fr("30 min")}</span> de trajet
          </span>
          <span className="text-right">
            <span className="block text-[10.5px] text-fg-muted">Prix estimé</span>
            <span className="num block text-[22px] font-semibold leading-tight text-brand">{fr("48 €")}</span>
          </span>
        </div>
        <div className="relative mt-3 grid h-10 place-items-center rounded-xl bg-brand text-[13px] font-semibold text-brand-fg">Réserver</div>
      </div>
    </div>
  );
}

/** Tableau de bord, « Nouvelle course » : trajet, prix et chauffeurs disponibles calculés en direct (exemple). */
export function NewRideVisual() {
  const metrics: { icon: LucideIcon; label: string; value: string; accent?: boolean }[] = [
    { icon: Route, label: "Distance", value: "19 km" },
    { icon: Clock3, label: "Durée", value: "30 min" },
    { icon: Zap, label: "Prix estimé", value: "48 €", accent: true },
    { icon: Car, label: "3 chauffeurs dispo.", value: "4 min" },
  ];
  return (
    <div aria-hidden className="rounded-xl border border-line bg-ink-950/60 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold">Nouvelle course</span>
        <span className="kbd">N</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-ink-800 p-1 text-[12px] font-medium">
        <span className="flex h-7 items-center justify-center gap-1.5 rounded-md bg-ink-600 text-fg">
          <Zap className="size-3.5 text-brand" /> Maintenant
        </span>
        <span className="flex h-7 items-center justify-center gap-1.5 rounded-md text-fg-muted">
          <CalendarClock className="size-3.5" /> Planifier
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line">
        {metrics.map(({ icon: Icon, label, value, accent }) => (
          <div key={label} className="bg-ink-900 px-3 py-2">
            <p className="flex items-center gap-1.5 text-[11px] leading-tight text-fg-muted">
              <Icon className="size-3 shrink-0" /> {label}
            </p>
            <p className={cn("num mt-0.5 text-[16px] font-semibold tracking-tight", accent ? "text-brand" : "text-fg")}>{fr(value)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Vagues 4 → 8 → 12 → 16 km, relance, puis alerte (délais et rayons par défaut). */
export function WavesVisual() {
  const waves = [4, 8, 12, 16];
  return (
    <div>
      <ol aria-label="Vagues de dispatch" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {waves.map((km, i) => (
          <li
            key={km}
            className={cn("rounded-xl border px-3 py-3", styles.waveStep)}
            style={{ "--i": i } as CSSProperties}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-muted">Vague {i + 1}</span>
              <span aria-hidden className={cn("size-2 rounded-full bg-brand shadow-[0_0_10px_var(--color-brand)]", styles.waveDot)} />
            </div>
            <p className="num mt-2 text-[22px] font-semibold tracking-tight">{fr(`${km} km`)}</p>
            <p className="mt-0.5 text-[12px] text-fg-muted">{fr("30 s pour accepter")}</p>
          </li>
        ))}
      </ol>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-line-strong px-3 py-2.5 text-[12.5px] text-fg-muted">
          <Radar aria-hidden className="size-4 shrink-0 text-brand" />
          {fr("Relance automatique : 4 puis 8 km")}
        </div>
        <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-line-strong px-3 py-2.5 text-[12.5px] text-fg-muted">
          <TriangleAlert aria-hidden className="size-4 shrink-0 text-amber" />
          {fr("Toujours personne : alerte et explication")}
        </div>
      </div>
    </div>
  );
}

/** Mini carte du command center : véhicules colorés par statut et itinéraire. */
export function MapVisual() {
  const cars: { x: number; y: number; tone: Tone }[] = [
    { x: 18, y: 30, tone: "brand" },
    { x: 34, y: 68, tone: "brand" },
    { x: 58, y: 24, tone: "amber" },
    { x: 76, y: 58, tone: "blue" },
    { x: 46, y: 46, tone: "cyan" },
    { x: 86, y: 22, tone: "violet" },
  ];
  const legend = (["available", "offered", "en_route", "arrived", "on_trip"] as const).map((k) => PRESENCE_META[k]);
  return (
    <div>
      <div aria-hidden className="grid-bg relative h-32 overflow-hidden rounded-xl border border-line bg-ink-950/70">
        <svg viewBox="0 0 100 60" preserveAspectRatio="none" className="absolute inset-0 size-full">
          <path d="M34 41 C 44 38, 50 30, 58 28 S 72 36, 76 35" fill="none" className="stroke-blue" strokeWidth="0.8" strokeDasharray="2 1.6" vectorEffect="non-scaling-stroke" />
        </svg>
        {cars.map((c, i) => (
          <span
            key={i}
            className={cn("absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-ink-950", DOT[c.tone])}
            style={{ left: `${c.x}%`, top: `${c.y}%` }}
          />
        ))}
      </div>
      <ul aria-label="Statuts affichés sur la carte" className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5">
        {legend.map((m) => (
          <li key={m.label} className="flex items-center gap-1.5 text-[12px] text-fg-muted">
            <span aria-hidden className={cn("size-1.5 rounded-full", DOT[m.tone])} />
            {m.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Téléphone du chauffeur : guidage et glissière d'étape. */
export function DriverAppVisual() {
  return (
    <div aria-hidden className="mx-auto w-full max-w-[250px] rounded-[26px] border border-line-strong bg-ink-950 p-2.5 shadow-[0_24px_60px_-30px_rgb(0_0_0/0.9)]">
      <div className="rounded-[18px] border border-line bg-ink-850 p-3">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand/15 px-2 py-0.5 text-[10.5px] font-semibold text-brand">
            <span className="size-1.5 rounded-full bg-brand" /> EN LIGNE
          </span>
          <span className="num text-[11px] text-fg-muted">{fr("4 min")}</span>
        </div>
        <div className="mt-3 flex items-center gap-2.5 rounded-xl bg-white/[0.04] p-2.5">
          <CornerUpRight className="size-5 shrink-0 text-brand" />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold leading-tight">{fr("Dans 300 m, à droite")}</p>
            <p className="truncate text-[11.5px] text-fg-muted">Rue de Rivoli</p>
          </div>
        </div>
        <div className="relative mt-3 h-11 overflow-hidden rounded-xl bg-brand/12">
          <span className="absolute inset-y-1 left-1 grid w-12 place-items-center rounded-lg bg-brand text-[15px] font-bold text-brand-fg">›</span>
          <span className="absolute inset-0 grid place-items-center pl-10 text-[12.5px] font-semibold text-brand">Je suis arrivé</span>
        </div>
      </div>
    </div>
  );
}

/** Offre reçue par le chauffeur (mode centrale : sa part affichée avant d'accepter). */
export function DriverOfferVisual() {
  return (
    <div aria-hidden className="mx-auto w-full max-w-[250px] rounded-[26px] border border-line-strong bg-ink-950 p-2.5 shadow-[0_24px_60px_-30px_rgb(0_0_0/0.9)]">
      <div className="rounded-[18px] border border-line bg-ink-850 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-brand">Nouvelle course</span>
          <span className="num text-[10.5px] text-fg-muted">#1928</span>
        </div>
        <p className="mt-2 text-[13px] font-medium">La Défense → Paris CDG</p>
        <div className="mt-2 flex items-end justify-between gap-2">
          <span className="text-[11px] text-fg-muted">{fr("À 1,8 km")}</span>
          <span className="num text-[20px] font-semibold tracking-tight">{fr("65 €")}</span>
        </div>
        <div className="mt-2.5 grid h-9 place-items-center rounded-xl bg-brand text-[12px] font-bold tracking-wide text-brand-fg">ACCEPTER</div>
      </div>
    </div>
  );
}

/** Répartition d'une course (mode centrale) et suivi du règlement. */
export function CentraleVisual() {
  const parts = [
    { label: "Part chauffeur", cents: 4000, className: "bg-brand" },
    { label: "Commission de la centrale", cents: 1400, className: "bg-blue" },
    { label: "Frais plateforme", cents: 500, className: "bg-violet" },
  ];
  const total = parts.reduce((s, p) => s + p.cents, 0);
  const steps = [SETTLEMENT_STATUS_META.due.label, SETTLEMENT_STATUS_META.declared.label, SETTLEMENT_STATUS_META.paid.label];
  const methods = (["link", "transfer", "cash"] as const).map((m) => SETTLEMENT_METHOD_META[m].label);
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-ink-950/60 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12px] text-fg-muted">{fr("Exemple : course terminée, réglée à bord")}</span>
          <span className="num text-[20px] font-semibold tracking-tight">{formatPrice(total)}</span>
        </div>
        <div aria-hidden className="mt-3 flex h-2.5 gap-1 overflow-hidden rounded-full">
          {parts.map((p) => (
            <span key={p.label} className={cn("h-full rounded-full", p.className)} style={{ flexGrow: p.cents }} />
          ))}
        </div>
        <ul className="mt-3 grid gap-1.5 sm:grid-cols-3 sm:gap-3">
          {parts.map((p) => (
            <li key={p.label} className="flex items-center justify-between gap-3 text-[12.5px] sm:flex-col sm:items-start sm:gap-0.5">
              <span className="flex items-start gap-2 text-fg-muted">
                <span aria-hidden className={cn("mt-[5px] size-2 shrink-0 rounded-full", p.className)} />
                {p.label}
              </span>
              <span className="num text-fg sm:pl-4 sm:text-[15px] sm:font-semibold">{formatPrice(p.cents)}</span>
            </li>
          ))}
        </ul>
      </div>
      <ol aria-label="Suivi du règlement" className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {steps.map((s, i) => {
          const last = i === steps.length - 1;
          return (
            <li key={s} className="flex items-center gap-2 text-[13px]">
              <span
                aria-hidden
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold",
                  last ? "border-brand/60 bg-brand/15 text-brand" : "border-line-strong text-fg-muted",
                )}
              >
                {last ? <CircleCheck className="size-3" /> : i + 1}
              </span>
              <span className={last ? "text-fg" : "text-fg-muted"}>{s}</span>
              {!last && (
                <span aria-hidden className="ml-1 hidden h-px w-6 bg-line-strong sm:block" />
              )}
            </li>
          );
        })}
      </ol>
      <ul aria-label="Moyens de paiement proposés au chauffeur" className="flex flex-wrap gap-1.5">
        {methods.map((m) => (
          <li key={m}>
            <Chip>{m}</Chip>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Relance de commission : message du modèle WhatsApp officiel, rempli avec un exemple. */
export function ReminderVisual() {
  const { text, sample } = WHATSAPP_TEMPLATES.driver;
  const values = [sample[0], sample[1], "votre centrale", sample[3]];
  const message = text.replace(/\{\{(\d)\}\}/g, (_, n: string) => values[Number(n) - 1] ?? "");
  return (
    <div className="space-y-3">
      <ul aria-label="Canaux de relance" className="flex flex-wrap gap-1.5">
        <li>
          <Chip className="border-brand/40 text-fg">
            <Smartphone aria-hidden className="size-3.5 text-brand" /> Application
          </Chip>
        </li>
        <li>
          <Chip>
            <MessagesSquare aria-hidden className="size-3.5" /> WhatsApp
          </Chip>
        </li>
        <li>
          <Chip>Les deux</Chip>
        </li>
      </ul>
      <p className="rounded-2xl rounded-tl-md border border-line bg-ink-950/70 p-3 text-[12.5px] leading-relaxed text-fg-muted">
        <span className="sr-only">{fr("Exemple de relance : ")}</span>
        {fr(message)}
      </p>
    </div>
  );
}

/** Détail du vol d'une course (fiche course) : vol retardé, horaires, prise en charge décalée d'autant. */
export function FlightVisual() {
  const rows: [string, ReactNode][] = [
    ["Arrivée prévue", <span key="p">14:20</span>],
    ["Arrivée estimée", <span key="e" className="font-semibold text-fg">14:55</span>],
    ["Terminal", <span key="t">2E</span>],
    [
      "Prise en charge",
      <span key="c" className="inline-flex items-baseline gap-1.5">
        <s className="text-fg-subtle">14:50</s>
        <span className="font-semibold text-amber">15:25</span>
        <span className="text-[11px] text-fg-subtle">{fr("(+35 min)")}</span>
      </span>,
    ],
  ];
  return (
    <div aria-hidden className="overflow-hidden rounded-xl border border-line bg-ink-950/60">
      <div className="flex items-center gap-2.5 bg-amber/12 px-3.5 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-ink-900/40 text-amber">
          <Plane className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold tracking-tight text-fg">
            Vol AF1234 <span className="font-normal text-fg-muted">· de New York</span>
          </p>
          <p className="text-[11.5px] font-medium text-amber">{fr("Retardé · +35 min")}</p>
        </div>
      </div>
      <div className="divide-y divide-line px-3.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3 py-1.5">
            <span className="shrink-0 text-[11.5px] text-fg-muted">{k}</span>
            <span className="num text-[12.5px] text-fg-muted">{v}</span>
          </div>
        ))}
      </div>
      <p className="border-t border-line px-3.5 py-2 text-[11px] text-fg-muted">{fr("La prise en charge suit l'arrivée du vol ; le chauffeur est prévenu.")}</p>
    </div>
  );
}

const ALERT_ICONS: Record<keyof typeof RIDE_ALERT_META, LucideIcon> = {
  late: ClockAlert,
  stalled: CirclePause,
  no_gps: SatelliteDish,
  not_started: TimerOff,
};

/** Alerte de suivi telle qu'elle s'affiche au tableau de bord, décisions possibles, et les quatre types d'alerte. */
export function AlertsVisual() {
  const action = "inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12px]";
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-amber/30 bg-ink-950/60 p-3.5">
        <div aria-hidden className="flex items-start gap-2.5">
          <ClockAlert className="mt-0.5 size-4 shrink-0 text-amber" />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-amber">{RIDE_ALERT_META.late.label}</p>
            <p className="num text-[11.5px] text-fg-muted">{fr("Course #1928 · il y a 6 min")}</p>
          </div>
        </div>
        <p className="sr-only">{fr("Décisions possibles : relancer la recherche, réattribuer la course ou garder le chauffeur.")}</p>
        <div aria-hidden className="mt-3 flex flex-wrap gap-1.5">
          <span className={cn(action, "bg-brand font-semibold text-brand-fg")}>
            <RotateCw className="size-3.5" /> Relancer
          </span>
          <span className={cn(action, "bg-white/[0.08] font-medium text-fg")}>
            <UserCog className="size-3.5" /> Réattribuer
          </span>
          <span className={cn(action, "font-medium text-fg-muted")}>Garder</span>
        </div>
      </div>
      <ul aria-label="Types d'alerte" className="flex flex-wrap gap-1.5">
        {(Object.keys(ALERT_ICONS) as (keyof typeof ALERT_ICONS)[]).map((k) => {
          const Icon = ALERT_ICONS[k];
          return (
            <li key={k}>
              <Chip>
                <Icon aria-hidden className={cn("size-3.5", k === "late" || k === "not_started" ? "text-amber" : "text-red")} />
                {RIDE_ALERT_META[k].short}
              </Chip>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Règles de la centrale vues par le chauffeur : carte « Courses bloquées » de l'écran Commissions de l'app (cadenas
 * et titre rouges, message du blocage « commission en retard »), puis niveaux de confiance.
 */
export function TrustVisual() {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-ink-950/60 p-3.5">
        <p className="flex items-center gap-2 text-[12.5px] font-semibold text-red">
          <Lock aria-hidden className="size-4 shrink-0" />
          Courses bloquées
        </p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-fg-muted">
          <span className="sr-only">{fr("Message affiché au chauffeur : ")}</span>
          {fr(DRIVER_BLOCKER_META.unpaid.message)}
        </p>
      </div>
      <ul aria-label="Niveaux de confiance des chauffeurs" className="grid gap-2 sm:grid-cols-2">
        {(["new", "trusted"] as const).map((k) => (
          <li key={k} className="rounded-xl border border-line bg-ink-950/50 px-3 py-2.5">
            <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg">
              <span aria-hidden className={cn("size-1.5 rounded-full", DOT[TRUST_LEVEL_META[k].tone])} />
              {TRUST_LEVEL_META[k].label}
            </span>
            <span className="mt-0.5 block text-[11.5px] leading-snug text-fg-muted">{fr(TRUST_LEVEL_META[k].description)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Signalements de route (accident, bouchon, travaux, danger). */
function ReportsVisual() {
  const reports = [
    { key: "accident", icon: CarFront, tone: "text-amber" },
    { key: "traffic", icon: Construction, tone: "text-amber" },
    { key: "danger", icon: TriangleAlert, tone: "text-red" },
  ] as const;
  return (
    <ul aria-label="Exemples de signalements" className="flex flex-wrap gap-1.5">
      {reports.map(({ key, icon: Icon, tone }) => (
        <li key={key}>
          <Chip>
            <Icon aria-hidden className={cn("size-3.5", tone)} />
            {FLEET_REPORT_META[key].label}
          </Chip>
        </li>
      ))}
    </ul>
  );
}

/** Messagerie centrale ⇄ chauffeur (exemple) et signalements de route partagés. */
export function MessagesVisual() {
  return (
    <div className="space-y-3">
      <div aria-hidden className="space-y-2 rounded-xl border border-line bg-ink-950/60 p-3">
        <p className="max-w-[85%] rounded-2xl rounded-tl-md bg-white/[0.05] px-3 py-2 text-[12.5px] leading-snug text-fg">
          <span className="block text-[10.5px] font-medium text-fg-muted">Centrale</span>
          {fr("Course #1928 : le client attend porte 6.")}
        </p>
        <p className="chat-bubble--me ml-auto max-w-[70%] rounded-2xl rounded-tr-md px-3 py-2 text-[12.5px] leading-snug">{fr("Bien reçu, j'arrive.")}</p>
      </div>
      <ReportsVisual />
    </div>
  );
}

/** Arrivée d'un chauffeur par le lien d'inscription (flotte ou centrale) : candidature, vérification, validation. */
export function OnboardingVisual() {
  const steps: { icon: LucideIcon; label: string }[] = [
    { icon: Link2, label: "Lien d'inscription partagé" },
    { icon: FileUp, label: "Candidature et documents" },
    { icon: ShieldCheck, label: "Vérification par la centrale" },
    { icon: UserCheck, label: "Chauffeur validé" },
  ];
  return (
    <ol aria-label="Inscription d'un chauffeur par le lien d'inscription" className="space-y-1.5">
      {steps.map(({ icon: Icon, label }, i) => {
        const last = i === steps.length - 1;
        return (
          <li
            key={label}
            className={cn(
              "flex items-center gap-3 rounded-xl border px-3 py-2.5 text-[12.5px]",
              last ? "border-brand/40 bg-brand/[0.07] text-fg" : "border-line bg-ink-950/50 text-fg-muted",
            )}
          >
            <span className="num w-4 shrink-0 text-[11px] text-fg-muted">{i + 1}</span>
            <Icon aria-hidden className={cn("size-4 shrink-0", last ? "text-brand" : "text-fg-muted")} />
            {fr(label)}
          </li>
        );
      })}
    </ol>
  );
}

/** Isolation des centrales en base (la vôtre, cloisonnée des autres) et garanties de sécurité et de conformité. */
export function SecurityVisual() {
  const items: [LucideIcon, string][] = [
    [Lock, "Isolation par centrale en base"],
    [KeyRound, "Clés d'API hachées"],
    [ScrollText, "Journal d'audit"],
    [Globe, "Hébergement dans l'UE"],
    [FileCheck2, "Accord de traitement (DPA)"],
    [Download, "Export CSV sur demande"],
  ];
  const bar = "h-1.5 rounded-full bg-white/[0.07]";
  return (
    <div className="space-y-5">
      {/* Trois centrales cloisonnées : seule la vôtre est lisible */}
      <div aria-hidden className="grid grid-cols-3 gap-2 sm:gap-3">
        {["Votre centrale", "Centrale B", "Centrale C"].map((name, i) => (
          <div
            key={name}
            className={cn("rounded-xl border p-2.5 sm:p-3.5", i === 0 ? "border-brand/40 bg-brand/[0.06]" : "border-line bg-ink-950/50 opacity-60")}
          >
            <p className="flex flex-col items-start gap-1 text-[11px] font-semibold leading-tight sm:flex-row sm:items-center sm:gap-1.5 sm:text-[12px]">
              <Lock className={cn("size-3.5 shrink-0", i === 0 ? "text-brand" : "text-fg-muted")} />
              <span className={i === 0 ? "text-fg" : "text-fg-muted"}>{name}</span>
            </p>
            {i === 0 ? (
              <ul className="mt-2.5 space-y-1 text-[10.5px] text-fg-muted sm:text-[11.5px]">
                <li>Courses</li>
                <li>Clients</li>
                <li>Chauffeurs</li>
              </ul>
            ) : (
              <div className="mt-3 space-y-2">
                <div className={cn(bar, "w-4/5")} />
                <div className={cn(bar, "w-3/5")} />
                <div className={cn(bar, "w-2/3")} />
              </div>
            )}
          </div>
        ))}
      </div>
      <ul className="grid gap-x-4 gap-y-2.5 sm:grid-cols-2">
        {items.map(([Icon, label]) => (
          <li key={label} className="flex items-center gap-2.5 text-[13px] text-fg-muted">
            <Icon aria-hidden className="size-4 shrink-0 text-brand" />
            {fr(label)}
          </li>
        ))}
      </ul>
    </div>
  );
}
