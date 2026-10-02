"use client";
import { useCallback, useEffect, useRef } from "react";
import { useRealtimeGeneration, useRealtimeStatus } from "@/components/realtime/realtime-provider";

type Options = {
  /** Repli sans temps réel : premier délai du sondage (ms), puis ×3 à chaque tour jusqu'à `maxPollMs`. */
  pollMs?: number;
  maxPollMs?: number;
  /** Temps réel actif : relecture de sécurité (ms), onglet visible seulement. Absent : aucune. */
  livePollMs?: number;
  /** Regroupement des demandes `schedule()` (ms). */
  debounceMs?: number;
  /** Retour sur l'onglet après au moins ce délai caché (ms) : relecture même sans événement manqué. Absent : jamais. */
  resyncAfterHiddenMs?: number;
};

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * Synchronisation d'un écran alimenté par le temps réel, sans requête inutile :
 * - `schedule()` (après un événement) : relecture regroupée, différée au retour sur l'onglet s'il est caché ;
 * - réabonnement du canal après une coupure, ou retour du temps réel après un repli : relecture immédiate
 *   (les événements de la coupure sont perdus) ;
 * - repli (statut « offline » seulement, pas pendant la connexion) : sondage à délai croissant, en pause tant que
 *   l'onglet est caché, relance immédiate quand il redevient visible.
 */
export function useLiveSync(sync: () => void, { pollMs = 5000, maxPollMs = 60_000, livePollMs, debounceMs = 400, resyncAfterHiddenMs }: Options = {}) {
  const status = useRealtimeStatus();
  const generation = useRealtimeGeneration();
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const lastSync = useRef(Date.now());
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);

  const run = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    dirty.current = false;
    lastSync.current = Date.now();
    syncRef.current();
  }, []);

  const schedule = useCallback(() => {
    if (hidden()) {
      dirty.current = true;
      return;
    }
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(run, debounceMs);
  }, [run, debounceMs]);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  // Réabonnement après une coupure (generation > 1), ou temps réel retrouvé après un repli hors ligne
  const prev = useRef({ generation, status });
  useEffect(() => {
    const before = prev.current;
    prev.current = { generation, status };
    if (generation > before.generation && (before.generation >= 1 || before.status === "offline")) {
      if (hidden()) dirty.current = true;
      else run();
    }
  }, [generation, status, run]);

  // Onglet caché puis visible : ce qui a été manqué (événement, sondage en pause, longue absence) est relu
  const hiddenAt = useRef<number | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    const onVisibility = () => {
      if (hidden()) {
        hiddenAt.current = Date.now();
        return;
      }
      const away = hiddenAt.current ? Date.now() - hiddenAt.current : 0;
      hiddenAt.current = null;
      if (dirty.current || statusRef.current === "offline" || (resyncAfterHiddenMs != null && away >= resyncAfterHiddenMs)) run();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [run, resyncAfterHiddenMs]);

  // Repli : sondage à délai croissant tant que le temps réel est hors ligne (rien pendant la connexion)
  useEffect(() => {
    if (status !== "offline") return;
    let delay = pollMs;
    let id = 0;
    const tick = () => {
      if (!hidden()) {
        run();
        delay = Math.min(maxPollMs, delay * 3);
      } else dirty.current = true;
      id = window.setTimeout(tick, delay);
    };
    id = window.setTimeout(tick, delay);
    return () => window.clearTimeout(id);
  }, [status, pollMs, maxPollMs, run]);

  // Temps réel actif : relecture de sécurité (broadcasts perdus sans coupure détectée), onglet visible seulement
  useEffect(() => {
    if (status !== "live" || !livePollMs) return;
    const id = window.setInterval(() => {
      if (!hidden() && Date.now() - lastSync.current >= livePollMs - 1000) run();
    }, livePollMs);
    return () => window.clearInterval(id);
  }, [status, livePollMs, run]);

  return { schedule, syncNow: run };
}
