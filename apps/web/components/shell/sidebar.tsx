"use client";
import {
  BarChart3, Building2, Check, ChevronsUpDown, CreditCard, Globe, KeyRound, LayoutDashboard, LogOut, Menu, Radar, Route,
  ScrollText, Settings, ShieldCheck, Sparkles, Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Dialog as D } from "radix-ui";
import { Logo } from "@/components/brand/logo";
import {
  Avatar, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/misc";
import { cn } from "@/lib/utils";

const ICONS = {
  radar: Radar, route: Route, users: Users, scroll: ScrollText, chart: BarChart3, key: KeyRound, globe: Globe,
  settings: Settings, building: Building2, shield: ShieldCheck, card: CreditCard, sparkles: Sparkles, dashboard: LayoutDashboard,
};
export type NavIcon = keyof typeof ICONS;
export type NavSection = { title: string; items: { href: string; label: string; icon: NavIcon; exact?: boolean; badge?: number }[] };

type Props = {
  sections: NavSection[];
  subtitle: string;
  user: { name: string; email: string };
  orgs?: { id: string; name: string; role: string }[];
  currentOrgId?: string;
  onSwitchOrg?: (id: string) => void;
  signOut: () => void;
  footer?: React.ReactNode;
};

function NavContent({ sections, subtitle, user, orgs, currentOrgId, onSwitchOrg, signOut, footer, onNavigate }: Props & { onNavigate?: () => void }) {
  const pathname = usePathname();
  const current = orgs?.find((o) => o.id === currentOrgId);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center px-5">
        <Link href={sections[0]?.items[0]?.href ?? "/"} onClick={onNavigate}>
          <Logo size={28} subtitle={subtitle} />
        </Link>
      </div>

      {current && (
        <div className="px-3 pb-2">
          <DropdownMenu>
            <DropdownMenuTrigger className="group flex w-full items-center gap-3 rounded-xl border border-line bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-white/[0.04]">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-brand/25 to-brand/5 text-[13px] font-bold text-brand">
                {current.name.slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-fg">{current.name}</span>
                <span className="block text-[11px] capitalize text-fg-subtle">{current.role}</span>
              </span>
              <ChevronsUpDown className="size-4 text-fg-subtle group-hover:text-fg-muted" />
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
        </div>
      )}

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        {sections.map((section) => (
          <div key={section.title}>
            <p className="mb-2 px-3 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-fg-subtle">{section.title}</p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = ICONS[item.icon];
                const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      className={cn(
                        "group relative flex h-9 items-center gap-3 rounded-lg px-3 text-[13.5px] font-medium transition-colors",
                        active ? "bg-white/[0.06] text-fg" : "text-fg-muted hover:bg-white/[0.03] hover:text-fg",
                      )}
                    >
                      {active && <span className="absolute -left-3 top-2 h-5 w-[3px] rounded-r-full bg-brand shadow-[0_0_12px_var(--color-brand)]" />}
                      <Icon className={cn("size-[17px]", active ? "text-brand" : "text-fg-subtle group-hover:text-fg-muted")} />
                      <span className="flex-1">{item.label}</span>
                      {!!item.badge && (
                        <span className="num rounded-full bg-red/15 px-1.5 text-[11px] font-semibold text-red">{item.badge}</span>
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

      <div className="border-t border-line p-3">
        <DropdownMenu>
          <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/[0.04]">
            <Avatar name={user.name} size={30} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-fg">{user.name}</span>
              <span className="block truncate text-[11.5px] text-fg-subtle">{user.email}</span>
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
  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] border-r border-line bg-ink-950/95 lg:block">
        <NavContent {...props} />
      </aside>
      {/* Mobile */}
      <div className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-ink-950/90 px-4 backdrop-blur lg:hidden">
        <Logo size={24} />
        <D.Root open={open} onOpenChange={setOpen}>
          <D.Trigger className="grid size-9 place-items-center rounded-lg border border-line text-fg-muted">
            <Menu className="size-4" />
            <span className="sr-only">Menu</span>
          </D.Trigger>
          <D.Portal>
            <D.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
            <D.Content className="fixed inset-y-0 left-0 z-50 w-[280px] border-r border-line bg-ink-950 data-[state=open]:animate-in data-[state=open]:slide-in-from-left">
              <D.Title className="sr-only">Navigation</D.Title>
              <D.Description className="sr-only">Menu principal</D.Description>
              <NavContent {...props} onNavigate={() => setOpen(false)} />
            </D.Content>
          </D.Portal>
        </D.Root>
      </div>
    </>
  );
}
