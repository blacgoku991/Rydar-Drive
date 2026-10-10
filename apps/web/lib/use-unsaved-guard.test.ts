import { describe, expect, it } from "vitest";
import { leavesPage, shouldConfirmLeave, type LeaveClick } from "./use-unsaved-guard";

// Réglages (docs/REFONTE-PANELS.md § 5.6, R10) : une saisie non enregistrée n'est plus perdue en changeant d'onglet.
// Décision pure : un clic sur un lien fait-il quitter la page ? (le crochet useUnsavedGuard ne fait que l'appliquer)

const HERE = "https://app.rydar.test/dashboard/settings?tab=dispatch";
const click = (href: string, extra: Partial<LeaveClick> = {}): LeaveClick => ({ href, button: 0, ...extra });

describe("leavesPage", () => {
  it("autre onglet des réglages (seul ?tab= change), autre page, autre site : la page est quittée", () => {
    expect(leavesPage(click("/dashboard/settings?tab=pricing"), HERE)).toBe(true);
    expect(leavesPage(click("https://app.rydar.test/dashboard/settings?tab=org"), HERE)).toBe(true);
    expect(leavesPage(click("/dashboard/rides"), HERE)).toBe(true);
    expect(leavesPage(click("/dashboard/settings"), HERE)).toBe(true);
    expect(leavesPage(click("https://www.exemple.fr/"), HERE)).toBe(true);
    expect(leavesPage(click("/dashboard/settings?tab=pricing", { target: "_self" }), HERE)).toBe(true);
  });

  it("même adresse ou simple ancre de la page : rien n'est perdu", () => {
    expect(leavesPage(click(HERE), HERE)).toBe(false);
    expect(leavesPage(click("/dashboard/settings?tab=dispatch"), HERE)).toBe(false);
    expect(leavesPage(click("#reglages-avances"), HERE)).toBe(false);
    expect(leavesPage(click("/dashboard/settings?tab=dispatch#zones"), HERE)).toBe(false);
  });

  it("nouvel onglet, nouvelle fenêtre, téléchargement, autre bouton : la page reste", () => {
    for (const mod of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      expect(leavesPage(click("/dashboard/rides", { [mod]: true }), HERE), mod).toBe(false);
    }
    expect(leavesPage(click("/dashboard/rides", { target: "_blank" }), HERE)).toBe(false);
    expect(leavesPage(click("/cgv", { target: "_BLANK" }), HERE)).toBe(false);
    expect(leavesPage(click("/dashboard/settlements/rydar/export", { download: true }), HERE)).toBe(false);
    expect(leavesPage(click("/dashboard/rides", { button: 1 }), HERE)).toBe(false);
  });

  it("mailto:, tel:, clic déjà annulé ou adresse illisible : aucune confirmation", () => {
    expect(leavesPage(click("mailto:contact@rydar.test"), HERE)).toBe(false);
    expect(leavesPage(click("tel:+33612345678"), HERE)).toBe(false);
    expect(leavesPage(click("/dashboard/rides", { defaultPrevented: true }), HERE)).toBe(false);
    expect(leavesPage(click("http://[::1"), HERE)).toBe(false);
    expect(leavesPage(click("/dashboard/rides"), "pas une adresse")).toBe(false);
  });
});

describe("shouldConfirmLeave", () => {
  it("seulement si la saisie n'est pas enregistrée", () => {
    expect(shouldConfirmLeave(true, click("/dashboard/settings?tab=team"), HERE)).toBe(true);
    expect(shouldConfirmLeave(false, click("/dashboard/settings?tab=team"), HERE)).toBe(false);
    expect(shouldConfirmLeave(true, click("/dashboard/settings?tab=team", { ctrlKey: true }), HERE)).toBe(false);
  });
});
