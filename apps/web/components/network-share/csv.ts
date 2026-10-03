// Relevé mensuel du réseau partagé (export CSV, spec §10.11) : MÊMES colonnes et totaux pour l'organisation qui
// confie (« Courses confiées ») et celle du chauffeur (« Courses reçues »), calculés depuis les termes figés de chaque
// course → chiffres identiques des deux côtés. Format du dépôt (modèle settlements/rydar/export) : UTF-8 avec BOM,
// séparateur « ; », montants « 12,50 », cellule commençant par = + - @ tabulation ou retour chariot préfixée d'une
// apostrophe (sauf montant négatif). Module pur (tests : csv.test.ts).
import {
  dateTimeFormat,
  type NetworkGivenItem, type NetworkReceivedItem, type SettlementDirection, type SettlementStatus,
} from "@rydar/shared";
import { driverShortLabel } from "./received";

export const CSV_BOM = "﻿";

/** Centimes → « 12,50 » ; « -2,00 » ; vide si null. */
export function euros(cents: number | null | undefined): string {
  if (cents == null || Number.isNaN(cents)) return "";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

/** Cellule : formules neutralisées (=, +, -, @, tabulation, retour chariot en tête), sauf les montants « -2,00 ». */
export function csvCell(v: string | number | null | undefined): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-\d+,\d{2}$/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (values: (string | number | null | undefined)[]) => values.map(csvCell).join(";");

function dateTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  try {
    return dateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Une course du relevé (identique chez A et chez B). */
export interface NetworkStatementRow {
  endedAt: string | null;
  reference: string;
  giver: string;
  executor: string;
  driver: string;
  priceCents: number;
  giverPartCents: number;
  driverPartCents: number;
  direction: SettlementDirection;
  amountCents: number;
  state: string;
}

/** État du règlement, mêmes mots des deux côtés. */
export function statementState(s: { status: SettlementStatus; direction: SettlementDirection; overdue: boolean; on_hold: boolean } | null): string {
  if (!s) return "Sans règlement";
  switch (s.status) {
    case "declared":
      return "Déclaré payé";
    case "paid":
      return "Réglé";
    case "waived":
      return "Annulé";
    case "disputed":
      return "Contesté";
    default:
      if (s.on_hold) return "Retenu (à vérifier)";
      if (s.overdue) return "En retard";
      return s.direction === "driver_owes" ? "À reverser" : "À verser";
  }
}

const DIRECTION_TEXT: Record<SettlementDirection, string> = {
  driver_owes: "Payée à bord : le chauffeur reverse",
  centrale_owes: "Déjà payée : versement au chauffeur",
};

/** Seules les courses terminées entrent dans le relevé (une course retirée ou annulée ne crée aucun montant). */
const completedGiven = (i: NetworkGivenItem) =>
  i.ride.status === "COMPLETED" && (i.execution.end_reason == null || i.execution.end_reason === "completed");
const completedReceived = (i: NetworkReceivedItem) =>
  i.ride.status === "COMPLETED" && (i.end_reason == null || i.end_reason === "completed");

/** Courses confiées (A) → lignes du relevé. */
export function statementRowsFromGiven(items: NetworkGivenItem[], orgName: string): NetworkStatementRow[] {
  return items.filter(completedGiven).map((i) => {
    const t = i.execution.terms;
    return {
      endedAt: i.execution.ended_at ?? i.ride.completed_at,
      reference: i.settlement?.reference ?? `R${i.ride.number}`,
      giver: orgName,
      executor: i.execution.partner.name,
      driver: i.execution.driver_label,
      priceCents: t.price_cents,
      giverPartCents: t.giver_cut_cents,
      driverPartCents: t.driver_payout_cents,
      direction: t.direction,
      amountCents: t.amount_cents,
      state: statementState(
        i.settlement ? { status: i.settlement.status, direction: i.settlement.direction, overdue: i.settlement.overdue, on_hold: i.execution.on_hold } : null,
      ),
    };
  });
}

/** Courses reçues (B) → lignes du relevé (part de A = prix − part du chauffeur : jamais son détail). */
export function statementRowsFromReceived(items: NetworkReceivedItem[], orgName: string): NetworkStatementRow[] {
  return items.filter(completedReceived).map((i) => ({
    endedAt: i.ended_at ?? i.ride.completed_at,
    reference: i.reference,
    giver: i.giver.name,
    executor: orgName,
    driver: driverShortLabel(i.driver),
    priceCents: i.money.price_cents,
    giverPartCents: i.money.price_cents - i.money.driver_part_cents,
    driverPartCents: i.money.driver_part_cents,
    direction: i.money.direction,
    amountCents: i.money.amount_cents,
    state: statementState(
      i.settlement ? { status: i.settlement.status, direction: i.money.direction, overdue: i.settlement.overdue, on_hold: i.settlement.on_hold } : null,
    ),
  }));
}

export interface NetworkStatementTotals {
  rides: number;
  priceCents: number;
  giverPartCents: number;
  driverPartCents: number;
  /** Payées à bord : montants dus par les chauffeurs (part de l'organisation qui confie), réglés ou non */
  driverOwesCents: number;
  /** Déjà payées : montants dus aux chauffeurs (leur part), réglés ou non */
  payoutCents: number;
}

export function statementTotals(rows: NetworkStatementRow[]): NetworkStatementTotals {
  const t: NetworkStatementTotals = { rides: 0, priceCents: 0, giverPartCents: 0, driverPartCents: 0, driverOwesCents: 0, payoutCents: 0 };
  for (const r of rows) {
    t.rides += 1;
    t.priceCents += r.priceCents;
    t.giverPartCents += r.giverPartCents;
    t.driverPartCents += r.driverPartCents;
    if (r.direction === "driver_owes") t.driverOwesCents += r.amountCents;
    else t.payoutCents += r.amountCents;
  }
  return t;
}

export const STATEMENT_HEADER = [
  "Date de fin",
  "Référence",
  "Organisation qui confie",
  "Organisation du chauffeur",
  "Chauffeur",
  "Prix (€)",
  "Part de l'organisation qui confie (€)",
  "Part du chauffeur (€)",
  "Sens",
  "Montant du règlement (€)",
  "État",
];

/** Relevé complet : en-tête, totaux, puis une ligne par course terminée (ordre chronologique). */
export function networkStatementCsv(opts: {
  view: "confiees" | "recues";
  orgName: string;
  month: string;
  partnerName: string | null;
  rows: NetworkStatementRow[];
  timeZone: string;
}): string {
  const rows = [...opts.rows].sort((a, b) => (a.endedAt ?? "").localeCompare(b.endedAt ?? ""));
  const t = statementTotals(rows);
  const lines = [
    csvLine([
      opts.view === "confiees" ? "Relevé du réseau partagé — courses confiées" : "Relevé du réseau partagé — courses reçues",
      opts.orgName,
      `Mois ${opts.month}`,
      opts.partnerName ? `Partenaire ${opts.partnerName}` : "Tous les partenaires",
    ]),
    csvLine(["Courses terminées", t.rides]),
    csvLine(["Total des prix (€)", euros(t.priceCents)]),
    csvLine(["Part de l'organisation qui confie (€)", euros(t.giverPartCents)]),
    csvLine(["Part des chauffeurs (€)", euros(t.driverPartCents)]),
    csvLine(["Dû par les chauffeurs, courses payées à bord (€)", euros(t.driverOwesCents)]),
    csvLine(["Dû aux chauffeurs, courses déjà payées (€)", euros(t.payoutCents)]),
    "",
    csvLine(STATEMENT_HEADER),
    ...rows.map((r) =>
      csvLine([
        dateTime(r.endedAt, opts.timeZone),
        r.reference,
        r.giver,
        r.executor,
        r.driver,
        euros(r.priceCents),
        euros(r.giverPartCents),
        euros(r.driverPartCents),
        DIRECTION_TEXT[r.direction],
        euros(r.amountCents),
        r.state,
      ]),
    ),
  ];
  return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}

/** Nom de fichier : « rydar-reseau-partage-confiees-taxi-sud-2026-09.csv ». */
export function statementFileName(view: "confiees" | "recues", orgSlug: string | null | undefined, month: string): string {
  const slug = (orgSlug || "organisation").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "organisation";
  return `rydar-reseau-partage-${view}-${slug}-${month}.csv`;
}
