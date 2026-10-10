"use client";
import { PRESENCE_META, formatDistance } from "@rydar/shared";
import { Ban, RotateCcw, Search, UserCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { assignRide, cancelRide, redispatchRide } from "@/app/dashboard/rides/actions";
import { PRESENCE_COLOR } from "@/components/map/map-theme";
import { ASSIGN_SEARCH_MIN, groupAssignable, type AssignableDriver } from "@/components/rides/assignable";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { Field, Textarea } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { cn } from "@/lib/utils";

export type { AssignableDriver } from "@/components/rides/assignable";

export function RideActions({
  rideId,
  number,
  canCancel,
  canRedispatch,
  canAssign,
  drivers,
  compact,
  assignOpen: assignOpenProp,
  onAssignOpenChange,
  assignLabel = "Attribuer",
  assignDescription,
}: {
  compact?: boolean;
  rideId: string;
  number: number;
  canCancel: boolean;
  canRedispatch: boolean;
  canAssign: boolean;
  /** Liste de `assignableDrivers` (même liste depuis la fiche et depuis En direct) */
  drivers: AssignableDriver[];
  /** Fenêtre d'attribution pilotée de l'extérieur (bandeau d'alerte, toast « Réattribuer »). */
  assignOpen?: boolean;
  onAssignOpenChange?: (open: boolean) => void;
  assignLabel?: string;
  /** Texte de la fenêtre d'attribution (ex. course tenue par un chauffeur partenaire : il est prévenu du retrait). */
  assignDescription?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [assignOpenState, setAssignOpenState] = useState(false);
  const assignOpen = assignOpenProp ?? assignOpenState;
  const setAssignOpen = (o: boolean) => (onAssignOpenChange ? onAssignOpenChange(o) : setAssignOpenState(o));
  const [reason, setReason] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const reassign = assignLabel === "Réattribuer";

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string, after?: () => void) =>
    start(() => runAction(async () => {
      const res = await fn();
      if (!res.ok) toast.error(res.error ?? "Action impossible");
      else {
        toast.success(success);
        after?.();
        router.refresh();
      }
    }));

  return (
    <>
      {canRedispatch && (
        <Button variant="secondary" size={compact ? "sm" : "md"} disabled={pending} onClick={() => run(() => redispatchRide(rideId), "Recherche relancée")}>
          <RotateCcw /> {compact ? "Relancer" : "Relancer la recherche"}
        </Button>
      )}
      {canAssign && (
        <Button variant="secondary" size={compact ? "sm" : "md"} disabled={pending} onClick={() => setAssignOpen(true)}>
          <UserCheck /> {assignLabel}
        </Button>
      )}
      {canCancel && (
        <Button variant="danger" size={compact ? "sm" : "md"} disabled={pending} onClick={() => setCancelOpen(true)}>
          <Ban /> Annuler la course
        </Button>
      )}

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent title={`Annuler la course #${number}`} description="Les propositions en cours sont fermées et le chauffeur éventuellement attribué est prévenu.">
          <Field label="Motif" optional>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={"ex. : client injoignable, vol annulé"} />
          </Field>
          <DialogFooter backDisabled={pending}>
            <Button variant="danger" loading={pending} onClick={() => run(() => cancelRide(rideId, reason), "Course annulée", () => setCancelOpen(false))}>
              Annuler la course
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={assignOpen}
        onOpenChange={(o) => {
          setAssignOpen(o);
          if (!o) setQuery("");
        }}
      >
        <DialogContent
          title={reassign ? `Réattribuer la course #${number}` : `Attribuer la course #${number}`}
          description={
            assignDescription ??
            (reassign
              ? "Le chauffeur actuel est prévenu que la course lui est retirée ; le nouveau reçoit immédiatement une notification."
              : "Le chauffeur reçoit immédiatement une notification. Les propositions en cours sont fermées.")
          }
          size="lg"
        >
          <AssignPicker drivers={drivers} picked={picked} onPick={setPicked} query={query} onQuery={setQuery} />
          <DialogFooter backDisabled={pending}>
            <Button
              variant="primary"
              disabled={!picked}
              loading={pending}
              onClick={() => picked && run(() => assignRide(rideId, picked), "Course attribuée", () => setAssignOpen(false))}
            >
              {reassign ? "Réattribuer la course" : "Attribuer la course"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Choix du chauffeur : disponibles maintenant, occupés, hors ligne (replié), chacun du plus proche au plus loin ; champ
 * « Nom, plaque » à partir de 8 chauffeurs. Aucun chauffeur n'est retiré de la liste (le serveur garde ses contrôles).
 */
function AssignPicker({
  drivers,
  picked,
  onPick,
  query,
  onQuery,
}: {
  drivers: AssignableDriver[];
  picked: string | null;
  onPick: (id: string) => void;
  query: string;
  onQuery: (q: string) => void;
}) {
  const groups = useMemo(() => groupAssignable(drivers, query), [drivers, query]);
  const shown = groups.available.length + groups.busy.length + groups.offline.length;
  if (!drivers.length) {
    return <p className="rounded-xl border border-line px-4 py-6 text-center text-[13px] text-fg-muted">Aucun autre chauffeur actif.</p>;
  }
  const row = (d: AssignableDriver) => {
    const busy = d.presence !== "available" && d.presence !== "offline";
    const on = picked === d.id;
    return (
      <button
        key={d.id}
        type="button"
        role="radio"
        aria-checked={on}
        onClick={() => onPick(d.id)}
        className={cn("flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left", on ? "bg-brand/10 ring-1 ring-brand/40" : "hover:bg-white/[0.04]")}
      >
        <span aria-hidden className="mt-[7px] size-2 shrink-0 rounded-full" style={{ background: PRESENCE_COLOR[d.presence] }} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-[13.5px] font-medium text-fg">
              {d.name} <span className="num font-normal text-fg-subtle">#{d.number}</span>
            </span>
            <span className="num shrink-0 text-[12.5px] text-fg-muted">
              {d.distance_m != null ? formatDistance(d.distance_m) : "position inconnue"}
            </span>
          </span>
          {/* Véhicule sur sa propre ligne (lisible sur téléphone) ; état seulement pour un chauffeur occupé */}
          <span className="block break-words text-[12px] text-fg-muted">{d.vehicle}</span>
          {busy && <span className="block text-[12px] text-fg-muted">{PRESENCE_META[d.presence].label}</span>}
        </span>
      </button>
    );
  };
  const heading = (text: string) => <p className="px-3 pb-1 pt-2 text-[12px] font-medium text-fg-muted">{text}</p>;
  return (
    <div className="space-y-2">
      {drivers.length >= ASSIGN_SEARCH_MIN && (
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Nom, plaque"
            aria-label="Rechercher un chauffeur (nom, plaque)"
            title="Rechercher un chauffeur (nom, plaque)"
            autoComplete="off"
            className="h-10 w-full rounded-lg border border-line-field bg-ink-850 pl-9 pr-3 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-brand/60 focus-visible:ring-2 focus-visible:ring-brand/40"
          />
        </div>
      )}
      <div role="radiogroup" aria-label="Chauffeur" className="max-h-[50vh] space-y-1 overflow-y-auto rounded-xl border border-line p-1.5">
        {shown === 0 && <p className="px-3 py-6 text-center text-[13px] text-fg-muted">Aucun chauffeur ne correspond à «&nbsp;{query.trim()}&nbsp;».</p>}
        {groups.available.length > 0 && (
          <div>
            {heading(`Disponibles maintenant (${groups.available.length})`)}
            {groups.available.map(row)}
          </div>
        )}
        {groups.busy.length > 0 && (
          <div>
            {heading(`Occupés (${groups.busy.length})`)}
            {groups.busy.map(row)}
          </div>
        )}
        {groups.offline.length > 0 && (
          <Disclosure
            title={`Hors ligne (${groups.offline.length})`}
            // Recherche qui ne trouve que des chauffeurs hors ligne, ou chauffeur choisi parmi eux : ouvert d'office
            forceOpen={(!!query.trim() && groups.available.length + groups.busy.length === 0) || groups.offline.some((d) => d.id === picked)}
            summaryClassName="px-3 text-[12px] text-fg-muted"
          >
            {groups.offline.map(row)}
          </Disclosure>
        )}
      </div>
    </div>
  );
}
