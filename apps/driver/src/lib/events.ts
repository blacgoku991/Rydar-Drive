import { useEffect, useRef } from "react";
import type { SettlementEvent } from "@rydar/shared";

/**
 * Petits signaux applicatifs (temps réel, notifications → écrans ouverts), sans dépendance :
 *  - « documents » : un document a changé (validation, refus, échéance) ;
 *  - « ride »      : une course a changé (payload = ride_id, ex. vol retardé) ;
 *  - « messages:tab » : ouvrir l'onglet Centrale / Flotte de l'écran Messages déjà affiché ;
 *  - « report:focus » : centrer l'accueil sur un signalement (payload = { id, lat?, lng? }) ;
 *  - « settlements » : un règlement a changé (mode centrale : créé, déclaré, confirmé, contesté…).
 */
export type AppEventMap = {
  documents: undefined;
  ride: string | undefined;
  "messages:tab": "dispatch" | "fleet";
  "report:focus": { id: string; lat?: number; lng?: number };
  settlements: SettlementEvent | undefined;
};

type Listener<K extends keyof AppEventMap> = (payload: AppEventMap[K]) => void;

const listeners = new Map<keyof AppEventMap, Set<Listener<never>>>();

export const appEvents = {
  on<K extends keyof AppEventMap>(name: K, fn: Listener<K>) {
    const set = listeners.get(name) ?? new Set();
    set.add(fn as Listener<never>);
    listeners.set(name, set);
    return () => void set.delete(fn as Listener<never>);
  },
  emit<K extends keyof AppEventMap>(name: K, ...payload: AppEventMap[K] extends undefined ? [] : [AppEventMap[K]]) {
    for (const fn of listeners.get(name) ?? []) {
      try {
        (fn as Listener<K>)(payload[0] as AppEventMap[K]);
      } catch {
        /* un écran ne doit pas bloquer les autres */
      }
    }
  },
};

/** Abonnement d'un écran à un signal (le dernier callback est toujours utilisé). */
export function useAppEvent<K extends keyof AppEventMap>(name: K, fn: Listener<K>) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => appEvents.on(name, (p) => ref.current(p)), [name]);
}
