import { formatPrice, formatRelative } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import {
  PRIVATE_SOURCE_LABELS, UPCOMING_STATUSES, appPresence, bookingKind, bookingKindMeta, bookingPrice, bookingRoute, countLabel, responseDeadline,
} from "./booking-meta";

// Libellés d'une réservation de la Flotte Privée (docs/FLOTTE-PRIVEE.md § 7.3) : couleur = information (mêmes
// catégories que l'application), échéance de réponse dans le fuseau de l'ORGANISATION, état de l'application.

const TZ = "Europe/Paris";
const NOW = Date.parse("2026-10-20T08:00:00Z"); // mardi 20 octobre, 10:00 à Paris

describe("catégorie et trajet", () => {
  it("catégories de l'agenda : à confirmer, non confirmée, heure dépassée, confirmée", () => {
    expect(bookingKind({ status: "OFFERED", pickup_at: "2026-10-21T08:00:00Z", state: "to_confirm" }, NOW)).toBe("to_confirm");
    expect(bookingKind({ status: "NO_DRIVER_FOUND", pickup_at: "2026-10-21T08:00:00Z", state: "declined" }, NOW)).toBe("declined");
    expect(bookingKind({ status: "ACCEPTED", type: "scheduled", pickup_at: "2026-10-20T07:00:00Z" }, NOW)).toBe("overdue");
    expect(bookingKind({ status: "ACCEPTED", type: "scheduled", pickup_at: "2026-10-20T09:00:00Z" }, NOW)).toBe("confirmed");
    expect(bookingKindMeta("not_confirmed")).toEqual({ label: "Non confirmée", tone: "red" });
    expect(bookingKindMeta("to_confirm")).toEqual({ label: "À confirmer", tone: "amber" });
  });

  it("trajet abrégé ; adresse absente : tiret", () => {
    expect(bookingRoute({ pickup_address: "Aéroport d'Orly, Terminal 4, 94390 Orly", dropoff_address: "12 Rue de Rivoli, 75004 Paris" })).toBe(
      "Aéroport d'Orly → 12 Rue de Rivoli",
    );
    expect(bookingRoute({ pickup_address: "Gare de Lyon, 75012 Paris", dropoff_address: null })).toBe("Gare de Lyon → —");
  });

  it("prix : montant, ou « prix à fixer » pour une demande sans prix ; euro par défaut", () => {
    expect(bookingPrice(8500, "EUR")).toBe(formatPrice(8500, "EUR"));
    expect(bookingPrice(8550, null)).toBe(formatPrice(8550, "EUR"));
    expect(bookingPrice(null)).toBe("prix à fixer");
    expect(bookingPrice(undefined, "EUR")).toBe("prix à fixer");
  });

  it("origine au vocabulaire du chauffeur ; prochaines courses : confirmées et en cours", () => {
    expect(PRIVATE_SOURCE_LABELS.api).toBe("Votre site");
    expect(PRIVATE_SOURCE_LABELS.dashboard).toBe("Téléphone");
    expect(UPCOMING_STATUSES).toEqual(["ACCEPTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"]);
  });
});

describe("échéance de réponse (fuseau de l'organisation)", () => {
  it("aujourd'hui, demain, plus tard ; échéance passée ; aucune ou illisible", () => {
    expect(responseDeadline("2026-10-20T09:30:00Z", TZ, NOW)).toBe("Réponse avant 11:30");
    expect(responseDeadline("2026-10-21T05:30:00Z", TZ, NOW)).toBe("Réponse avant demain 07:30");
    expect(responseDeadline("2026-10-22T05:30:00Z", TZ, NOW)).toBe("Réponse avant jeu. 22/10 07:30");
    expect(responseDeadline("2026-10-20T08:00:00Z", TZ, NOW)).toBe("Réponse attendue maintenant");
    expect(responseDeadline("2026-10-20T07:59:00Z", TZ, NOW)).toBe("Réponse attendue maintenant");
    expect(responseDeadline(null, TZ, NOW)).toBeNull();
    expect(responseDeadline("demain", TZ, NOW)).toBeNull();
  });

  it("autour de minuit, le jour dépend du fuseau de l'organisation", () => {
    const now = Date.parse("2026-10-20T21:30:00Z"); // 23:30 à Paris, 17:30 à New York
    expect(responseDeadline("2026-10-20T22:30:00Z", TZ, now)).toBe("Réponse avant demain 00:30");
    expect(responseDeadline("2026-10-20T22:30:00Z", "America/New_York", now)).toBe("Réponse avant 18:30");
  });
});

describe("état de l'application du chauffeur", () => {
  const active = (presence: "offline" | "available" | "offered" | "on_trip" | "en_route", last_seen_at: string | null = null) =>
    appPresence({ status: "active", presence, last_seen_at }, NOW);

  it("en ligne, en course, hors ligne (dernière activité, ou application jamais ouverte)", () => {
    expect(active("available")).toEqual({ label: "Application en ligne", tone: "brand", detail: null });
    expect(active("offered")).toEqual({ label: "Application en ligne", tone: "brand", detail: null });
    expect(active("on_trip")).toEqual({ label: "En course", tone: "cyan", detail: null });
    expect(active("en_route").label).toBe("En course");
    expect(active("offline", "2026-10-20T07:57:00Z")).toEqual({
      label: "Application hors ligne",
      tone: "neutral",
      detail: `dernière activité ${formatRelative("2026-10-20T07:57:00Z", new Date(NOW))}`,
    });
    expect(active("offline", "2026-10-20T07:57:00Z").detail).toMatch(/^dernière activité il y a 3\smin$/);
    expect(active("offline").detail).toBe("application jamais ouverte");
  });

  it("fiche inactive ou supprimée : en rouge, réservations plus proposées", () => {
    const presence = (status: "invited" | "inactive" | "suspended") => appPresence({ status, presence: "available", last_seen_at: null }, NOW);
    expect(presence("invited").label).toBe("Fiche en attente d'activation");
    expect(presence("inactive").label).toBe("Fiche désactivée");
    expect(presence("suspended")).toEqual({ label: "Fiche suspendue", tone: "red", detail: "vos réservations ne vous sont plus proposées" });
    expect(appPresence(null, NOW)).toEqual({ label: "Fiche chauffeur supprimée", tone: "red", detail: "vos réservations ne vous sont plus proposées" });
  });
});

it("compteurs : singulier jusqu'à 1, espace insécable", () => {
  expect(countLabel(0, "réservation", "réservations")).toBe("0\u00a0réservation");
  expect(countLabel(1, "réservation", "réservations")).toBe("1\u00a0réservation");
  expect(countLabel(3, "réservation", "réservations")).toBe("3\u00a0réservations");
});
