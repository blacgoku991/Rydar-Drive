// Urgence d'une offre (docs/FLOTTE-PRIVEE.md § 10.6) : règle standard inchangée ; Flotte Privée : réservation dont la
// réponse est attendue dans 15 min au plus, ouverte en plein écran, jamais pendant une course, mais toujours
// différable (« Plus tard », retour Android) ; compte à rebours en minutes pour une longue fenêtre ; échéance de réponse.
import { PRIVATE_FLEET_RING_WINDOW_S, type DriverOfferV2 } from "@rydar/shared";
import { describe, expect, it } from "vitest";
import {
  URGENT_OFFER_S, answerBeforeText, countdownView, isUrgentOffer, isUrgentWindow, offerScreenMode, offerWindowSeconds, shouldOpenOffer,
} from "./offer-urgency";

const NBSP = " ";
const SENT = "2026-10-13T08:00:00.000Z";
const offer = (mode: "geo" | "fleet", windowS: number | null) => ({
  mode,
  sent_at: SENT,
  expires_at: windowS == null ? null : new Date(Date.parse(SENT) + windowS * 1000).toISOString(),
});

describe("fenêtre de réponse", () => {
  it("de l'envoi à l'échéance ; sans échéance ou dates illisibles : null", () => {
    expect(offerWindowSeconds(offer("fleet", 300))).toBe(300);
    expect(offerWindowSeconds(offer("fleet", null))).toBeNull();
    expect(offerWindowSeconds({ sent_at: "n'importe quoi", expires_at: SENT })).toBeNull();
  });

  it("urgente : 2 min au plus ; Flotte Privée : jusqu'à la fenêtre de sonnerie du serveur (15 min)", () => {
    expect(PRIVATE_FLEET_RING_WINDOW_S).toBe(900);
    expect(isUrgentWindow(URGENT_OFFER_S)).toBe(true);
    expect(isUrgentWindow(URGENT_OFFER_S + 1)).toBe(false);
    expect(isUrgentWindow(300, { privateFleet: true })).toBe(true);
    expect(isUrgentWindow(900, { privateFleet: true })).toBe(true);
    expect(isUrgentWindow(901, { privateFleet: true })).toBe(false);
    expect(isUrgentWindow(null, { privateFleet: true })).toBe(false);
  });
});

describe("isUrgentOffer", () => {
  it("organisation standard : règle actuelle (GPS, ou fenêtre de 2 min au plus)", () => {
    expect(isUrgentOffer(offer("geo", 3600))).toBe(true);
    expect(isUrgentOffer(offer("geo", null))).toBe(true);
    expect(isUrgentOffer(offer("fleet", 90))).toBe(true);
    expect(isUrgentOffer(offer("fleet", 300))).toBe(false);
    expect(isUrgentOffer(offer("fleet", null))).toBe(false);
  });

  it("Flotte Privée : réservation immédiate (5 min) ou prise en charge proche (15 min) ; planifiée lointaine : non", () => {
    expect(isUrgentOffer(offer("fleet", 300), { privateFleet: true })).toBe(true);
    expect(isUrgentOffer(offer("fleet", 900), { privateFleet: true })).toBe(true);
    expect(isUrgentOffer(offer("fleet", 3 * 3600), { privateFleet: true })).toBe(false);
    expect(isUrgentOffer(offer("fleet", null), { privateFleet: true })).toBe(false);
  });
});

describe("shouldOpenOffer (plein écran à la lecture des offres)", () => {
  it("jamais pendant une course pour une offre de la flotte, même Flotte Privée", () => {
    expect(shouldOpenOffer(offer("fleet", 300), { privateFleet: true })).toBe(true);
    expect(shouldOpenOffer(offer("fleet", 300), { privateFleet: true, onRide: true })).toBe(false);
    expect(shouldOpenOffer(offer("fleet", 60), { onRide: true })).toBe(false);
    expect(shouldOpenOffer(offer("fleet", 300))).toBe(false);
  });

  it("offre GPS (dernier appel compris) : toujours ouverte", () => {
    expect(shouldOpenOffer(offer("geo", 30), { onRide: true })).toBe(true);
    expect(shouldOpenOffer(offer("geo", 30), { privateFleet: true })).toBe(true);
  });
});

