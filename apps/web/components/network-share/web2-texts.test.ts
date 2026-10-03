import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NETWORK_FORBIDDEN_WORDS } from "@rydar/shared";
import { describe, expect, it } from "vitest";

// Écrans du réseau partagé hors onglet (fiche course, liste, En direct, alertes, organisation suspendue, super admin,
// pages publiques) : vocabulaire de la spec §7.1 (Rydar est un logiciel de dispatch), jetons du thème (jamais de
// couleur en dur dans les nouveaux fichiers), liens du tableau de bord et du super admin sans préchargement.

const WEB = join(__dirname, "../..");

function files(path: string): string[] {
  const abs = join(WEB, path);
  if (!statSync(abs).isDirectory()) return [abs];
  return readdirSync(abs).flatMap((name) => {
    const p = join(path, name);
    if (statSync(join(WEB, p)).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [join(WEB, p)] : [];
  });
}

/** Fichiers touchés par le réseau partagé (nouveaux ou modifiés). */
const TOUCHED = [
  "app/dashboard/rides",
  "app/suspended",
  "app/admin/reseau",
  "app/admin/organizations/[id]/page.tsx",
  "app/reseau-partage",
  "components/command",
  "components/alerts/dispatch-alerts.tsx",
  "components/settlements/ride-money.tsx",
  "components/rides/new-ride-sheet.tsx",
  "components/rides/ride-actions.tsx",
  "components/admin/network-admin.tsx",
  "components/admin/org-network-card.tsx",
  "components/legal/network-terms.ts",
  "components/legal/network-terms-page.tsx",
  "lib/queries/live.ts",
  // Corrections après revue : renvoi d'Encaissements, garde des lignes réseau, menu et titre « Inscriptions »
  "app/dashboard/settlements",
  "app/dashboard/layout.tsx",
  "app/dashboard/network/page.tsx",
  "lib/shared-network.ts",
  "components/settlements/settlement-methods-fields.tsx",
].flatMap(files);

/** Nouveaux fichiers : aucune couleur en dur, liens sans préchargement. */
const NEW = [
  "app/suspended/reseau-partage",
  "app/admin/reseau",
  "app/reseau-partage",
  "components/admin/network-admin.tsx",
  "components/admin/org-network-card.tsx",
  "components/network-share/ride-network-card.tsx",
  "components/network-share/live-partner.tsx",
  "components/legal/network-terms-page.tsx",
].flatMap(files);

const read = (p: string) => readFileSync(p, "utf8");

describe("écrans du réseau partagé (web 2/2)", () => {
  it("fichiers lus", () => {
    expect(TOUCHED.some((p) => p.endsWith("ride-money.tsx"))).toBe(true);
    expect(NEW.some((p) => p.endsWith("network-admin.tsx"))).toBe(true);
    expect(NEW.some((p) => p.includes("reseau-partage/conditions"))).toBe(true);
  });

  it("aucun mot interdit (mise en relation, intermédiaire, place de marché, marketplace)", () => {
    for (const path of [...TOUCHED, ...NEW]) {
      const lower = read(path).toLowerCase();
      for (const word of NETWORK_FORBIDDEN_WORDS) expect(lower.includes(word), `${word} dans ${path}`).toBe(false);
    }
  });

  it("nouveaux fichiers : jetons du thème seulement, jamais de couleur en dur", () => {
    for (const path of NEW) expect(/#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})\b/i.test(read(path)), path).toBe(false);
  });

  it("renvoi d'Encaissements vers « Réseau partagé » : lien sans préchargement", () => {
    const page = TOUCHED.find((p) => p.endsWith(join("settlements", "page.tsx")))!;
    for (const tag of read(page).match(/<Link\b[^>]*>/g) ?? []) expect(tag.includes("prefetch={false}"), tag).toBe(true);
  });

  it("nouveaux écrans connectés : liens sans préchargement", () => {
    for (const path of NEW.filter((p) => !p.includes("reseau-partage/conditions") && !p.includes("reseau-partage/chauffeur") && !p.includes("network-terms-page"))) {
      for (const tag of read(path).match(/<Link\b[^>]*>/g) ?? []) expect(tag.includes("prefetch={false}"), `${path} : ${tag}`).toBe(true);
    }
  });
});
