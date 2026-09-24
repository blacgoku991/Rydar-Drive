import {
  PRESENCE_META, RIDE_STATUS_META, isSearching, type DriverPresence, type RideStatus,
} from "@rydar/shared";
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
    <span className="inline-flex items-center gap-1 rounded-md border border-brand/20 bg-brand/[0.07] px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-brand">
      Immédiate
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-md border border-violet/20 bg-violet/[0.08] px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-violet">
      Planifiée
    </span>
  );
}
