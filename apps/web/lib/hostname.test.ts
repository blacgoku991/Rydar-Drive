import { describe, expect, it } from "vitest";
import { bookingHostKey, isValidHostname } from "./hostname";

describe("noms d'hôte des mini-sites", () => {
  it("normalise l'en-tête Host : minuscules, sans port ni point final", () => {
    expect(bookingHostKey("Elite.Rydar.App:443")).toBe("elite.rydar.app");
    expect(bookingHostKey("reservation.ma-centrale.fr.")).toBe("reservation.ma-centrale.fr");
  });

  it("refuse tout ce qui n'est pas un nom de domaine plausible (aucune résolution)", () => {
    expect(bookingHostKey(null)).toBeNull();
    expect(bookingHostKey("")).toBeNull();
    expect(bookingHostKey("localhost")).toBeNull();
    expect(bookingHostKey("[::1]:3000")).toBeNull();
    expect(bookingHostKey("a_b.example.fr")).toBeNull();
    expect(bookingHostKey("-x.example.fr")).toBeNull();
    expect(bookingHostKey(`${"a".repeat(64)}.example.fr`)).toBeNull();
    expect(bookingHostKey(`${"a.".repeat(130)}fr`)).toBeNull(); // > 253 caractères
    expect(bookingHostKey(`${"x".repeat(8_000)}.example`)).toBeNull();
  });

  it("même règle que /api/tls/allowed", () => {
    expect(isValidHostname("elite.rydar.app")).toBe(true);
    expect(isValidHostname("ELITE.rydar.app")).toBe(false);
  });
});
