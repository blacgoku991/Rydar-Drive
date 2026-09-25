"use client";
import { PRESENCE_META, formatPhone, type ChatMessage, type ChatOverview } from "@rydar/shared";
import { ArrowDown, ChevronLeft, IdCard, Map as MapIcon, MessageSquareDashed, Phone, RadioTower } from "lucide-react";
import Link from "next/link";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { PRESENCE_COLOR } from "@/components/map/map-theme";
import { Avatar } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { FLEET_THREAD, firstName, type DriverThreadSummary } from "./chat-utils";
import { Composer } from "./composer";
import { DaySeparator, MessageGroup, ReportCard, SystemLine, buildBlocks } from "./message-blocks";

export type ThreadState = { items: ChatMessage[]; hasMore: boolean; loading: boolean; loaded: boolean; error?: string };

const QUICK_DRIVER = ["Bien reçu", "Merci", "Appelle-moi", "Tu es où ?"];
const QUICK_FLEET = ["Bien reçu", "Merci pour l'info", "Prudence sur la route"];

function HeaderButton({ href, label, icon, external }: { href: string; label: string; icon: React.ReactNode; external?: boolean }) {
  const cls =
    "inline-flex h-9 items-center gap-2 rounded-lg border border-line px-2.5 text-[13px] text-fg-muted transition-colors hover:border-line-strong hover:bg-white/[0.04] hover:text-fg [&_svg]:size-4 max-sm:w-9 max-sm:justify-center max-sm:px-0";
  const content = (
    <>
      {icon}
      <span className="max-sm:sr-only">{label}</span>
    </>
  );
  return external ? (
    <a href={href} className={cls} aria-label={label}>
      {content}
    </a>
  ) : (
    <Link href={href} className={cls} aria-label={label}>
      {content}
    </Link>
  );
}

