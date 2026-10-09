"use client";
// Réglages du simulateur partagés avec le test (budget testé joint à la demande, simulation du résultat).
import { SIMULATOR } from "@rydar/shared";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

type SimState = {
  budget: number;
  fare: number;
  conversion: number;
  /** Le visiteur a réglé le simulateur lui-même (sinon le résultat du test part de sa réponse « budget »). */
  touched: boolean;
  set: (patch: Partial<Pick<SimState, "budget" | "fare" | "conversion">>) => void;
};

const SimContext = createContext<SimState | null>(null);

export function SimProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<SimState, "set">>({
    budget: SIMULATOR.budget.default,
    fare: SIMULATOR.fare.default,
    conversion: SIMULATOR.conversion.default,
    touched: false,
  });
  const value = useMemo<SimState>(
    () => ({ ...state, set: (patch) => setState((cur) => ({ ...cur, ...patch, touched: true })) }),
    [state],
  );
  return <SimContext.Provider value={value}>{children}</SimContext.Provider>;
}

export function useSim(): SimState {
  const ctx = useContext(SimContext);
  if (!ctx) throw new Error("useSim : SimProvider manquant");
  return ctx;
}
