// Frais plateforme Rydar (mode centrale) : saisie, affichage, calcul.
// Module neutre (ni « use client » ni « server-only ») : utilisable par les pages serveur et les formulaires.
import { formatNumber, formatPrice } from "@rydar/shared";

/** « 5 », « 5,50 », « 5.5 » → centimes (NaN si illisible, 0 si vide). */
export function eurosToCents(value: string): number {
  const v = value.trim().replace(/\s/g, "").replace(",", ".");
  if (v === "") return 0;
  return /^\d+(\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : Number.NaN;
}

/** « 2,5 » → 2.5 (NaN si illisible, 0 si vide). */
export function parsePercent(value: string): number {
  const v = value.trim().replace(/\s/g, "").replace(",", ".");
  if (v === "") return 0;
  return /^\d+(\.\d{1,2})?$/.test(v) ? Number(v) : Number.NaN;
}

export const centsToInput = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2).replace(".", ","));
export const percentToInput = (p: number) => String(Number(p)).replace(".", ",");

/** Frais plateforme d'une course (miroir de private.compute_ride_split). */
export function platformFee(priceCents: number, percent: number, fixedCents: number) {
  return Math.min(priceCents, Math.round((priceCents * percent) / 100) + fixedCents);
}

/** « 2 % + 5 € », « 5 € », « Aucun ». */
export function formatPlatformFee(percent: number | string | null | undefined, fixedCents: number | null | undefined) {
  const p = Number(percent ?? 0);
  const f = Number(fixedCents ?? 0);
  const parts: string[] = [];
  if (p) parts.push(`${formatNumber(p, p % 1 ? (Math.round(p * 10) === p * 10 ? 1 : 2) : 0)} %`);
  if (f) parts.push(formatPrice(f));
  return parts.length ? parts.join(" + ") : "Aucun";
}

/** Valide la saisie des frais → valeurs numériques, ou erreurs de champ. */
export function readFees(percent: string, fixed: string) {
  const p = parsePercent(percent);
  const f = eurosToCents(fixed);
  const errors: { percent?: string; fixed?: string } = {};
  if (!Number.isFinite(p) || p < 0 || p > 50) errors.percent = "Entre 0 et 50 %";
  if (!Number.isFinite(f) || f < 0 || f > 100_000) errors.fixed = "Entre 0 et 1 000 €";
  return { percent: p, fixedCents: f, errors, valid: !errors.percent && !errors.fixed };
}
