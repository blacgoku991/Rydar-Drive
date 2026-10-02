"use client";
import { useEffect, useState, useSyncExternalStore } from "react";

/** Horloge partagée ; null avant le montage (évite les écarts d'hydratation). */
export function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

// Horloges communes (une minuterie par intervalle, quel que soit le nombre d'abonnés) : les petits composants qui
// affichent un compte à rebours ou un « il y a 12 s » se mettent à jour ensemble, sans re-rendre l'écran entier.
type Clock = { now: number | null; subs: Set<() => void>; id: number | null };
const clocks = new Map<number, Clock>();

function clockOf(intervalMs: number): Clock {
  let c = clocks.get(intervalMs);
  if (!c) {
    c = { now: null, subs: new Set(), id: null };
    clocks.set(intervalMs, c);
  }
  return c;
}

// Fonctions stables par intervalle : useSyncExternalStore se réabonne si `subscribe` change d'identité.
const stores = new Map<number, { subscribe: (cb: () => void) => () => void; get: () => number | null }>();

function storeOf(intervalMs: number) {
  let s = stores.get(intervalMs);
  if (!s) {
    const c = clockOf(intervalMs);
    s = {
      subscribe: (cb) => {
        c.subs.add(cb);
        if (c.id == null) {
          // Premier abonné : l'heure réelle remplace l'heure de repli (React relit `get` après l'abonnement)
          c.now = Date.now();
          c.id = window.setInterval(() => {
            c.now = Date.now();
            c.subs.forEach((f) => f());
          }, intervalMs);
        }
        return () => {
          c.subs.delete(cb);
          if (!c.subs.size && c.id != null) {
            window.clearInterval(c.id);
            c.id = null;
          }
        };
      },
      get: () => c.now,
    };
    stores.set(intervalMs, s);
  }
  return s;
}

const NO_TIME = () => null;

/**
 * Heure courante partagée par tous les abonnés du même intervalle. `fallback` (souvent l'heure du rendu serveur) sert
 * au rendu serveur et à l'hydratation, pour un premier affichage identique des deux côtés.
 */
export function useSharedNow(intervalMs: number, fallback: number): number {
  const store = storeOf(intervalMs);
  const now = useSyncExternalStore(store.subscribe, store.get, NO_TIME);
  return now ?? fallback;
}
