"use client";
import { FLEET_REPORT_META, PRESENCE_META, fleetReportTitle, type ChatMessage, type ChatOverview, type FleetReportType } from "@rydar/shared";
import { CheckCheck, RadioTower, Search, X } from "lucide-react";
import { PRESENCE_COLOR } from "@/components/map/map-theme";
import { Avatar } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { FLEET_THREAD, firstName, whenShort, type DriverThreadSummary } from "./chat-utils";

/** Extrait du dernier message : « Vous : … », « Karim : … », « 🚓 Police signalée par Karim ». */
export function messagePreview(m: ChatMessage | null, meId: string, withAuthor: boolean) {
  if (!m) return null;
  if (m.report_type) {
    const type = m.report_type as FleetReportType;
    return `${FLEET_REPORT_META[type].emoji} ${fleetReportTitle(type, m.author_user_id === meId ? "vous" : firstName(m.author_name))}`;
  }
  const who = m.author_type === "user" ? (m.author_user_id === meId ? "Vous" : firstName(m.author_name)) : withAuthor ? firstName(m.author_name) : null;
  return who ? `${who} : ${m.body}` : m.body;
}

function UnreadBadge({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className="grid h-[19px] min-w-[19px] place-items-center rounded-full bg-brand px-1.5 text-[11px] font-semibold tabular-nums text-brand-fg" aria-label={`${n} non lu${n > 1 ? "s" : ""}`}>
      {n > 99 ? "99+" : n}
    </span>
  );
}

