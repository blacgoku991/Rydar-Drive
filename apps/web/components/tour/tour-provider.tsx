"use client";
// Visite guidée de première connexion (docs/TUTORIEL.md § 5, § 6.2, § 6.9, § 10) : fournisseur des deux coquilles.
//  - état de la visite (useReducer sur tourReducer), clé `${utilisateur}:${parcours}` : un changement d'organisation
//    ou de rôle qui change de parcours repart de son propre état — sans remonter la page (les enfants ne sont pas sous
//    la clé) ;
//  - ouverture d'office après le montage (~400 ms), jamais pendant une acceptation, une lecture en échec ou une
//    urgence ; réévaluée quand l'acceptation ou l'urgence se lève (CGV acceptées : router.refresh de la mise en page) ;
//  - écritures en série (save_user_tour par l'action serveur, une à la fois, la dernière gagne), toasts pause / fin,
//    un seul toast d'échec par session (la visite continue : l'état de la page fait foi) ;
//  - relecture des conditions de réussite, seulement fenêtre dépliée sur une étape ;
//  - entrée du menu du compte (useTourMenu) : « Reprendre la visite » / « Revoir la visite ».
// La fenêtre (tour-card.tsx) est chargée à la demande : rien n'est téléchargé tant que la visite est fermée.
import { Compass } from "lucide-react";
import dynamic from "next/dynamic";
import { Suspense, createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import type { TourStatus } from "@rydar/shared";
import { saveTourProgress } from "@/app/visite/actions";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { useLiveSync } from "@/components/realtime/use-live-sync";
import type { SidebarAccountItem } from "@/components/shell/sidebar";
import { runAction } from "@/lib/run-action";
import { getBrowserClient } from "@/lib/supabase/client";
import { loadTourChecks, type CheckKey, type TourChecks } from "./tour-checks";
import { TOURS, tourCheckKeys } from "./tour-content";
import {
  TOUR_UI,
  autostartView,
  savedTourState,
  tourMenuItem,
  tourPersist,
  tourReducer,
  type TourBoot,
  type TourEvent,
  type TourIntent,
  type TourRequest,
  type TourScope,
  type TourState,
} from "./tour-model";

const TourCard = dynamic(() => import("./tour-card").then((m) => m.TourCard), { ssr: false });

/** Délai de l'ouverture d'office : après le montage et la stabilisation de la page, jamais pendant l'hydratation. */
const AUTOSTART_DELAY_MS = 400;

type TourMenu = { label: string; onSelect: () => void } | null;
const TourMenuContext = createContext<TourMenu>(null);

/**
 * Entoure le corps d'une coquille. Sans `boot` (coquille sans visite) : rendu inchangé, aucune entrée de menu.
 */
export function TourProvider({ boot, children }: { boot?: TourBoot | null; children: React.ReactNode }) {
  const [menu, setMenu] = useState<TourMenu>(null);
  return (
    <TourMenuContext.Provider value={boot ? menu : null}>
      {children}
      {boot && <TourEngine key={`${boot.scope.userId}:${boot.key}`} boot={boot} onMenu={setMenu} />}
    </TourMenuContext.Provider>
  );
}

/** Entrées du menu du compte (Sidebar.accountItems) : la visite, ou rien (bloquée, ou coquille sans visite). */
export function useTourMenu(): SidebarAccountItem[] {
  const menu = useContext(TourMenuContext);
  return useMemo(
    () => (menu ? [{ key: "visite-guidee", label: menu.label, icon: <Compass aria-hidden />, onSelect: menu.onSelect }] : []),
    [menu],
  );
}

function TourEngine({ boot, onMenu }: { boot: TourBoot; onMenu: (menu: TourMenu) => void }) {
  const def = TOURS[boot.key];
  const total = def.steps.length;
  // Initialisé une fois depuis la base (la mise en page ne se rend pas à chaque navigation : l'état de la page fait foi)
  const [state, dispatch] = useReducer((s: TourState, e: TourEvent) => tourReducer(s, e, total), boot.saved, (saved) => savedTourState(saved, total));
  const [readable] = useState(() => boot.saved !== undefined);
  const [request, setRequest] = useState<TourRequest>({ seq: 0, focus: false, scroll: false, at: 0 });

  const act = useCallback((event: TourEvent | null, intent?: TourIntent) => {
    if (event) dispatch(event);
    if (intent && (intent.focus || intent.scroll)) {
      setRequest((r) => ({ seq: r.seq + 1, focus: !!intent.focus, scroll: !!intent.scroll, at: Date.now() }));
    }
  }, []);

  // ---------------------------------------------------------------------------------------- ouverture d'office (§ 5.2)
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const autoDone = useRef(false);
  useEffect(() => {
    if (autoDone.current || boot.blocked || boot.urgent || !readable) return;
    const timer = window.setTimeout(() => {
      autoDone.current = true;
      const view = autostartView(stateRef.current, { readable, blocked: false, urgent: false });
      if (view) act({ type: "autostart" }, view === "intro" ? { focus: true } : undefined);
    }, AUTOSTART_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [boot.blocked, boot.urgent, readable, act]);

  // ------------------------------------------------------------------------------ écritures en série et toasts (§ 6.2)
  const [, start] = useTransition();
  const queued = useRef<{ tour: string; status: TourStatus; step: number } | null>(null);
  const sending = useRef(false);
  const errorShown = useRef(false);
  const flush = useCallback(() => {
    if (sending.current || !queued.current) return;
    const next = queued.current;
    queued.current = null;
    sending.current = true;
    const failed = () => {
      if (errorShown.current) return;
      errorShown.current = true;
      toast.error(TOUR_UI.saveError);
    };
    start(async () => {
      const result = await runAction(() => saveTourProgress(next), failed);
      if (result && !result.ok) failed();
      sending.current = false;
      // Changement arrivé pendant l'envoi : seul le dernier état part ensuite
      flush();
    });
  }, [start]);
  const persisted = useRef(state);
  useEffect(() => {
    const prev = persisted.current;
    persisted.current = state;
    const write = tourPersist(prev, state);
    if (write) {
      queued.current = { tour: boot.key, ...write };
      flush();
    }
    if (prev.status !== state.status && state.status === "paused") toast(TOUR_UI.paused, { id: "visite-guidee" });
    else if (prev.status !== state.status && state.status === "completed") toast.success(TOUR_UI.finished, { id: "visite-guidee" });
  }, [state, boot.key, flush]);

  // ------------------------------------------------------------------------------------- menu du compte (§ 10)
  const item = tourMenuItem(state, boot.blocked);
  const label = item?.label ?? null;
  const resume = useCallback(() => act({ type: "resume" }, { focus: true, scroll: true }), [act]);
  useEffect(() => {
    onMenu(label ? { label, onSelect: resume } : null);
  }, [label, resume, onMenu]);
  useEffect(() => () => onMenu(null), [onMenu]);

  // -------------------------------------------------------------- conditions de réussite (§ 6.9), fenêtre dépliée
  const [checks, setChecks] = useState<TourChecks>({});
  const [location, setLocation] = useState("");
  const keys = useMemo(() => tourCheckKeys(def), [def]);
  const onStep = state.view === "step" && !state.minimized && !boot.blocked;

  // Acceptation en cours (bloquée) : ni fenêtre ni entrée de menu, même ouverte avant
  if (boot.blocked || state.view === "closed") return null;
  return (
    <>
      {onStep && keys.length > 0 && (
        <TourChecksSync keys={keys} scope={boot.scope} step={state.step} location={location} onChecks={setChecks} />
      )}
      <Suspense fallback={null}>
        <TourCard def={def} state={state} checks={checks} request={request} act={act} onLocation={setLocation} />
      </Suspense>
    </>
  );
}

/**
 * Relecture des conditions de réussite (§ 6.9), montée seulement fenêtre dépliée sur une étape : à l'ouverture, à
 * chaque changement d'étape, d'adresse ou d'organisation ; après tout envoi de formulaire dans la page (1,5 s puis 5 s
 * après) ; sur les événements des courses et des chauffeurs (tableau de bord) ; en secours, par useLiveSync. Onglet
 * caché : rien.
 */
function TourChecksSync({
  keys,
  scope,
  step,
  location,
  onChecks,
}: {
  keys: readonly CheckKey[];
  scope: TourScope;
  step: number;
  location: string;
  onChecks: (checks: TourChecks) => void;
}) {
  const { userId, orgId, driverId } = scope;
  const reload = useCallback(() => {
    if (document.visibilityState === "hidden") return;
    loadTourChecks(getBrowserClient(), keys, { userId, orgId, driverId })
      .then(onChecks)
      .catch(() => undefined);
  }, [keys, userId, orgId, driverId, onChecks]);
  const { schedule } = useLiveSync(reload, { pollMs: 15_000, maxPollMs: 60_000, livePollMs: 30_000, debounceMs: 600 });
  useEffect(() => {
    reload();
  }, [reload, step, location]);
  useEffect(() => {
    const timers = new Set<number>();
    const later = (ms: number) => {
      const id = window.setTimeout(() => {
        timers.delete(id);
        reload();
      }, ms);
      timers.add(id);
    };
    const onSubmit = () => {
      later(1500);
      later(5000);
    };
    document.addEventListener("submit", onSubmit, true);
    return () => {
      document.removeEventListener("submit", onSubmit, true);
      for (const id of timers) window.clearTimeout(id);
    };
  }, [reload]);
  useRealtimeEvent("ride.updated", schedule);
  useRealtimeEvent("driver.updated", schedule);
  return null;
}
