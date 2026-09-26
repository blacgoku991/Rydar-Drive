"use client";
// Bandeau « Frais plateforme » du tableau de bord (owner / admin, mode centrale), lu via org_platform_status :
//  • rouge : montant en retard (non couvert par une déclaration) ou création de courses suspendue — non fermable ;
//  • ambre : échéance dans moins de 3 jours ;
//  • bleu discret : relance récente de Rydar, ou paiement déclaré qui couvre le retard (en attente de Rydar).
// Rafraîchi sur « platform.updated » et toutes les 5 min ; fermable pour la session (sauf rouge).
import { formatPrice, type OrgPlatformStatus, type PlatformAccount, type PlatformEvent } from "@rydar/shared";
import { AlertTriangle, BellRing, Clock3, Lock, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { ago, isRecentReminder } from "@/components/platform-fees/org-platform-format";
import { getBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type Tone = "red" | "amber" | "blue";
type BannerState = { tone: Tone; key: string; icon: React.ReactNode; title: string; detail: string };

const SOON_MS = 3 * 24 * 3600_000;
const HIDE_KEY = "rydar.platform-banner:";

function dayMonth(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", timeZone }).format(new Date(iso));
}

/** État du bandeau (null : rien à afficher). */
export function platformBanner(a: PlatformAccount, now: number, timeZone: string): BannerState | null {
  const cur = a.currency || "EUR";
  const reminded = isRecentReminder(a, now);
  const reminder = reminded ? ` · relance de Rydar ${ago(a.reminded_at, now)}` : "";
  const uncovered = a.due_cents - a.declared_cents;
  const days = (n: number) => `${n} jour${n > 1 ? "s" : ""}`;

  if (a.blocked) {
    return {
      tone: "red",
      key: `blocked:${a.due_cents}`,
      icon: <Lock />,
      title: "Création de courses suspendue par Rydar",
      detail: `${formatPrice(a.due_cents, cur)} de frais plateforme en retard depuis ${days(a.days_overdue)}.`,
    };
  }
  if (a.due_cents > 0 && a.overdue_since && uncovered > 0) {
    const left = a.block_after_days != null ? a.block_after_days - a.days_overdue : null;
    return {
      tone: "red",
      key: `overdue:${a.due_cents}`,
      icon: <AlertTriangle />,
      title: "Frais plateforme en retard",
      detail:
        `${formatPrice(uncovered, cur)} à reverser à Rydar${a.days_overdue > 0 ? ` depuis ${days(a.days_overdue)}` : ""}` +
        (left != null && left > 0 ? ` · création de courses suspendue dans ${days(left)} sans règlement` : "") +
        reminder +
        ".",
    };
  }
  if (a.due_cents > 0 && a.overdue_since) {
    // Retard entièrement couvert par un paiement déclaré : en attente de la confirmation de Rydar
    return {
      tone: "blue",
      key: `declared:${a.declared_cents}`,
      icon: <Clock3 />,
      title: "Paiement signalé à Rydar",
      detail: `${formatPrice(a.declared_cents, cur)} en attente de confirmation.`,
    };
  }
  const soon = a.next_due_at ? Date.parse(a.next_due_at) - now : Infinity;
  const toPay = a.next_due_cents - a.declared_cents;
  if (a.next_due_at && soon >= 0 && soon <= SOON_MS && toPay > 0) {
    return {
      tone: "amber",
      key: `soon:${a.next_due_at}:${toPay}`,
      icon: <Clock3 />,
      title: "Frais plateforme à régler",
      detail: `${formatPrice(toPay, cur)} à reverser à Rydar au plus tard le ${dayMonth(a.next_due_at, timeZone)}${reminder}.`,
    };
  }
  if (reminded && a.balance_cents > 0) {
    return {
      tone: "blue",
      key: `reminded:${a.reminded_at}`,
      icon: <BellRing />,
      title: `Rydar vous relance`,
      detail: a.reminder_note ? `« ${a.reminder_note} »` :`${formatPrice(a.balance_cents, cur)} de frais plateforme à régler.`,
    };
  }
  return null;
}

const TONE: Record<Tone, { bar: string; icon: string; button: string }> = {
  red: { bar: "border-red/30 bg-red/[0.08]", icon: "text-red", button: "bg-red text-white hover:bg-red/90" },
  amber: { bar: "border-amber/25 bg-amber/[0.07]", icon: "text-amber", button: "bg-amber font-semibold text-ink-950 hover:opacity-90" },
  blue: { bar: "border-blue/20 bg-blue/[0.05]", icon: "text-blue", button: "bg-white/[0.08] text-fg hover:bg-white/[0.13]" },
};

export function OrgPlatformBanner({ orgId, timeZone, enabled }: { orgId: string; timeZone: string; enabled: boolean }) {
  const pathname = usePathname();
  const [account, setAccount] = useState<PlatformAccount | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const timer = useRef<number | null>(null);

  const load = useCallback(() => {
    if (!enabled) return;
    Promise.resolve(getBrowserClient().rpc("org_platform_status", { p_org: orgId }))
      .then(({ data, error }: { data: unknown; error: unknown }) => {
        if (error) return;
        const s = data as OrgPlatformStatus | null;
        setAccount(s?.enabled ? s.account : null);
        setNow(Date.now());
      })
      .catch(() => undefined);
  }, [enabled, orgId]);

  useEffect(() => {
    setAccount(null);
    if (!enabled) return;
    try {
      setHidden(window.sessionStorage.getItem(HIDE_KEY + orgId));
    } catch {
      /* stockage indisponible */
    }
    load();
    const id = window.setInterval(load, 5 * 60_000);
    return () => window.clearInterval(id);
  }, [enabled, orgId, load]);

  useRealtimeEvent("platform.updated", (e: PlatformEvent) => {
    if (!enabled || (e?.organization_id && e.organization_id !== orgId)) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(load, 700);
  });

  if (!enabled || !account || !now) return null;
  const state = platformBanner(account, now, timeZone);
  if (!state) return null;
  const dismissible = state.tone !== "red";
  if (dismissible && hidden === state.key) return null;
  // La carte « Frais plateforme » est déjà en tête de la page Encaissements ; Messages occupe toute la hauteur
  // de l'écran (h-dvh) : un bandeau dans le flux pousserait la zone de saisie hors de l'écran
  if (pathname === "/dashboard/settlements" || pathname.startsWith("/dashboard/messages")) return null;
  const floating = pathname === "/dashboard";
  const t = TONE[state.tone];

  const dismiss = () => {
    setHidden(state.key);
    try {
      window.sessionStorage.setItem(HIDE_KEY + orgId, state.key);
    } catch {
      /* stockage indisponible */
    }
  };

  const body = (
    <div
      role={state.tone === "red" ? "alert" : "status"}
      className={cn(
        "flex items-center gap-3 text-[13px]",
        floating
          ? cn("pointer-events-auto rounded-xl border px-3.5 py-2.5 shadow-float backdrop-blur-xl", t.bar, "bg-ink-800/95")
          : cn("border-b px-4 py-2.5 sm:px-6 lg:px-10", t.bar),
      )}
    >
      <span className={cn("shrink-0 [&_svg]:size-4", t.icon)}>{state.icon}</span>
      <p className="min-w-0 flex-1 leading-5">
        <span className="font-semibold text-fg">{state.title}</span>
        <span className="text-fg-muted"> · {state.detail}</span>
      </p>
      <Link
        href="/dashboard/settlements#frais-plateforme"
        className={cn("inline-flex h-7 shrink-0 items-center rounded-md px-2.5 text-[12px] font-medium transition-colors", t.button)}
      >
        Régler
      </Link>
      {dismissible && (
        <button
          type="button"
          onClick={dismiss}
          className="-mr-1 grid size-7 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-white/[0.06] hover:text-fg"
          aria-label="Masquer ce bandeau (onglet en cours)"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );

  // Command center : carte plein écran, bandeau flottant entre le panneau des courses et la flotte
  if (floating) {
    return (
      <div className="pointer-events-none fixed inset-x-3 top-[64px] z-30 lg:left-[648px] lg:right-4 lg:top-[76px] xl:right-[340px]">
        <div className="mx-auto max-w-[560px]">{body}</div>
      </div>
    );
  }
  return body;
}