describe("offerScreenMode (écran d'offre : sonnerie, « Plus tard », retour Android, refus)", () => {
  const screen = (mode: "geo" | "fleet", windowS: number | null, privateFleet = false, network: DriverOfferV2["network"] = null) =>
    offerScreenMode({ ...offer(mode, windowS), network }, windowS ?? 30, { privateFleet });

  it("organisation standard : bloquante comme urgente (GPS, ou fenêtre de 2 min au plus)", () => {
    expect(screen("fleet", 300)).toEqual({ booking: false, urgent: false, blocking: false });
    expect(screen("fleet", 90)).toEqual({ booking: false, urgent: true, blocking: true });
    expect(screen("geo", 30)).toEqual({ booking: false, urgent: true, blocking: true });
    expect(screen("fleet", null)).toEqual({ booking: false, urgent: false, blocking: false });
  });

  it("Flotte Privée : réservation urgente (5 à 15 min) qui sonne mais reste différable, jamais bloquante", () => {
    expect(screen("fleet", 300, true)).toEqual({ booking: true, urgent: true, blocking: false });
    expect(screen("fleet", 600, true)).toEqual({ booking: true, urgent: true, blocking: false });
    expect(screen("fleet", 900, true)).toEqual({ booking: true, urgent: true, blocking: false });
    expect(screen("fleet", 3 * 3600, true)).toEqual({ booking: true, urgent: false, blocking: false });
  });

  it("Flotte Privée : blocage réservé au dernier appel GPS et aux fenêtres de 2 min au plus", () => {
    expect(screen("geo", 300, true)).toEqual({ booking: true, urgent: true, blocking: true });
    expect(screen("fleet", URGENT_OFFER_S, true)).toEqual({ booking: true, urgent: true, blocking: true });
    expect(screen("fleet", URGENT_OFFER_S + 1, true).blocking).toBe(false);
  });

  it("course partenaire (réseau partagé) : jamais une réservation de son site", () => {
    const network = { giver: { name: "Taxi Alpha" } } as unknown as DriverOfferV2["network"];
    expect(screen("fleet", 300, true, network).booking).toBe(false);
  });
});

describe("countdownView", () => {
  it("fenêtre courte : secondes", () => {
    expect(countdownView(90, 100)).toEqual({ value: 90, unit: "s", label: `90${NBSP}secondes pour répondre` });
    expect(countdownView(0.4, 30)).toEqual({ value: 1, unit: "s", label: `1${NBSP}seconde pour répondre` });
    expect(countdownView(-3, 30)).toMatchObject({ value: 0, unit: "s" });
  });

  it("longue fenêtre (réservation) : minutes, puis secondes la dernière minute", () => {
    expect(countdownView(240, 300)).toEqual({ value: 4, unit: "min", label: `4${NBSP}minutes pour répondre` });
    expect(countdownView(61, 300)).toMatchObject({ value: 2, unit: "min" });
    expect(countdownView(60, 300)).toEqual({ value: 60, unit: "s", label: `60${NBSP}secondes pour répondre` });
    expect(countdownView(899, 900)).toMatchObject({ value: 15, unit: "min" });
  });
});

describe("answerBeforeText", () => {
  // 13/10/2026 09:00 à Paris (UTC+2)
  const now = Date.parse("2026-10-13T07:00:00Z");

  it("heure du fuseau de l'organisation : aujourd'hui, demain, autre jour", () => {
    expect(answerBeforeText("2026-10-13T05:30:00Z", "Europe/Paris", now)).toBe("Réponse avant 07:30");
    expect(answerBeforeText("2026-10-14T05:30:00Z", "Europe/Paris", now)).toBe("Réponse avant demain 07:30");
    expect(answerBeforeText("2026-10-16T05:30:00Z", "Europe/Paris", now)).toBe("Réponse avant le ven. 16/10 07:30");
  });

  it("sans échéance (ou illisible) : rien", () => {
    expect(answerBeforeText(null, "Europe/Paris", now)).toBeNull();
    expect(answerBeforeText("bientôt", "Europe/Paris", now)).toBeNull();
  });
});
