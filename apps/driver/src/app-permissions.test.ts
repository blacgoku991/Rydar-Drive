import { describe, expect, it } from "vitest";
import appConfig from "../app.config";

// Permissions Android (docs/STORES.md § 4, CLAUDE.md) : position « pendant l'utilisation » seulement, et aucune
// permission sensible héritée du gabarit Expo sans usage — SYSTEM_ALERT_WINDOW (« afficher par-dessus les autres
// applis », audit p5). Changement natif : effectif au prochain build stores, jamais par une mise à jour à distance seule.

describe("app.config : permissions Android bloquées", () => {
  const config = appConfig({ config: {} } as never);
  it("position en arrière-plan, exemption de batterie et surimpression bloquées", () => {
    expect(config.android?.blockedPermissions).toEqual(
      expect.arrayContaining([
        "android.permission.ACCESS_BACKGROUND_LOCATION",
        "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
        "android.permission.SYSTEM_ALERT_WINDOW",
      ]),
    );
    expect(config.android?.permissions ?? []).not.toContain("SYSTEM_ALERT_WINDOW");
  });
});
