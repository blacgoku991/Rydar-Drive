"use client";
import { FLEET_REPORT_META, fleetReportTitle, initials, type ChatMessage, type FleetReportType } from "@rydar/shared";
import { Check, CheckCheck, MapPinned, ThumbsDown, ThumbsUp } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { ago, clockTime, dayLabel, firstName, minutesLeft, sameDay } from "./chat-utils";

/** Texte par défaut d'un signalement sans commentaire (send_chat_message) : inutile de le répéter sous le titre. */
const DEFAULT_REPORT_BODY: Record<FleetReportType, string> = {
  police: "Contrôle de police signalé",
  control: "Contrôle VTC signalé",
  accident: "Accident signalé",
  traffic: "Bouchon signalé",
  danger: "Danger sur la route",
  other: "Signalement de la flotte",
};

type Block =
  | { kind: "day"; key: string; label: string }
  | { kind: "group"; key: string; side: "me" | "team" | "driver"; author: string; authorKey: string; messages: ChatMessage[] }
  | { kind: "report"; key: string; message: ChatMessage; side: "me" | "team" | "driver" }
  | { kind: "system"; key: string; message: ChatMessage };

const authorKeyOf = (m: ChatMessage) =>
  m.author_type === "user" ? `u:${m.author_user_id ?? m.author_name}` : m.author_type === "driver" ? `d:${m.author_driver_id ?? m.author_name}` : "s";

/** Messages → blocs (séparateurs de jour, groupes d'un même auteur à moins de 5 min, signalements, messages système). */
export function buildBlocks(items: ChatMessage[], meId: string, timeZone: string, now: number): Block[] {
  const blocks: Block[] = [];
  let lastDay: string | null = null; // dernier message (séparateur de jour)
  let prev: ChatMessage | null = null; // dernier message « bulle » (regroupement)
  for (const m of items) {
    if (!lastDay || !sameDay(lastDay, m.created_at, timeZone)) {
      blocks.push({ kind: "day", key: `day-${m.id}`, label: dayLabel(m.created_at, timeZone, now) });
      prev = null;
    }
    lastDay = m.created_at;
    const side = m.author_type === "driver" ? "driver" : m.author_user_id === meId ? "me" : "team";
    if (m.author_type === "system") blocks.push({ kind: "system", key: m.id, message: m });
    else if (m.report_type) blocks.push({ kind: "report", key: m.id, message: m, side });
    else {
      const last = blocks[blocks.length - 1];
      const key = authorKeyOf(m);
      if (
        last?.kind === "group" &&
        last.authorKey === key &&
        prev &&
        new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60_000
      ) {
        last.messages.push(m);
      } else {
        blocks.push({ kind: "group", key: m.id, side, author: m.author_name, authorKey: key, messages: [m] });
      }
    }
    prev = m.report_type || m.author_type === "system" ? null : m;
  }
  return blocks;
}

export function DaySeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-2" role="separator" aria-label={label}>
      <span className="h-px flex-1 bg-line" />
      <span className="rounded-full border border-line bg-ink-850 px-3 py-1 text-[11.5px] font-medium text-fg-muted first-letter:uppercase">
        {label}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

export function MessageGroup({
  side,
  author,
  messages,
  timeZone,
  showAuthor,
  receipt,
}: {
  side: "me" | "team" | "driver";
  author: string;
  messages: ChatMessage[];
  timeZone: string;
  /** Nom de l'auteur au-dessus du groupe (fil flotte, ou autre membre de la centrale) */
  showAuthor: boolean;
  /** Accusé sous le dernier message envoyé (fil direct) */
  receipt?: "sent" | "seen" | null;
}) {
  const right = side !== "driver";
  return (
    <div className={cn("flex gap-2.5", right ? "justify-end" : "justify-start")}>
      {!right && showAuthor && (
        <span className="mt-5 grid size-7 shrink-0 place-items-center rounded-full bg-ink-600 text-[10.5px] font-semibold text-fg-muted" aria-hidden>
          {initials(author.split(/\s+/)[0], author.split(/\s+/)[1])}
        </span>
      )}
      <div className={cn("flex min-w-0 max-w-[min(560px,86%)] flex-col gap-1", right ? "items-end" : "items-start")}>
        {showAuthor && (
          <span className={cn("px-1 text-[11.5px] font-medium", side === "driver" ? "text-fg-muted" : "text-fg-subtle")}>
            {side === "team" ? `${author} · centrale` : author}
          </span>
        )}
        {messages.map((m, i) => (
          <div
            key={m.id}
            className={cn(
              "chat-bubble relative max-w-full rounded-2xl px-3.5 py-2 text-[13.5px] leading-[1.45]",
              side === "me" && "chat-bubble--me",
              side === "team" && "border border-line-strong bg-ink-600 text-fg",
              side === "driver" && "border border-line bg-ink-700 text-fg",
              right ? (i === messages.length - 1 ? "rounded-br-md" : "") : i === messages.length - 1 ? "rounded-bl-md" : "",
            )}
          >
            <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{m.body}</span>
            <time
              dateTime={m.created_at}
              className={cn("float-right ml-3 mt-[5px] font-mono text-[10.5px] leading-none", side === "me" ? "text-brand/60" : "text-fg-subtle")}
            >
              {clockTime(m.created_at, timeZone)}
            </time>
          </div>
        ))}
        {receipt && (
          <span className={cn("flex items-center gap-1 px-1 text-[11px]", receipt === "seen" ? "text-brand" : "text-fg-subtle")}>
            {receipt === "seen" ? <CheckCheck className="size-3.5" /> : <Check className="size-3.5" />}
            {receipt === "seen" ? "Vu" : "Envoyé"}
          </span>
        )}
      </div>
    </div>
  );
}

