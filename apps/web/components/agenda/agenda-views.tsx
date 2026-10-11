// Agenda du tableau de bord : vues Mois, Semaine, Jour et Liste (composants serveur, sans script : liens seulement).
// Modèle de vue : agenda-model.ts. Couleur = information (jetons de globals.css, AGENDA_KIND_META) ; liens sans
// préchargement ; textes du lecteur d'écran pour chaque jour et, dans les grilles du mois et de la semaine (ni tableau ni
// titre pour situer un lien), le jour dans le nom de chaque lien (courses, « +N »). Vocabulaire « course » ou
// « réservation » (Flotte Privée) passé par la page (`noun`).
import { AGENDA_KIND_META, AGENDA_VIEW_LABELS, formatPrice, formatTime, minutesOfDay, shortAddress, type AgendaKind, type AgendaView, type Tone } from "@rydar/shared";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { Badge, toneDot, toneText } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { upperFirst } from "@/lib/wording";
import {
  TIMELINE_HOUR_PX, WEEKDAY_HEADERS, agendaHref, agendaNoun, entryAriaLabel, periodLabel, shiftPeriod, summaryLabel,
  type AgendaEntry, type AgendaNoun, type DayTimeline, type ListDay, type MonthCell, type WeekColumn, type WeekPhoneRun,
} from "./agenda-model";

/** Bord gauche d'un bloc de la frise (même couleur que la catégorie). */
const TONE_BORDER: Record<Tone, string> = {
  neutral: "border-l-fg-subtle",
  brand: "border-l-brand",
  amber: "border-l-amber",
  blue: "border-l-blue",
  violet: "border-l-violet",
  cyan: "border-l-cyan",
  green: "border-l-green",
  red: "border-l-red",
};

/** Ordre des vues dans le sélecteur (la plus large d'abord). */
const VIEW_ORDER: AgendaView[] = ["month", "week", "day", "list"];

/** Légende des couleurs (catégories affichées par l'agenda). */
const LEGEND: AgendaKind[] = ["to_confirm", "not_confirmed", "confirmed", "ongoing", "completed", "cancelled"];

