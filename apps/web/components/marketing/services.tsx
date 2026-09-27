import {
  FLEET_REPORT_META,
  formatPrice,
  PRESENCE_META,
  RIDE_ALERT_META,
  SETTLEMENT_METHOD_META,
  SETTLEMENT_STATUS_META,
  WHATSAPP_TEMPLATES,
  type Tone,
} from "@rydar/shared";
import {
  BellRing,
  CarFront,
  CircleCheck,
  CirclePause,
  ClockAlert,
  CodeXml,
  Construction,
  CornerUpRight,
  FileCheck2,
  Globe,
  HandCoins,
  KeyRound,
  Lock,
  Map as MapIcon,
  MessagesSquare,
  PlaneLanding,
  Radar,
  SatelliteDish,
  ScrollText,
  ShieldCheck,
  Smartphone,
  TimerOff,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import styles from "./landing.module.css";
import { Section, SectionHeading } from "./section";
import { fr } from "./typo";

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

function Card({
  icon: Icon,
  title,
  text,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  text: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <article
      className={cn(
        "surface group relative flex flex-col overflow-hidden rounded-2xl p-6 transition-colors duration-300 hover:border-white/[0.12]",
        styles.reveal,
        className,
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-brand/50 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
      />
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.03]">
          <Icon className="size-[18px] text-brand" aria-hidden />
        </span>
        <h3 className="text-[16px] font-semibold tracking-tight">{title}</h3>
      </div>
      <p className="mt-3 text-[14px] leading-relaxed text-fg-muted">{fr(text)}</p>
      {children && <div className="mt-6 flex flex-1 flex-col justify-end">{children}</div>}
    </article>
  );
}

function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border border-line bg-white/[0.03] px-2.5 py-1 text-[12px] text-fg-muted", className)}>
      {children}
    </span>
  );
}

