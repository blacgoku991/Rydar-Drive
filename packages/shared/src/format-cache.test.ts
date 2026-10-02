import { describe, expect, it } from "vitest";
import { dateTimeFormat, formatDistance, formatNumber, formatPercent, formatPrice, formatRelative, formatRideDate, formatTime, numberFormat } from "./format";

describe("formateurs Intl mémorisés", () => {
  it("mêmes arguments → même formateur ; options différentes → formateur différent", () => {
    const a = dateTimeFormat("fr-FR", { hour: "2-digit", timeZone: "Europe/Paris" });
    expect(dateTimeFormat("fr-FR", { hour: "2-digit", timeZone: "Europe/Paris" })).toBe(a);
    expect(dateTimeFormat("fr-FR", { hour: "2-digit", timeZone: "UTC" })).not.toBe(a);
    expect(numberFormat("fr-FR", { style: "currency", currency: "EUR" })).toBe(numberFormat("fr-FR", { style: "currency", currency: "EUR" }));
  });

  it("résultats identiques à un formateur neuf", () => {
    const d = new Date("2026-10-02T21:59:30Z");
    for (const tz of ["Europe/Paris", "America/Martinique", "Indian/Reunion"]) {
      expect(formatTime(d, tz)).toBe(new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(d));
      expect(formatTime(d, tz, true)).toBe(new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: tz }).format(d));
    }
    expect(formatPrice(7250)).toBe("72,50 €");
    expect(formatPrice(123456, "USD")).toBe(new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1234.56).replace(/ /g, " "));
    expect(formatDistance(1800)).toBe("1,8 km");
    expect(formatNumber(1234567.891, 1)).toBe((1234567.891).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
    expect(formatPercent(0.4567, 1)).toBe(`${(45.67).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`);
    expect(formatRelative(new Date(d.getTime() - 12_000), d)).toBe(new Intl.RelativeTimeFormat("fr", { numeric: "auto", style: "short" }).format(-12, "second"));
    expect(formatRideDate("2026-10-03T06:30:00Z", "Europe/Paris", d)).toBe("Demain 08:30");
  });
});
