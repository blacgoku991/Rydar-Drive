// Visite médicale refusée par le serveur (TYPE_NOT_ALLOWED, migration 20260924004300) : plus proposée au dépôt.
import { describe, expect, it } from "vitest";
import { canUploadDocument, DOCUMENT_TYPE_REFUSED, needsAction } from "./document-types";

describe("canUploadDocument", () => {
  it("visite médicale : non déposable", () => {
    expect(canUploadDocument("medical")).toBe(false);
  });

  it("autres types : déposables", () => {
    for (const t of ["vtc_card", "driving_license", "identity", "insurance", "vehicle_registration", "other"] as const) {
      expect(canUploadDocument(t)).toBe(true);
    }
  });

  it("même message que le refus du serveur", () => {
    expect(DOCUMENT_TYPE_REFUSED).toBe("Ce type de document ne se dépose plus dans l'application.");
  });
});

describe("needsAction", () => {
  it("document à traiter et déposable", () => {
    expect(needsAction({ type: "insurance", state: "expired" })).toBe(true);
    expect(needsAction({ type: "vtc_card", state: "missing" })).toBe(true);
    expect(needsAction({ type: "insurance", state: "valid" })).toBe(false);
  });

  it("visite médicale expirée : historique seulement, rien à faire dans l'application", () => {
    expect(needsAction({ type: "medical", state: "expired" })).toBe(false);
    expect(needsAction({ type: "medical", state: "rejected" })).toBe(false);
  });
});