/** Vagues 4 → 8 → 12 → 16 km, relance, puis alerte (délais et rayons par défaut). */
function WavesVisual() {
  const waves = [4, 8, 12, 16];
  return (
    <div>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {waves.map((km, i) => (
          <li
            key={km}
            className={cn("rounded-xl border px-3 py-3", styles.waveStep)}
            style={{ "--i": i } as CSSProperties}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-muted">Vague {i + 1}</span>
              <span aria-hidden className={cn("size-2 rounded-full bg-brand shadow-[0_0_10px_rgb(200_240_60/0.8)]", styles.waveDot)} />
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
function MapVisual() {
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
function DriverAppVisual() {
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

/** Répartition d'une course (mode centrale) et suivi du règlement. */
function CentraleVisual() {
  const parts = [
    { label: "Part chauffeur", cents: 4000, className: "bg-brand" },
    { label: "Commission de la centrale", cents: 1400, className: "bg-blue" },
    { label: "Frais plateforme", cents: 500, className: "bg-violet" },
  ];
  const total = parts.reduce((s, p) => s + p.cents, 0);
  const steps = [SETTLEMENT_STATUS_META.due.label, SETTLEMENT_STATUS_META.declared.label, SETTLEMENT_STATUS_META.paid.label];
  const methods = (["link", "transfer", "cash"] as const).map((m) => SETTLEMENT_METHOD_META[m].label);
  return (
    <div className="grid gap-5 lg:grid-cols-[1.25fr_1fr]">
      <div className="rounded-xl border border-line bg-ink-950/60 p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] text-fg-muted">Exemple : course terminée, réglée à bord</span>
          <span className="num text-[20px] font-semibold tracking-tight">{formatPrice(total)}</span>
        </div>
        <div aria-hidden className="mt-3 flex h-2.5 gap-1 overflow-hidden rounded-full">
          {parts.map((p) => (
            <span key={p.label} className={cn("h-full rounded-full", p.className)} style={{ flexGrow: p.cents }} />
          ))}
        </div>
        <ul className="mt-3 space-y-1.5">
          {parts.map((p) => (
            <li key={p.label} className="flex items-center justify-between text-[12.5px]">
              <span className="flex items-center gap-2 text-fg-muted">
                <span aria-hidden className={cn("size-2 rounded-full", p.className)} />
                {p.label}
              </span>
              <span className="num text-fg">{formatPrice(p.cents)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col justify-between gap-4">
        <ol aria-label="Suivi du règlement" className="space-y-2">
          {steps.map((s, i) => (
            <li key={s} className="flex items-center gap-2.5 text-[13px]">
              <span
                aria-hidden
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold",
                  i === steps.length - 1 ? "border-brand/60 bg-brand/15 text-brand" : "border-line-strong text-fg-muted",
                )}
              >
                {i === steps.length - 1 ? <CircleCheck className="size-3" /> : i + 1}
              </span>
              <span className={i === steps.length - 1 ? "text-fg" : "text-fg-muted"}>{s}</span>
            </li>
          ))}
        </ol>
        <ul aria-label="Moyens de paiement proposés au chauffeur" className="flex flex-wrap gap-1.5">
          {methods.map((m) => (
            <li key={m}>
              <Chip>{m}</Chip>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Relance de commission : message du modèle WhatsApp officiel, rempli avec un exemple. */
function ReminderVisual() {
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
        <span className="sr-only">Exemple de relance : </span>
        {fr(message)}
      </p>
    </div>
  );
}

function ApiVisual() {
  return (
    <pre aria-hidden className="mono overflow-hidden rounded-xl border border-line bg-ink-950/80 p-3.5 text-[11.5px] leading-relaxed text-fg-muted">
      <span className="text-brand">POST</span> /api/v1/rides{"\n"}
      Authorization: Bearer rdk_live_…{"\n"}
      <span className="text-green">201</span> Created · <span className="text-fg">#1928</span>
    </pre>
  );
}

function FlightVisual() {
  return (
    <div aria-hidden className="rounded-xl border border-line bg-ink-950/60 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="mono text-[13px] font-semibold">AF1234</span>
        <span className="rounded-full bg-amber/12 px-2 py-0.5 text-[11.5px] font-medium text-amber">{fr("Retardé · +35 min")}</span>
      </div>
      <div className="mt-3 flex items-center gap-2 text-[12.5px] text-fg-muted">
        <PlaneLanding className="size-4 text-fg-muted" />
        <span>Prise en charge</span>
        <span className="num text-fg-muted line-through">14:50</span>
        <span className="num font-semibold text-fg">15:25</span>
      </div>
    </div>
  );
}

function AlertsVisual() {
  const icons: Record<keyof typeof RIDE_ALERT_META, LucideIcon> = {
    late: ClockAlert,
    stalled: CirclePause,
    no_gps: SatelliteDish,
    not_started: TimerOff,
  };
  return (
    <div className="space-y-3">
      <ul aria-label="Alertes" className="flex flex-wrap gap-1.5">
        {(Object.keys(icons) as (keyof typeof icons)[]).map((k) => {
          const Icon = icons[k];
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
      <p className="text-[12.5px] text-fg-muted">
        <span className="sr-only">Actions possibles : </span>Garder · Réattribuer · Relancer la recherche
      </p>
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

function SecurityVisual() {
  const items: [LucideIcon, string][] = [
    [Lock, "Isolation par centrale en base"],
    [KeyRound, "Clés d'API hachées"],
    [ScrollText, "Journal d'audit"],
    [Globe, "Hébergement dans l'UE"],
    [FileCheck2, "Accord de traitement (DPA)"],
  ];
  return (
    <ul className="space-y-2">
      {items.map(([Icon, label]) => (
        <li key={label} className="flex items-center gap-2.5 text-[13px] text-fg-muted">
          <Icon aria-hidden className="size-4 shrink-0 text-brand" />
          {fr(label)}
        </li>
      ))}
    </ul>
  );
}

export function Services() {
  return (
    <Section id="services" labelledBy="services-titre">
      <SectionHeading
        id="services-titre"
        eyebrow="Services"
        title={fr("Tout pour faire tourner votre centrale, de la réservation au règlement.")}
        intro={fr("Un seul outil pour recevoir vos courses, les dispatcher, suivre vos chauffeurs et le règlement de vos commissions.")}
      />
      <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Card
          icon={Radar}
          title="Dispatch par vagues"
          text="Chaque course est d'abord proposée à vos chauffeurs à moins de 4 km, puis à 8, 12 et 16 km. Seuls ceux qui sont en ligne, disponibles et au véhicule compatible la reçoivent. Rayons et délais sont réglables."
          className="md:col-span-2"
        >
          <WavesVisual />
        </Card>
        <Card
          icon={MapIcon}
          title="Carte en temps réel"
          text="Votre command center : toute la flotte en direct, le statut de chaque chauffeur, les recherches en cours et l'itinéraire des courses."
        >
          <MapVisual />
        </Card>
        <Card
          icon={Smartphone}
          title="App chauffeur iOS & Android"
          text="L'offre sonne même téléphone verrouillé, avec départ, destination et prix avant d'accepter. Guidage intégré jusqu'au client, ou dans Waze, Google Maps ou Plans selon le téléphone."
        >
          <DriverAppVisual />
        </Card>
        <Card
          icon={HandCoins}
          title="Centrale à commission"
          text="Pour les réseaux de chauffeurs indépendants : la part du chauffeur s'affiche dans l'offre, la commission est calculée à chaque course et chaque règlement est suivi jusqu'à l'encaissement. Par défaut, un chauffeur en retard de commission ne reçoit plus de nouvelles courses."
          className="md:col-span-2"
        >
          <CentraleVisual />
        </Card>
        <Card
          icon={BellRing}
          title="Relances automatiques"
          text="Commission en retard : relance par l'application, par WhatsApp (API officielle de Meta) ou les deux. Si WhatsApp est impossible, l'application prend le relais."
        >
          <ReminderVisual />
        </Card>
        <Card
          icon={CodeXml}
          title="Mini-site et API"
          text="Un mini-site de réservation à vos couleurs, sur votre sous-domaine ou votre domaine, avec devis instantané. Ou votre propre site, relié à l'API."
        >
          <ApiVisual />
        </Card>
        <Card
          icon={PlaneLanding}
          title="Suivi des vols"
          text="Prise en charge à l'aéroport : le vol est suivi, l'heure de prise en charge suit le retard et le chauffeur est prévenu."
        >
          <FlightVisual />
        </Card>
        <Card
          icon={ClockAlert}
          title="Alertes de suivi"
          text="Retard, chauffeur immobile, GPS muet, course pas démarrée : l'alerte s'affiche en direct et vous décidez de la suite."
        >
          <AlertsVisual />
        </Card>
        <Card
          icon={MessagesSquare}
          title="Messagerie et signalements"
          text="Messages entre la centrale et chaque chauffeur, fil de la flotte modéré par la centrale, signalements de route géolocalisés (accident, bouchon, travaux…) partagés entre vos chauffeurs."
        >
          <ReportsVisual />
        </Card>
        <Card
          icon={ShieldCheck}
          title="Sécurité et RGPD"
          text="Chaque centrale est isolée des autres, les accès sont contrôlés en base et les actions sensibles journalisées."
        >
          <SecurityVisual />
        </Card>
      </div>
    </Section>
  );
}
