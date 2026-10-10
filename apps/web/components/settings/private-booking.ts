// Flotte Privée, Réglages › Réservations : libellés des délais proposés — module pur, testé (private-booking.test.ts).

const NB = "\u00a0";

/** 30 → « 30 min », 60 → « 1 h », 1440 → « 24 h ». */
export function minutesLabel(m: number): string {
  return m < 60 ? `${m}${NB}min` : `${m / 60}${NB}h`;
}

/** 60 → « 1 min », 90 → « 1 min 30 », 300 → « 5 min ». */
export function secondsLabel(s: number): string {
  const min = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${min}${NB}min${NB}${String(rest).padStart(2, "0")}` : `${min}${NB}min`;
}

/** Valeur actuelle hors des choix proposés : le choix le plus proche (signalé à côté du champ). */
export function nearestChoice(value: number, choices: readonly number[]): number {
  return choices.reduce((best, c) => (Math.abs(c - value) < Math.abs(best - value) ? c : best), choices[0]!);
}
