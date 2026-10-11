import { DOCUMENT_TYPE_LABELS } from "@rydar/shared";
import { describe, expect, it, vi } from "vitest";

// Revue de la refonte (RV-14) : une pièce, un seul nom. « Ajouter » sur « Attestation d'assurance — Manquant » ouvrait
// « Assurance RC Pro » ; « Document » (liste) devenait « Autre » (fenêtre). La fenêtre reprend les libellés de la liste
// des pièces (DOCUMENT_TYPE_LABELS, les mêmes que l'application).
vi.mock("@/app/dashboard/drivers/actions", () => ({ addDriverDocument: vi.fn() }));
vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: () => null, DialogContent: () => null, DialogFooter: () => null }));
vi.mock("@/components/ui/input", () => ({ Field: () => null, Input: () => null, NativeSelect: () => null }));
vi.mock("@/lib/run-action", () => ({ runAction: vi.fn() }));
vi.mock("@/lib/utils", () => ({ submitWith: vi.fn(), cn: (...c: unknown[]) => c.filter(Boolean).join(" ") }));

const { ADDABLE_DOCUMENT_TYPES, isAddableDocumentType } = await import("./add-document-dialog");

describe("fenêtre « Ajouter un document »", () => {
  it("chaque type porte le libellé de la liste des pièces", () => {
    for (const t of ADDABLE_DOCUMENT_TYPES) expect(t.label).toBe(DOCUMENT_TYPE_LABELS[t.value]);
    const labels = Object.fromEntries(ADDABLE_DOCUMENT_TYPES.map((t) => [t.value, t.label]));
    expect(labels.insurance).toBe("Attestation d'assurance");
    expect(labels.other).toBe(DOCUMENT_TYPE_LABELS.other);
    expect(ADDABLE_DOCUMENT_TYPES.map((t) => t.label)).not.toContain("Assurance RC Pro");
  });

  it("mêmes types qu'avant ; « Visite médicale » jamais proposée", () => {
    expect(ADDABLE_DOCUMENT_TYPES.map((t) => t.value)).toEqual(["vtc_card", "driving_license", "insurance", "vehicle_registration", "identity", "other"]);
    expect(isAddableDocumentType("insurance")).toBe(true);
    expect(isAddableDocumentType("medical")).toBe(false);
  });
});
