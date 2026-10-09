// Formats du test et du simulateur (formateurs Intl mémorisés de @rydar/shared, jamais new Intl.* au rendu).
import { numberFormat } from "@rydar/shared";

/** 3420 → « 3 420 € » ; decimals = 2 → « 13,88 € ». */
export const eur = (value: number, decimals = 0) =>
  numberFormat("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);

/** 1500 → « 1 500 ». */
export const int = (value: number) => numberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value);

/** 0.25 → « 25 % ». */
export const pct = (value: number) => numberFormat("fr-FR", { style: "percent", maximumFractionDigits: 0 }).format(value);
