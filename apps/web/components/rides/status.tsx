import {
  PRESENCE_META, RIDE_STATUS_META, isSearching, type DriverPresence, type RideStatus,
} from "@rydar/shared";
import { CalendarClock, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function RideStatusBadge({ status, className }: { status: RideStatus | string; className?: string }) {
  const meta = RIDE_STATUS_META[status as RideStatus] ?? { label: status, tone: "neutral" as const };
  return (
    <Badge tone={meta.tone} pulse={isSearching(status as RideStatus)} className={className}>
      {meta.label}
    </Badge>
  );
}

export function PresenceBadge({ presence, className }: { presence: DriverPresence | string; className?: string }) {
  const meta = PRESENCE_META[presence as DriverPresence] ?? PRESENCE_META.offline;
  return (
    <Badge tone={meta.tone} pulse={presence === "offered"} className={className}>
      {meta.label}
    </Badge>
  );
}

export function RideTypeTag({ type }: { type: "instant" | "scheduled" | string }) {
  return type === "instant" ? (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-fg-subtle">
      <Zap className="size-3" /> Immédiate
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-violet">
      <CalendarClock className="size-3" /> Planifiée
    </span>
  );
}
