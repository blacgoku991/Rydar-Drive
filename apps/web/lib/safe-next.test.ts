import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext (redirection après connexion)", () => {
  it("garde les chemins internes autorisés, requête comprise", () => {
    expect(safeNext("/dashboard")).toBe("/dashboard");
    expect(safeNext("/dashboard/rides?x=1")).toBe("/dashboard/rides?x=1");
    expect(safeNext("/admin/organizations/abc")).toBe("/admin/organizations/abc");
    expect(safeNext("/auth/set-password")).toBe("/auth/set-password");
  });

  it("refuse tout ce qui peut sortir du site (→ /dashboard)", () => {
    for (const next of [
      "/\\evil.example", "/\\\\evil.example", "/\t/evil.example", "/\n/evil.example", "//evil.example", "///evil.example",
      "https://evil.example", "http:/evil.example", "evil.example", "javascript:alert(1)", "/%5Cevil.example/../..",
    ]) {
      const out = safeNext(next);
      expect(out, next).toMatch(/^\/(dashboard|admin|auth\/set-password)/);
      expect(new URL(out, "https://app.rydar.app").origin, next).toBe("https://app.rydar.app");
    }
    expect(safeNext("/\\evil.example")).toBe("/dashboard");
    expect(safeNext("/\t/evil.example")).toBe("/dashboard");
    expect(safeNext("//evil.example")).toBe("/dashboard");
  });

  it("refuse les autres pages, les préfixes voisins et les valeurs absentes", () => {
    for (const next of ["/", "/login", "/dashboardx", "/administration", "/api/v1/rides", "", null, undefined, 42, "/dashboard".padEnd(3000, "a")]) {
      expect(safeNext(next)).toBe("/dashboard");
    }
    expect(safeNext("/dashboard/../login")).toBe("/dashboard");
  });
});