export function ThreadList({
  fleet,
  drivers,
  selected,
  onSelect,
  query,
  onQuery,
  meId,
  timeZone,
  now,
  unreadTotal,
}: {
  fleet: ChatOverview["fleet"];
  drivers: DriverThreadSummary[];
  selected: string | null;
  onSelect: (thread: DriverThreadSummary["thread"] | typeof FLEET_THREAD) => void;
  query: string;
  onQuery: (q: string) => void;
  meId: string;
  timeZone: string;
  now: number;
  unreadTotal: number;
}) {
  const term = query.trim().toLowerCase();
  const list = term
    ? drivers.filter((t) => `${t.driver.first_name} ${t.driver.last_name} ${t.driver.number}`.toLowerCase().includes(term))
    : drivers;
  const talking = list.filter((t) => t.last_message);
  const others = list.filter((t) => !t.last_message);
  const showFleet = !term || "toute la flotte".includes(term);

  const row = (t: DriverThreadSummary) => {
    const d = t.driver;
    const name = `${d.first_name} ${d.last_name}`;
    const m = t.last_message;
    const fromTeam = m?.author_type === "user";
    const seen = fromTeam && !!t.driver_last_read_at && m && new Date(t.driver_last_read_at).getTime() >= new Date(m.created_at).getTime();
    const active = selected === t.thread;
    return (
      <li key={t.thread}>
        <button
          type="button"
          onClick={() => onSelect(t.thread)}
          aria-current={active ? "true" : undefined}
          className={cn(
            "group flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors",
            active ? "bg-white/[0.07]" : "hover:bg-white/[0.035]",
          )}
        >
          <span className="relative shrink-0">
            <Avatar name={name} src={d.photo_url} size={40} />
            <span
              className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-ink-900"
              style={{ background: PRESENCE_COLOR[d.presence] ?? PRESENCE_COLOR.offline }}
              title={PRESENCE_META[d.presence]?.label}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className={cn("truncate text-[13.5px]", t.unread ? "font-semibold text-fg" : "font-medium text-fg")}>{name}</span>
              {d.status !== "active" && <span className="shrink-0 text-[11px] text-fg-subtle">désactivé</span>}
              <span className={cn("ml-auto shrink-0 text-[11px] tabular-nums", t.unread ? "font-medium text-brand" : "text-fg-subtle")}>
                {m ? whenShort(m.created_at, timeZone, now) : ""}
              </span>
            </span>
            <span className="mt-0.5 flex items-center gap-2">
              <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", t.unread ? "text-fg" : "text-fg-subtle")}>
                {m ? messagePreview(m, meId, false) : <span className="text-fg-subtle">{PRESENCE_META[d.presence]?.label ?? "Hors ligne"} · #{d.number}</span>}
              </span>
              {t.unread ? (
                <UnreadBadge n={t.unread} />
              ) : seen ? (
                <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-brand/80" title="Lu par le chauffeur">
                  <CheckCheck className="size-3.5" /> Vu
                </span>
              ) : null}
            </span>
          </span>
        </button>
      </li>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-3 px-4 pb-3 pt-5">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-[20px] font-semibold tracking-tight">Messages</h1>
          <span className="text-[12px] text-fg-subtle">
            {unreadTotal ? (
              <>
                <span className="font-medium text-brand">{unreadTotal}</span> non lu{unreadTotal > 1 ? "s" : ""}
              </>
            ) : (
              "Tout est lu"
            )}
          </span>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Rechercher un chauffeur"
            aria-label="Rechercher un chauffeur"
            className="h-9 w-full rounded-lg border border-line bg-white/[0.03] pl-8.5 pr-8 text-[13px] outline-none placeholder:text-fg-subtle focus:border-brand/40 focus:bg-white/[0.05]"
          />
          {query && (
            <button
              type="button"
              onClick={() => onQuery("")}
              aria-label="Effacer la recherche"
              className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-fg-subtle hover:bg-white/[0.06] hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {showFleet && (
          <button
            type="button"
            onClick={() => onSelect(FLEET_THREAD)}
            aria-current={selected === FLEET_THREAD ? "true" : undefined}
            className={cn(
              "mb-2 flex w-full items-center gap-3 rounded-xl border px-2.5 py-2.5 text-left transition-colors",
              selected === FLEET_THREAD ? "border-brand/25 bg-brand/[0.07]" : "border-line bg-white/[0.02] hover:bg-white/[0.04]",
            )}
          >
            <span className="relative grid size-10 shrink-0 place-items-center rounded-full bg-brand/12 text-brand ring-1 ring-brand/25">
              <RadioTower className="size-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className={cn("truncate text-[13.5px]", fleet.unread ? "font-semibold" : "font-medium")}>Toute la flotte</span>
                <span className={cn("ml-auto shrink-0 text-[11px] tabular-nums", fleet.unread ? "font-medium text-brand" : "text-fg-subtle")}>
                  {fleet.last_message ? whenShort(fleet.last_message.created_at, timeZone, now) : ""}
                </span>
              </span>
              <span className="mt-0.5 flex items-center gap-2">
                <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", fleet.unread ? "text-fg" : "text-fg-subtle")}>
                  {messagePreview(fleet.last_message, meId, true) ?? "Annonces et signalements de la flotte"}
                </span>
                <UnreadBadge n={fleet.unread} />
              </span>
              {fleet.active_reports > 0 && (
                <span className="mt-1.5 inline-flex h-5 items-center gap-1.5 rounded-full bg-amber/10 px-2 text-[11px] font-medium text-amber">
                  <span className="size-1.5 animate-breathe rounded-full bg-amber" />
                  {fleet.active_reports} signalement{fleet.active_reports > 1 ? "s" : ""} actif{fleet.active_reports > 1 ? "s" : ""}
                </span>
              )}
            </span>
          </button>
        )}

        {talking.length > 0 && (
          <>
            <p className="px-2.5 pb-1 pt-3 text-[11.5px] text-fg-subtle">Conversations</p>
            <ul className="space-y-0.5">{talking.map(row)}</ul>
          </>
        )}
        {others.length > 0 && (
          <>
            <p className="px-2.5 pb-1 pt-4 text-[11.5px] text-fg-subtle">{talking.length ? "Autres chauffeurs" : "Chauffeurs"}</p>
            <ul className="space-y-0.5">{others.map(row)}</ul>
          </>
        )}
        {!list.length && (
          <p className="px-3 py-10 text-center text-[12.5px] text-fg-subtle">{term ? "Aucun chauffeur ne correspond." : "Aucun chauffeur actif pour l'instant."}</p>
        )}
      </div>
    </div>
  );
}