export function AgendaToolbar({ view, day, today }: { view: AgendaView; day: string; today: string }) {
  const nav = "grid size-10 place-items-center rounded-lg border border-line text-fg-muted transition-colors hover:border-line-strong hover:text-fg sm:size-9";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <Link href={agendaHref(view, shiftPeriod(view, day, -1))} prefetch={false} className={nav} aria-label="Période précédente">
          <ChevronLeft aria-hidden className="size-4" />
        </Link>
        <Link
          href={agendaHref(view, today)}
          prefetch={false}
          className="inline-flex h-10 items-center rounded-lg border border-line px-3 text-[13px] font-medium text-fg hover:border-line-strong sm:h-9"
        >
          Aujourd&apos;hui
        </Link>
        <Link href={agendaHref(view, shiftPeriod(view, day, 1))} prefetch={false} className={nav} aria-label="Période suivante">
          <ChevronRight aria-hidden className="size-4" />
        </Link>
        <h2 className="ml-1 truncate text-[16px] font-semibold tracking-tight text-fg" aria-live="polite">
          {periodLabel(view, day)}
        </h2>
      </div>
      <nav aria-label="Vue de l'agenda" data-tour="agenda-views" className="flex rounded-lg border border-line bg-ink-850 p-0.5 text-[13px]">
        {VIEW_ORDER.map((v) => (
          <Link
            key={v}
            href={agendaHref(v, day)}
            prefetch={false}
            aria-current={v === view ? "page" : undefined}
            className={cn(
              "inline-flex min-h-10 items-center rounded-md px-3 font-medium transition-colors sm:min-h-8",
              v === view ? "bg-ink-600 text-fg ring-1 ring-brand/60" : "text-fg-muted hover:text-fg",
            )}
          >
            {AGENDA_VIEW_LABELS[v]}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function AgendaLegend() {
  return (
    <ul aria-label="Couleurs de l'agenda" className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-fg-muted">
      {LEGEND.map((k) => (
        <li key={k} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn("size-2 rounded-full", toneDot[AGENDA_KIND_META[k].tone])} />
          {AGENDA_KIND_META[k].label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Ligne compacte : « 08:30 Orly → Paris 8e » (point de couleur de la catégorie). `day` (« mercredi 14 octobre ») :
 * dans le nom accessible, avec l'état — case du mois ou colonne de la semaine, rien d'autre ne situe le lien.
 */
function EntryLink({ entry, day, compact }: { entry: AgendaEntry; day: string; compact?: boolean }) {
  return (
    <Link
      href={`/dashboard/rides/${entry.id}`}
      prefetch={false}
      className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-[12px] hover:bg-white/[0.05]"
      title={`${entry.time} · ${entry.route} · ${entry.label}`}
      aria-label={entryAriaLabel(entry, day)}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", toneDot[entry.tone])} />
      <span className="num shrink-0 text-fg">{entry.time}</span>
      <span className={cn("min-w-0 truncate", compact ? "text-fg-muted" : "text-fg")}>{entry.route}</span>
    </Link>
  );
}

export function MonthView({ cells }: { cells: MonthCell[] }) {
  return (
    <Card className="overflow-hidden">
      {/* En-têtes visuels seulement : chaque jour porte son nom complet pour le lecteur d'écran (aria-label) */}
      <div aria-hidden className="grid grid-cols-7 border-b border-line text-center text-[12px] text-fg-muted">
        {WEEKDAY_HEADERS.map((w) => (
          <div key={w.long} className="py-2" title={w.long}>
            {w.short}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((c) => (
          <div
            key={c.day}
            className={cn(
              "relative min-h-[52px] border-b border-r border-line p-1 sm:min-h-[112px] sm:p-1.5 [&:nth-child(7n)]:border-r-0",
              c.inMonth ? "bg-transparent" : "bg-white/[0.015]",
              c.today && "ring-1 ring-inset ring-brand",
            )}
          >
            <Link
              href={agendaHref("day", c.day)}
              prefetch={false}
              aria-label={c.ariaLabel}
              aria-current={c.today ? "date" : undefined}
              className={cn(
                "num grid min-h-[44px] min-w-[44px] place-items-start rounded-md px-1 text-[13px] font-semibold sm:min-h-0 sm:min-w-0",
                c.inMonth ? "text-fg" : "text-fg-subtle",
                c.today && "text-brand",
              )}
            >
              {c.dayNumber}
            </Link>
            {/* Téléphone : points de couleur seulement (la journée s'ouvre en vue Jour) */}
            {c.entries.length > 0 && (
              <span aria-hidden className="pointer-events-none absolute bottom-1.5 left-1/2 flex -translate-x-1/2 gap-0.5 sm:hidden">
                {c.entries.map((e) => (
                  <span key={e.id} className={cn("size-1.5 rounded-full", toneDot[e.tone])} />
                ))}
              </span>
            )}
            <div className="mt-0.5 hidden space-y-0.5 sm:block">
              {c.entries.map((e) => (
                <EntryLink key={e.id} entry={e} day={c.title} compact />
              ))}
              {c.moreLabel && (
                <Link
                  href={agendaHref("day", c.day)}
                  prefetch={false}
                  aria-label={c.moreLabel}
                  className="block px-1 text-[12px] font-medium text-fg-muted hover:text-fg"
                >
                  +{c.more}
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Carte d'un jour de la semaine (colonne sur grand écran, carte empilée sur téléphone). */
function WeekDayCard({ c, noun, className }: { c: WeekColumn; noun: AgendaNoun; className?: string }) {
  const summary = summaryLabel(c.summary, "EUR", noun);
  return (
    <Card className={cn("min-w-0 overflow-hidden", c.today && "ring-1 ring-brand", className)}>
      <Link
        href={agendaHref("day", c.day)}
        prefetch={false}
        aria-label={c.ariaLabel}
        aria-current={c.today ? "date" : undefined}
        className="block border-b border-line px-3 py-2 hover:bg-white/[0.025]"
      >
        <span className={cn("block truncate text-[13px] font-semibold", c.today ? "text-brand" : "text-fg")}>{c.heading}</span>
        <span className="block truncate text-[12px] text-fg-muted">{summary ?? upperFirst(agendaNoun(noun).none)}</span>
      </Link>
      {c.entries.length > 0 && (
        <div className="space-y-0.5 p-1.5">
          {c.entries.map((e) => (
            <EntryLink key={e.id} entry={e} day={c.title} />
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Semaine : 7 colonnes à partir de lg ; en dessous, cartes empilées où les jours vides consécutifs tiennent sur une
 * seule ligne (« lun. 5 – ven. 9 : rien de prévu », `runs` du modèle) — leurs cartes restent rendues pour le grand
 * écran, masquées sur téléphone (jamais lues deux fois : display none).
 */
export function WeekView({ columns, runs, noun = "ride" }: { columns: WeekColumn[]; runs: WeekPhoneRun[]; noun?: AgendaNoun }) {
  return (
    <div className="grid gap-3 lg:grid-cols-7 lg:gap-2">
      {columns.map((c, i) => {
        const run = runs[i] ?? null;
        return (
          <WeekRunItem key={c.day} run={run}>
            <WeekDayCard c={c} noun={noun} className={run ? "max-lg:hidden" : undefined} />
          </WeekRunItem>
        );
      })}
    </div>
  );
}

/** Ligne « rien de prévu » (téléphone) avant la carte du premier jour d'une suite vide ; la carte seule sinon. */
function WeekRunItem({ run, children }: { run: WeekPhoneRun; children: React.ReactNode }) {
  if (!run?.start) return <>{children}</>;
  return (
    <>
      <p className="flex items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2.5 text-[13px] text-fg-muted lg:hidden">
        <CalendarDays aria-hidden className="size-4 shrink-0 text-fg-subtle" />
        {run.label}
      </p>
      {children}
    </>
  );
}

export function DayView({
  timeline,
  entries,
  now,
  isToday,
  timeZone,
  noun = "ride",
  next = null,
}: {
  timeline: DayTimeline;
  entries: AgendaEntry[];
  now: number;
  isToday: boolean;
  timeZone: string;
  noun?: AgendaNoun;
  /** Jour vide : lien vers la prochaine course (« Prochaine réservation : demain 08:30 ») */
  next?: { label: string; href: string } | null;
}) {
  if (!entries.length) {
    return (
      <Card className="flex flex-col items-center gap-3 px-5 py-10 text-center">
        <p className="text-[14px] font-medium text-fg">{upperFirst(agendaNoun(noun).none)} ce jour-là.</p>
        {next && (
          <Link href={next.href} prefetch={false} className="inline-flex min-h-11 items-center gap-1 text-[13.5px] font-medium text-brand hover:underline sm:min-h-0">
            {next.label}
            <ChevronRight aria-hidden className="size-4" />
          </Link>
        )}
      </Card>
    );
  }
  const nowMinutes = isToday ? minutesOfDay(new Date(now).toISOString(), timeZone) : null;
  const nowTop = nowMinutes != null && nowMinutes >= timeline.startHour * 60 ? ((nowMinutes - timeline.startHour * 60) / 60) * TIMELINE_HOUR_PX : null;
  return (
    <Card className="overflow-hidden p-3 sm:p-4">
      {/* Frise : heures à gauche, courses positionnées à l'heure murale de prise en charge (fuseau de l'organisation) */}
      <div className="relative" style={{ height: timeline.height }}>
        {timeline.hours.map((h, i) => (
          <div key={h} className="absolute inset-x-0 flex items-start gap-2" style={{ top: i * TIMELINE_HOUR_PX }}>
            <span className="num w-11 shrink-0 -translate-y-1/2 text-right text-[12px] text-fg-muted">{String(h).padStart(2, "0")}:00</span>
            <span aria-hidden className="mt-0 h-px flex-1 bg-line" />
          </div>
        ))}
        {nowTop != null && (
          <div aria-hidden className="absolute left-12 right-0 h-px bg-red" style={{ top: nowTop }}>
            <span className="absolute -left-1 -top-1 size-2 rounded-full bg-red" />
          </div>
        )}
        <ol className="absolute inset-y-0 left-14 right-0">
          {timeline.blocks.map((b) => (
            <li
              key={b.entry.id}
              className="absolute px-0.5"
              style={{ top: b.top, height: b.height, left: `${(b.column / b.columns) * 100}%`, width: `${100 / b.columns}%` }}
            >
              <Link
                href={`/dashboard/rides/${b.entry.id}`}
                prefetch={false}
                className={cn(
                  "flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-l-4 border-line bg-ink-800 px-2 py-1 text-[12px] hover:bg-ink-700",
                  TONE_BORDER[b.entry.tone],
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="num shrink-0 font-semibold text-fg">{b.entry.time}</span>
                  <span className="min-w-0 truncate text-fg">{b.entry.route}</span>
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-[12px]">
                  <span className={toneText[b.entry.tone]}>{b.entry.label}</span>
                  {b.entry.customer_name && <span className="truncate text-fg-muted">{b.entry.customer_name}</span>}
                  {b.overlap && <span className="font-medium text-amber">Chevauchement</span>}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}

export function ListView({ days, timeZone, noun = "ride" }: { days: ListDay[]; timeZone: string; noun?: AgendaNoun }) {
  if (!days.length) {
    return (
      <Card className="px-5 py-10 text-center">
        <p className="text-[14px] font-medium text-fg">{upperFirst(agendaNoun(noun).none)} sur cette période.</p>
      </Card>
    );
  }
  return (
    <div className="space-y-5">
      {days.map((d) => (
        <section key={d.day} aria-label={d.heading}>
          <h3 className="mb-2 flex items-baseline justify-between gap-3 px-1">
            <span className="text-[14px] font-semibold text-fg">{d.heading}</span>
            <span className="text-[12px] text-fg-muted">{summaryLabel(d.summary, "EUR", noun)}</span>
          </h3>
          <Card className="divide-y divide-line overflow-hidden">
            {d.entries.map((e) => (
              <Link
                key={e.id}
                href={`/dashboard/rides/${e.id}`}
                prefetch={false}
                className="flex items-start gap-x-3 px-4 py-3 hover:bg-white/[0.025]"
                title={`${e.pickup_address} → ${e.dropoff_address}`}
              >
                <span className="num w-12 shrink-0 pt-px text-[14px] font-semibold text-fg">{formatTime(e.pickup_at, timeZone)}</span>
                {/* Trajet sur deux lignes (départ, puis arrivée), puis numéro, client et prix : rien n'est coupé (téléphone),
                    l'état ne prend que la place de la première ligne */}
                <span className="min-w-0 flex-1">
                  <span className="flex items-start justify-between gap-x-3">
                    <span className="min-w-0 text-[13.5px] text-fg [overflow-wrap:anywhere]">{shortAddress(e.pickup_address)}</span>
                    <Badge tone={e.tone} className="shrink-0">
                      {e.label}
                    </Badge>
                  </span>
                  <span className="block text-[13.5px] text-fg [overflow-wrap:anywhere]">→ {shortAddress(e.dropoff_address)}</span>
                  <span className="mt-0.5 block text-[12px] text-fg-muted">
                    #{e.number} · {e.customer_name || "Client"} ·{" "}
                    {e.price_cents == null ? (
                      <span className="whitespace-nowrap text-amber">prix à fixer</span>
                    ) : (
                      <span className="num whitespace-nowrap text-fg">{formatPrice(e.price_cents, e.currency || "EUR")}</span>
                    )}
                  </span>
                </span>
              </Link>
            ))}
          </Card>
        </section>
      ))}
    </div>
  );
}