export function ThreadPane({
  thread,
  fleet,
  driver,
  state,
  meId,
  timeZone,
  now,
  activeDrivers,
  draft,
  onDraft,
  onSend,
  sending,
  error,
  onLoadOlder,
  onBack,
}: {
  thread: string;
  fleet: ChatOverview["fleet"];
  driver: DriverThreadSummary | null;
  state: ThreadState | undefined;
  meId: string;
  timeZone: string;
  now: number;
  activeDrivers: number;
  draft: string;
  onDraft: (v: string) => void;
  onSend: (text: string, fromComposer: boolean) => void;
  sending: boolean;
  error: string | null;
  onLoadOlder: () => void;
  onBack: () => void;
}) {
  const isFleet = thread === FLEET_THREAD;
  const items = useMemo(() => state?.items ?? [], [state?.items]);
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const prev = useRef<{ first?: string; last?: string; count: number }>({ count: 0 });
  const [fresh, setFresh] = useState(0);

  const blocks = useMemo(() => buildBlocks(items, meId, timeZone, now), [items, meId, timeZone, now]);

  // Accusé « Vu » : seulement quand le dernier message du fil direct vient de la centrale
  const last = items[items.length - 1];
  const receiptFor =
    !isFleet && last && last.author_type === "user" && !last.report_type
      ? driver?.driver_last_read_at && new Date(driver.driver_last_read_at).getTime() >= new Date(last.created_at).getTime()
        ? "seen"
        : "sent"
      : null;

  // Défilement : en bas à l'ouverture, suit les nouveaux messages si on y est déjà, conserve la position au chargement des anciens.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = items[0]?.id;
    const lastId = items[items.length - 1]?.id;
    const p = prev.current;
    if (!p.count && items.length) {
      el.scrollTop = el.scrollHeight;
    } else if (anchor.current && first !== p.first) {
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
    } else if (lastId && lastId !== p.last) {
      const added = items.slice(items.findIndex((m) => m.id === p.last) + 1);
      const mineAdded = added.some((m) => m.author_type === "user" && m.author_user_id === meId);
      if (nearBottom.current || mineAdded) {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      } else {
        setFresh((n) => n + added.length);
      }
    }
    prev.current = { first, last: lastId, count: items.length };
  }, [items, meId]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    if (nearBottom.current && fresh) setFresh(0);
  };

  const loadOlder = () => {
    const el = scroller.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    onLoadOlder();
  };

  const d = driver?.driver;
  const name = d ? `${d.first_name} ${d.last_name}` : "Toute la flotte";
  const loading = !state?.loaded && (state?.loading ?? true);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* En-tête */}
      <header className="flex h-[64px] shrink-0 items-center gap-3 border-b border-line px-3 sm:px-5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Retour aux conversations"
          className="-ml-1 grid size-9 shrink-0 place-items-center rounded-lg text-fg-muted hover:bg-white/[0.05] hover:text-fg lg:hidden"
        >
          <ChevronLeft className="size-5" />
        </button>
        {isFleet ? (
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand/12 text-brand ring-1 ring-brand/25">
            <RadioTower className="size-[18px]" />
          </span>
        ) : (
          <span className="relative shrink-0">
            <Avatar name={name} src={d?.photo_url} size={40} />
            {d && (
              <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-ink-900" style={{ background: PRESENCE_COLOR[d.presence] }} />
            )}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold tracking-tight">{name}</p>
          <p className="truncate text-[12px] text-fg-subtle">
            {isFleet ? (
              <>
                {activeDrivers} chauffeur{activeDrivers > 1 ? "s" : ""}
                {fleet.active_reports > 0 && (
                  <span className="text-amber">
                    {" "}· {fleet.active_reports} signalement{fleet.active_reports > 1 ? "s" : ""} actif{fleet.active_reports > 1 ? "s" : ""}
                  </span>
                )}
              </>
            ) : d ? (
              <>
                <span style={{ color: d.presence === "offline" ? undefined : PRESENCE_COLOR[d.presence] }}>{PRESENCE_META[d.presence]?.label}</span>
                <span className="num"> · #{d.number}</span>
                {driver?.phone && <span className="max-sm:hidden"> · {formatPhone(driver.phone)}</span>}
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isFleet ? (
            <HeaderButton href="/dashboard" label="Carte" icon={<MapIcon />} />
          ) : (
            <>
              {driver?.phone && <HeaderButton href={`tel:${driver.phone}`} label="Appeler" icon={<Phone />} external />}
              {d && <HeaderButton href={`/dashboard/drivers/${d.id}`} label="Fiche" icon={<IdCard />} />}
            </>
          )}
        </div>
      </header>

      {/* Fil */}
      <div ref={scroller} onScroll={onScroll} className="chat-scroll relative flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4 sm:px-6" aria-live="polite">
        {state?.hasMore && (
          <div className="flex justify-center pt-4">
            <button
              type="button"
              onClick={loadOlder}
              disabled={state.loading}
              className="h-8 rounded-full border border-line px-3.5 text-[12px] text-fg-muted hover:bg-white/[0.04] hover:text-fg disabled:opacity-50"
            >
              {state.loading ? "Chargement…" : "Messages précédents"}
            </button>
          </div>
        )}

        {loading && (
          <div className="space-y-3 pt-6" aria-label="Chargement">
            {[62, 38, 54].map((w, i) => (
              <div key={i} className={cn("flex", i % 2 ? "justify-end" : "justify-start")}>
                <div className="skeleton h-10 rounded-2xl" style={{ width: `${w}%` }} />
              </div>
            ))}
          </div>
        )}

        {state?.error && !items.length && <p className="pt-10 text-center text-[13px] text-red">{state.error}</p>}

        {!loading && !items.length && !state?.error && (
          <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
            <div className="relative mb-4 grid size-14 place-items-center rounded-2xl border border-line-strong bg-ink-700 text-fg-muted">
              <div className="absolute inset-0 rounded-2xl bg-brand/5 blur-xl" />
              <MessageSquareDashed className="size-6" />
            </div>
            <p className="text-[14px] font-semibold">Aucun message pour l&apos;instant</p>
            <p className="mt-1 max-w-sm text-[13px] text-fg-muted">
              {isFleet
                ? "Les annonces de la centrale et les signalements des chauffeurs (police, bouchons…) apparaîtront ici."
                : `Écrivez à ${d ? d.first_name : "ce chauffeur"} : il reçoit une notification sur son téléphone.`}
            </p>
          </div>
        )}

        <div className="mt-auto flex flex-col gap-3 pt-2">
          {blocks.map((b, i) => {
            if (b.kind === "day") return <DaySeparator key={b.key} label={b.label} />;
            if (b.kind === "system") return <SystemLine key={b.key} message={b.message} timeZone={timeZone} />;
            if (b.kind === "report") return <ReportCard key={b.key} message={b.message} side={b.side} timeZone={timeZone} now={now} />;
            const isLast = i === blocks.length - 1;
            return (
              <MessageGroup
                key={b.key}
                side={b.side}
                author={b.side === "team" ? firstName(b.author) : b.author}
                messages={b.messages}
                timeZone={timeZone}
                showAuthor={b.side === "team" || (isFleet && b.side === "driver")}
                receipt={isLast ? receiptFor : null}
              />
            );
          })}
        </div>
      </div>

      {fresh > 0 && (
        <button
          type="button"
          onClick={() => {
            scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
            setFresh(0);
          }}
          className="absolute bottom-[150px] left-1/2 z-10 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full bg-brand px-3.5 text-[12.5px] font-semibold text-brand-fg shadow-glow animate-rise"
        >
          <ArrowDown className="size-3.5" /> {fresh} nouveau{fresh > 1 ? "x" : ""} message{fresh > 1 ? "s" : ""}
        </button>
      )}

      {d && d.status !== "active" && (
        <p className="border-t border-line bg-amber/[0.06] px-5 py-2 text-[12px] text-amber">
          Compte chauffeur {d.status === "suspended" ? "suspendu" : "désactivé"} : il ne recevra pas de notification.
        </p>
      )}
      <Composer
        value={draft}
        onChange={onDraft}
        onSend={(text) => onSend(text, text === draft.trim())}
        sending={sending}
        error={error}
        placeholder={isFleet ? "Message à toute la flotte…" : `Message à ${d?.first_name ?? "ce chauffeur"}…`}
        quickReplies={isFleet ? QUICK_FLEET : QUICK_DRIVER}
      />
    </div>
  );
}
