import {
  AppWindow,
  BellRing,
  CalendarCheck,
  Check,
  ClockAlert,
  HandCoins,
  LayoutDashboard,
  Map as MapIcon,
  MessagesSquare,
  PlaneLanding,
  Radar,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  UserPlus,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import styles from "./landing.module.css";
import { Section, SectionHeading } from "./section";
import {
  AlertsVisual,
  BookingSiteVisual,
  CentraleVisual,
  DriverAppVisual,
  DriverOfferVisual,
  FlightVisual,
  MapVisual,
  MessagesVisual,
  NewRideVisual,
  OnboardingVisual,
  ReminderVisual,
  SecurityVisual,
  TrustVisual,
  WavesVisual,
} from "./service-visuals";
import { fr } from "./typo";

const link = "text-fg underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-brand";

/** Thèmes de la page Services (ancres reprises par l'accueil et le pied de page). */
const SERVICE_THEMES = [
  { id: "reservations", label: "Réservations", icon: CalendarCheck },
  { id: "dispatch", label: "Dispatch", icon: Radar },
  { id: "chauffeurs", label: "Chauffeurs", icon: Smartphone },
  { id: "commissions", label: "Commissions", icon: HandCoins },
  { id: "securite", label: "Sécurité et RGPD", icon: ShieldCheck },
  { id: "fonctionnement", label: "Fonctionnement", icon: Workflow },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon }[];

/** Sommaire de la page : une puce par thème. */
export function ServicesNav() {
  return (
    <nav aria-label="Thèmes de la page">
      <ul className="flex flex-wrap gap-2">
        {SERVICE_THEMES.map(({ id, label, icon: Icon }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-line-strong bg-white/[0.03] px-4 text-[13.5px] text-fg-muted transition-colors hover:border-brand/40 hover:text-fg"
            >
              <Icon aria-hidden className="size-4 text-brand" />
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Surtitre numéroté d'un thème (« 01 · Réservations »). */
export function ThemeEyebrow({ index, label }: { index: number; label: string }) {
  return (
    <>
      <span className="num">{String(index).padStart(2, "0")}</span>
      <span aria-hidden className="mx-2 text-brand/50">
        ·
      </span>
      {label}
    </>
  );
}

/** Section d'un thème : numéro, titre (h2), introduction, puis ses blocs. */
function Theme({
  id,
  index,
  eyebrow,
  title,
  intro,
  tinted,
  children,
}: {
  id: string;
  index: number;
  eyebrow: string;
  title: string;
  intro: string;
  tinted?: boolean;
  children: ReactNode;
}) {
  return (
    <Section id={id} labelledBy={`${id}-titre`} className={cn(tinted && "border-y border-line bg-ink-950/40")} inner="py-16 sm:py-24">
      <SectionHeading
        id={`${id}-titre`}
        eyebrow={<ThemeEyebrow index={index} label={eyebrow} />}
        title={fr(title)}
        intro={fr(intro)}
      />
      <div className="mt-12 space-y-8 sm:mt-14 lg:space-y-10">{children}</div>
    </Section>
  );
}

/** Scène d'un visuel : fond grille et lueur discrète, pour des visuels de natures différentes. */
function Stage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-3xl border border-line bg-ink-850 p-4 sm:p-8", className)}>
      <div aria-hidden className="grid-bg pointer-events-none absolute inset-0 opacity-70 [mask-image:radial-gradient(ellipse_at_top,black,transparent_75%)]" />
      <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-brand/[0.06] blur-3xl" />
      <div className="relative">{children}</div>
    </div>
  );
}

/** Liste de bénéfices concrets. */
function Points({ items }: { items: ReactNode[] }) {
  return (
    <ul className="mt-6 space-y-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-[14.5px] leading-relaxed text-fg">
          <span aria-hidden className="mt-[3px] grid size-5 shrink-0 place-items-center rounded-full bg-brand/12">
            <Check className="size-3 text-brand" />
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Bloc principal d'un thème, en deux colonnes : texte (titre h3, description, bénéfices) et visuel, côtés alternés.
 * `wide` : visuel plus large que le texte (tableaux de chiffres).
 */
function Feature({
  icon: Icon,
  title,
  text,
  points,
  visual,
  reverse,
  wide,
  footer,
}: {
  icon: LucideIcon;
  title: string;
  text: string;
  points: ReactNode[];
  visual: ReactNode;
  reverse?: boolean;
  wide?: boolean;
  footer?: ReactNode;
}) {
  const columns = !wide ? "lg:grid-cols-2" : reverse ? "lg:grid-cols-[1.2fr_0.8fr]" : "lg:grid-cols-[0.8fr_1.2fr]";
  return (
    <article className={cn("grid items-center gap-8 lg:gap-14", columns)}>
      <div className={cn(styles.reveal, reverse && "lg:order-2")}>
        <span className="grid size-11 place-items-center rounded-xl border border-line bg-white/[0.03]">
          <Icon aria-hidden className="size-5 text-brand" />
        </span>
        <h3 className="mt-5 text-[22px] font-semibold leading-tight tracking-[-0.02em] sm:text-[26px]">{fr(title)}</h3>
        <p className="mt-3 max-w-xl text-pretty text-[15.5px] leading-relaxed text-fg-muted">{fr(text)}</p>
        <Points items={points} />
        {footer && <div className="mt-6 text-[14px] text-fg-muted">{footer}</div>}
      </div>
      <Stage className={cn(styles.reveal, reverse && "lg:order-1")}>{visual}</Stage>
    </article>
  );
}

/**
 * Bloc secondaire d'un thème : carte avec son visuel en haut, dans une zone de hauteur commune (les titres de deux
 * cartes voisines restent alignés), puis titre (h3) et texte. Le texte précède le visuel dans le document.
 */
function Card({ icon: Icon, title, text, children }: { icon: LucideIcon; title: string; text: string; children: ReactNode }) {
  return (
    <article className={cn("surface flex flex-col overflow-hidden rounded-3xl", styles.reveal)}>
      <div className="p-6 sm:p-7">
        <div className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.03]">
            <Icon aria-hidden className="size-[18px] text-brand" />
          </span>
          <h3 className="text-[17px] font-semibold tracking-tight">{fr(title)}</h3>
        </div>
        <p className="mt-3 text-pretty text-[14.5px] leading-relaxed text-fg-muted">{fr(text)}</p>
      </div>
      <div className="relative order-first grid place-items-center border-b border-line bg-ink-850 p-5 sm:min-h-[296px] sm:p-7">
        <div aria-hidden className="grid-bg pointer-events-none absolute inset-0 opacity-70 [mask-image:radial-gradient(ellipse_at_top,black,transparent_80%)]" />
        <div className="relative w-full max-w-[440px]">{children}</div>
      </div>
    </article>
  );
}

/** Deux téléphones du chauffeur : offre reçue, puis guidage, légèrement décalés (l'offre seule sur petit écran). */
function DriverPhones() {
  return (
    <>
      <div className="mx-auto w-full max-w-[250px] sm:hidden">
        <DriverOfferVisual />
      </div>
      <div className="relative mx-auto hidden h-[290px] w-full max-w-[480px] sm:block">
        <div className="absolute left-0 top-0 w-[240px]">
          <DriverOfferVisual />
        </div>
        <div className="absolute bottom-0 right-0 w-[240px]">
          <DriverAppVisual />
        </div>
      </div>
    </>
  );
}

/** Contenu de la page Services, par thème. */
export function ServiceThemes() {
  return (
    <>
      <Theme
        id="reservations"
        index={1}
        eyebrow="Réservations"
        title="Recevoir les courses"
        intro="Mini-site à vos couleurs, votre propre site ou le tableau de bord : toutes les réservations arrivent au même endroit, prêtes à partir au dispatch."
      >
        <Feature
          icon={AppWindow}
          title="Un mini-site de réservation à vos couleurs"
          text="Vos clients réservent en ligne, sans compte ni application : départ, destination, date, et une estimation du prix avant de valider."
          points={[
            fr("Votre nom, votre logo, votre couleur principale et votre photo de fond."),
            fr("En ligne sur votre sous-domaine ou sur votre propre domaine."),
            fr("Devis instantané : trajet et prix estimé selon votre grille tarifaire, si vous l'affichez."),
            fr("Vous avez déjà un site ? Reliez-le par l'API, ou affichez-y le formulaire de réservation."),
          ]}
          visual={<BookingSiteVisual />}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Card
            icon={LayoutDashboard}
            title="Saisie au tableau de bord"
            text="Téléphone, hôtel, conciergerie : votre équipe saisit la course en quelques secondes, immédiate ou planifiée. Le trajet, le prix et les chauffeurs disponibles sont calculés en direct."
          >
            <NewRideVisual />
          </Card>
          <Card
            icon={PlaneLanding}
            title="Suivi des vols"
            text="Prise en charge à l'aéroport : le vol est suivi, l'heure de prise en charge suit le retard et le chauffeur est prévenu."
          >
            <FlightVisual />
          </Card>
        </div>
      </Theme>

      <Theme
        id="dispatch"
        index={2}
        tinted
        eyebrow="Dispatch"
        title="Le dispatch tourne seul, jour et nuit."
        intro="Chaque course est proposée à vos chauffeurs les plus proches, puis élargie rayon après rayon. Vous gardez la main à tout moment."
      >
        <Feature
          reverse
          wide
          icon={Radar}
          title="Dispatch par vagues"
          text="Chaque course est d'abord proposée à vos chauffeurs à moins de 4 km, puis à 8, 12 et 16 km. Seuls ceux qui sont en ligne, disponibles et au véhicule compatible la reçoivent."
          points={[
            fr("Le premier qui accepte obtient la course ; les autres offres se ferment aussitôt."),
            fr("Un seul chauffeur par course : l'attribution est verrouillée en base."),
            fr("Sans preneur, une relance repart à 4 puis 8 km, puis une alerte vous explique pourquoi."),
            fr("Rayons et délais réglables, attribution automatique ou manuelle."),
          ]}
          visual={<WavesVisual />}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Card
            icon={MapIcon}
            title="Carte en temps réel"
            text="Votre command center : toute la flotte en direct, le statut de chaque chauffeur, les recherches en cours et l'itinéraire des courses."
          >
            <MapVisual />
          </Card>
          <Card
            icon={ClockAlert}
            title="Alertes de suivi"
            text="Retard, chauffeur immobile, GPS muet, course pas démarrée : l'alerte s'affiche en direct et vous décidez de la suite."
          >
            <AlertsVisual />
          </Card>
        </div>
      </Theme>

      <Theme
        id="chauffeurs"
        index={3}
        eyebrow="Chauffeurs"
        title="Vos chauffeurs, équipés et joignables."
        intro="Des courses proches, sans rester collé aux groupes : l'application fait sonner l'offre, guide jusqu'au client et affiche les gains."
      >
        <Feature
          icon={Smartphone}
          title="App chauffeur iOS & Android"
          text="L'offre sonne même téléphone verrouillé, avec départ, destination et prix (ou la part du chauffeur) avant d'accepter."
          points={[
            fr("Guidage intégré jusqu'au client, ou dans Waze, Google Maps ou Plans selon le téléphone."),
            fr("Planning des réservations et rappels avant chaque course."),
            fr("Gains du jour et de la semaine, commissions claires, règlement en un geste."),
            fr("Position envoyée seulement en ligne ou en course."),
          ]}
          visual={<DriverPhones />}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Card
            icon={MessagesSquare}
            title="Messagerie et signalements"
            text="Messages entre la centrale et chaque chauffeur, fil de la flotte modéré par la centrale, signalements de route géolocalisés (accident, bouchon, travaux…) partagés entre vos chauffeurs."
          >
            <MessagesVisual />
          </Card>
          <Card
            icon={UserPlus}
            title="Arrivée des chauffeurs"
            text="Vous créez le compte du chauffeur ou l'invitez par e-mail. En mode centrale, partagez aussi votre lien d'inscription : le chauffeur dépose sa candidature et ses documents, vous vérifiez avant de le valider."
          >
            <OnboardingVisual />
          </Card>
        </div>
      </Theme>

      <Theme
        id="commissions"
        index={4}
        tinted
        eyebrow="Commissions"
        title="Commissions calculées, suivies et relancées."
        intro="Pour les réseaux de chauffeurs indépendants, le mode centrale à commission suit chaque course jusqu'à l'encaissement."
      >
        <Feature
          reverse
          wide
          icon={HandCoins}
          title="Centrale à commission"
          text="La part du chauffeur s'affiche dans l'offre, la commission est calculée à chaque course et chaque règlement est suivi jusqu'à l'encaissement."
          points={[
            fr("Commission calculée automatiquement, ou saisie à la main pour une course."),
            fr("Moyens proposés au chauffeur : lien de paiement, virement ou espèces, selon ce que vous renseignez."),
            fr("Rydar n'encaisse pas le prix des courses et ne détient aucun fonds pour votre compte."),
          ]}
          visual={<CentraleVisual />}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Card
            icon={BellRing}
            title="Relances automatiques"
            text="Commission en retard : relance par l'application, par WhatsApp (API officielle de Meta) ou les deux. Si WhatsApp est impossible, l'application prend le relais."
          >
            <ReminderVisual />
          </Card>
          <Card
            icon={ShieldAlert}
            title="Retards, plafonds et bannissements"
            text="Les retardataires sont bloqués automatiquement jusqu'au règlement (réglage activé par défaut). Vous pouvez aussi fixer un plafond d'encours, plafonner le prix des courses des nouveaux chauffeurs et bannir définitivement un fraudeur."
          >
            <TrustVisual />
          </Card>
        </div>
      </Theme>

      <Theme
        id="securite"
        index={5}
        eyebrow="Sécurité et RGPD"
        title="Vos données, isolées et protégées."
        intro="Chaque centrale est isolée des autres, les accès sont contrôlés en base et les actions sensibles journalisées."
      >
        <Feature
          icon={ShieldCheck}
          title="Un sous-traitant encadré"
          text="Rydar Drive traite les données de votre centrale pour votre compte : un accord de traitement des données encadre cette sous-traitance au sens du RGPD."
          points={[
            fr("Données hébergées dans l'Union européenne."),
            fr("Rôles d'équipe : propriétaire, administrateur ou dispatcher, chacun avec ses accès."),
            fr("Position des chauffeurs envoyée seulement en ligne ou en course."),
            fr("Export de vos données au format CSV sur demande, avant la fin du contrat."),
          ]}
          footer={
            <Link href="/dpa" className={link}>
              Lire l&apos;accord de traitement des données (DPA)
            </Link>
          }
          visual={<SecurityVisual />}
        />
      </Theme>
    </>
  );
}
