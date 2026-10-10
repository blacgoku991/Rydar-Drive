"use client";
import { ORG_ROLE_LABELS, type OrgRole } from "@rydar/shared";
import {
  BarChart3, Building2, Check, ChevronsUpDown, CreditCard, Globe, KeyRound, LayoutDashboard, LogOut, Mail, Menu, MessageCircle, Radar,
  Route, ScrollText, Settings, ShieldCheck, Sparkles, UserPlus, UserX, Users,
} from "lucide-react";
import { ArrowLeftRight, CalendarDays, CarFront, HandCoins, House, Landmark, Waypoints } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Dialog as D } from "radix-ui";
import { Logo } from "@/components/brand/logo";
import { LegalLinks } from "@/components/legal/legal-links";
import {
  Avatar, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { NavLinkPending, NavProgress } from "./nav-pending";

const ICONS = {
  radar: Radar, route: Route, users: Users, scroll: ScrollText, chart: BarChart3, key: KeyRound, globe: Globe,
  settings: Settings, building: Building2, shield: ShieldCheck, card: CreditCard, sparkles: Sparkles, dashboard: LayoutDashboard,
  message: MessageCircle,
  // Mode centrale : Encaissements, Réseau ; flotte : Inscriptions (lien d'inscription des chauffeurs), Frais Rydar
  wallet: HandCoins, network: Waypoints, userPlus: UserPlus, landmark: Landmark,
  // Réseau partagé entre organisations (courses confiées / reçues)
  share: ArrowLeftRight,
  // Super admin : suppressions de comptes chauffeur, demandes du formulaire de contact
  userX: UserX, mail: Mail,
  // Flotte Privée : Accueil, Agenda, Mon profil chauffeur
  home: House, calendar: CalendarDays, car: CarFront,
};
export type NavIcon = keyof typeof ICONS;
/** Pastille de compteur : rouge (alertes, défaut), lime (messages), ambre. */
export type NavBadgeTone = "red" | "brand" | "amber";
export type NavItem = {
  href: string;
  label: string;
  icon: NavIcon;
  /** Actif seulement sur l'adresse exacte (accueil d'un espace) */
  exact?: boolean;
  /** Autres préfixes d'adresse qui rendent l'entrée active (pages regroupées sous une seule entrée) */
  match?: string[];
  badge?: number;
  badgeTone?: NavBadgeTone;
  /** Ce que compte la pastille, en toutes lettres (aria-label : « 3 signalements de fraude à examiner ») */
  badgeLabel?: string;
};
export type NavSection = {
  title: string;
  items: NavItem[];
};

const BADGE_TONE: Record<NavBadgeTone, string> = {
  red: "bg-red/15 text-red",
  brand: "bg-brand text-brand-fg",
  amber: "bg-amber/15 text-amber",
};

type Props = {
  sections: NavSection[];
  subtitle: string;
  user: { name: string; email: string };
  orgs?: { id: string; name: string; role: string }[];
  currentOrgId?: string;
  onSwitchOrg?: (id: string) => void;
  signOut: () => void;
  footer?: React.ReactNode;
  /** Information cookies (CookieNotice placement « sidebar ») : dans le flux, au-dessus du menu du compte. */
  notice?: React.ReactNode;
  /** Action à droite du logo (ex. cloche des notifications, badge « Super admin »). */
  headerAction?: React.ReactNode;
  /** Ligne sous le nom de l'organisation à la place du rôle (Flotte Privée : sidebarOrgCaption) ; absente : le rôle. */
  orgCaption?: string | null;
};

/** Entrée active : adresse exacte (exact), sinon l'adresse ou une sous-page, ou l'un des préfixes de `match`. */
export function navItemActive(item: Pick<NavItem, "href" | "exact" | "match">, pathname: string): boolean {
  if (item.exact) return pathname === item.href;
  return [item.href, ...(item.match ?? [])].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Initiale, nom et ligne dessous (rôle, ou sous-titre de la Flotte Privée) : bloc statique et sélecteur. */
function OrgSummary({ current, orgCaption }: { current: { name: string; role: string }; orgCaption?: string | null }) {
  return (
    <>
      <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-md bg-brand/15 text-[12px] font-bold text-brand">
        {current.name.slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-fg" title={current.name}>
          {current.name}
        </span>
        <span className="block truncate text-[12px] text-fg-subtle">{orgCaption ?? ORG_ROLE_LABELS[current.role as OrgRole] ?? current.role}</span>
      </span>
    </>
  );
}

/**
 * Contenu de la barre (bureau) et du tiroir (téléphone). Fixes : en-tête (logo, action), organisation, menu du compte.
 * UNE seule zone défilante entre les deux : menu, pied, information cookies, liens légaux (docs/REFONTE-PANELS.md § 3.1 :
 * à 1440×900 bandeau ouvert comme à 1366×768, tout le menu est visible sans défiler ; rien ne recouvre une entrée).
 */
function NavContent({
  sections, subtitle, user, orgs, currentOrgId, onSwitchOrg, signOut, footer, notice, headerAction, orgCaption, onNavigate, drawer = false,
}: Props & { onNavigate?: (href: string, event: React.MouseEvent) => void; drawer?: boolean }) {
  const pathname = usePathname() ?? "";
  const uid = useId();
  const current = orgs?.find((o) => o.id === currentOrgId);
  const home = sections[0]?.items[0]?.href ?? "/";
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 pl-5 pr-3">
        <Link href={home} prefetch={false} onClick={(e) => onNavigate?.(home, e)} title={subtitle}>
          <Logo size={24} />
        </Link>
        {headerAction}
      </div>

      {current && (
        <div className="shrink-0 px-3 pb-2">
          {(orgs?.length ?? 0) > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[0.04]">
                <OrgSummary current={current} orgCaption={orgCaption} />
                <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-fg-subtle group-hover:text-fg-muted" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[220px]">
                <DropdownMenuLabel>Organisations</DropdownMenuLabel>
                {orgs!.map((o) => (
                  <DropdownMenuItem key={o.id} onSelect={() => onSwitchOrg?.(o.id)}>
                    <span className="flex-1 truncate">{o.name}</span>
                    {o.id === currentOrgId && <Check className="!text-brand" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            // Un seul compte : rien à choisir, ni chevron ni menu
            <div className="flex items-center gap-2.5 px-2 py-2">
              <OrgSummary current={current} orgCaption={orgCaption} />
            </div>
          )}
        </div>
      )}

      <div data-sidebar-scroll="" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <nav aria-label="Menu principal" className="space-y-4 px-3 pb-4 pt-2">
          {sections.map((section, s) => (
            <div key={section.title}>
              <p id={`${uid}-section-${s}`} className="mb-1 px-2.5 text-[12px] text-fg-subtle">
                {section.title}
              </p>
              <ul aria-labelledby={`${uid}-section-${s}`} className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = ICONS[item.icon];
                  const active = navItemActive(item, pathname);
                  return (
                    <li key={item.href}>
                      {/* Sans préchargement : chaque lien visible relançait le rendu (et l'authentification) de sa page.
                          Si un app/dashboard/loading.tsx est ajouté, revenir au préchargement par défaut (squelette
                          instantané). Retour au clic : NavLinkPending (taille fixe, opacité seule). */}
                      <Link
                        href={item.href}
                        prefetch={false}
                        onClick={(e) => onNavigate?.(item.href, e)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "group relative flex items-center gap-2 rounded-lg px-2.5 transition-colors",
                          // Tiroir mobile : cibles de 44 px ; barre fixe : 32 px. Un libellé long (avec sa pastille)
                          // passe sur deux lignes au lieu d'être coupé : le texte entier reste lisible. Interligne APRÈS
                          // la taille (tailwind-merge retire un leading-* placé avant un text-*)
                          drawer ? "min-h-11 py-1 text-[15px] leading-tight" : "min-h-8 py-1 text-[13.5px] leading-tight",
                          active ? "bg-white/[0.07] font-medium text-fg" : "text-fg-muted hover:bg-white/[0.035] hover:text-fg",
                        )}
                      >
                        <NavLinkPending>
                          <Icon aria-hidden className={cn("size-4", active ? "text-brand" : "text-fg-subtle group-hover:text-fg-muted")} />
                        </NavLinkPending>
                        <span className="min-w-0 flex-1">{item.label}</span>
                        {!!item.badge && (
                          <span
                            className={cn(
                              "min-w-5 shrink-0 rounded-full px-1.5 text-center text-[12px] font-semibold leading-5 tabular-nums",
                              BADGE_TONE[item.badgeTone ?? "red"],
                            )}
                            aria-label={item.badgeLabel}
                          >
                            {item.badge > 99 ? "99+" : item.badge}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {footer && <div className="px-3 pb-3">{footer}</div>}
        {notice}
        {/* Pages légales toujours atteignables depuis les espaces connectés (RGPD art. 12, politique cookies,
            déclaration d'accessibilité), y compris dans le menu mobile : à la suite du menu, dans la même zone */}
        <LegalLinks variant="compact" className="px-5 pb-4" prefetch={false} />
      </div>

      <div className="shrink-0 border-t border-line p-2">
        <DropdownMenu>
          <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.04]">
            <Avatar name={user.name} size={30} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-fg">{user.name}</span>
              <span className="block truncate text-[12px] text-fg-subtle">{user.email}</span>
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-[220px]">
            <DropdownMenuItem destructive onSelect={() => signOut()}>
              <LogOut /> Se déconnecter
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function Sidebar(props: Props) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() ?? "";
  // Tiroir mobile fermé au clic : barre de progression du clic jusqu'au changement d'adresse (10 s au plus), seulement
  // si l'adresse visée diffère de l'adresse courante
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  useEffect(() => setPendingHref(null), [pathname]);
  useEffect(() => {
    if (!pendingHref) return;
    const timer = window.setTimeout(() => setPendingHref(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [pendingHref]);
  const navigateFromDrawer = (href: string, event: React.MouseEvent) => {
    setOpen(false);
    // Ouverture dans un autre onglet (Ctrl, Cmd, Maj, clic du milieu) : cette page ne change pas
    const elsewhere = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
    if (!elsewhere && href !== pathname) setPendingHref(href);
  };
  // Mobile : pastille sur le bouton menu quand une entrée a un compteur (messages non lus…)
  const flagged = props.sections.flatMap((s) => s.items).find((i) => !!i.badge);
  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] border-r border-line bg-ink-950 lg:block">
        <NavContent {...props} />
      </aside>
      {/* Mobile */}
      <div className="sticky top-0 z-30 flex h-14 items-center justify-between gap-2 border-b border-line bg-ink-950/90 px-4 backdrop-blur lg:hidden [@media(max-height:30rem)]:relative">
        <Logo size={24} />
        <div className="flex min-w-0 items-center gap-2">
          {props.headerAction}
          <D.Root open={open} onOpenChange={setOpen}>
            <D.Trigger className="relative grid size-11 shrink-0 place-items-center rounded-lg border border-line text-fg-muted">
              <Menu className="size-5" />
              <span className="sr-only">Menu</span>
              {flagged && (
                <span
                  className={cn(
                    "absolute right-0.5 top-0.5 size-2.5 rounded-full border-2 border-ink-950",
                    flagged.badgeTone === "brand" ? "bg-brand" : flagged.badgeTone === "amber" ? "bg-amber" : "bg-red",
                  )}
                />
              )}
            </D.Trigger>
            <D.Portal>
              <D.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
              <D.Content className="fixed inset-y-0 left-0 z-50 w-[min(300px,calc(100vw-3rem))] border-r border-line bg-ink-950 data-[state=open]:animate-in data-[state=open]:slide-in-from-left">
                <D.Title className="sr-only">Navigation</D.Title>
                <D.Description className="sr-only">Menu principal</D.Description>
                <NavContent {...props} headerAction={null} onNavigate={navigateFromDrawer} drawer />
              </D.Content>
            </D.Portal>
          </D.Root>
        </div>
        <NavProgress active={!!pendingHref} />
      </div>
    </>
  );
}