export function SystemLine({ message, timeZone }: { message: ChatMessage; timeZone: string }) {
  return (
    <p className="px-6 py-1 text-center text-[12px] text-fg-subtle">
      {message.body} · <span className="font-mono">{clockTime(message.created_at, timeZone)}</span>
    </p>
  );
}

/** Carte de signalement flotte : type, auteur, âge, votes, actif / expiré, lien vers la carte. */
export function ReportCard({ message: m, side, timeZone, now }: { message: ChatMessage; side: "me" | "team" | "driver"; timeZone: string; now: number }) {
  const type = (m.report_type ?? "other") as FleetReportType;
  const meta = FLEET_REPORT_META[type];
  const left = minutesLeft(m.expires_at, now);
  const active = left > 0;
  const comment = m.body && m.body !== DEFAULT_REPORT_BODY[type] ? m.body : null;
  const author = side === "me" ? "vous" : firstName(m.author_name);
  return (
    <div className={cn("flex", side === "driver" ? "justify-start" : "justify-end")}>
      <article
        className={cn("w-full max-w-[440px] overflow-hidden rounded-2xl border", active ? "border-line-strong bg-ink-700" : "border-line bg-ink-800/60")}
        aria-label={fleetReportTitle(type, author)}
      >
        <div className="flex items-start gap-3 p-3.5">
          <span
            className={cn("grid size-10 shrink-0 place-items-center rounded-xl text-[20px] leading-none", !active && "opacity-50 grayscale")}
            style={{ background: `${meta.color}1c`, boxShadow: `inset 0 0 0 1px ${meta.color}45` }}
            aria-hidden
          >
            {meta.emoji}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className={cn("text-[13.5px] font-semibold tracking-tight", active ? "text-fg" : "text-fg-muted")}>{fleetReportTitle(type, author)}</p>
              {active ? (
                <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-[11.5px] font-medium" style={{ background: `${meta.color}1a`, color: meta.color }}>
                  <span className="size-1.5 animate-breathe rounded-full" style={{ background: meta.color }} />
                  Actif · encore {left} min
                </span>
              ) : (
                <span className="inline-flex h-[22px] items-center rounded-full bg-white/[0.05] px-2 text-[11.5px] font-medium text-fg-subtle">Expiré</span>
              )}
            </div>
            {comment && <p className="mt-1 whitespace-pre-wrap break-words text-[13px] text-fg-muted">{comment}</p>}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-fg-subtle">
                <span>
                  {ago(m.created_at, now)} · <span className="font-mono">{clockTime(m.created_at, timeZone)}</span>
                </span>
                {m.confirmations > 0 || m.dismissals > 0 ? (
                  <>
                    <span className="inline-flex items-center gap-1" title="Toujours là, d'après la flotte">
                      <ThumbsUp className="size-3" /> confirmé {m.confirmations}×
                    </span>
                    <span className="inline-flex items-center gap-1" title="Plus là, d'après la flotte">
                      <ThumbsDown className="size-3" /> infirmé {m.dismissals}×
                    </span>
                  </>
                ) : (
                  <span>pas encore de vote</span>
                )}
              </p>
              {active && (
                <Link
                  href={`/dashboard?report=${m.id}`}
                  className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[12px] font-medium text-fg-muted transition-colors hover:border-white/20 hover:bg-white/[0.04] hover:text-fg"
                >
                  <MapPinned className="size-3.5" /> Voir sur la carte
                </Link>
              )}
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}
