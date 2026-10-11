import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Fenêtre « Relancer » des frais Rydar (super admin) : la recherche du destinataire WhatsApp est une action serveur
// appelée à l'ouverture. Réseau coupé ou requête interrompue (fenêtre fermée, page quittée) : la promesse est rejetée
// (« Failed to fetch »). Sans traitement, rejet non traité dans la page (constat du contrôle final de la refonte) ;
// attendu : option WhatsApp masquée, rien d'autre. Chaque appel enchaîne donc `.catch` aussitôt après l'appel.
const FILE = join(import.meta.dirname, "admin-account-actions.tsx");

/** Appels de `name(...)` du fichier, avec le nom de la méthode enchaînée juste après (`.catch`, `.then`…) ou null. */
function callsOf(name: string): { line: number; chained: string | null }[] {
  const src = readFileSync(FILE, "utf8");
  const sf = ts.createSourceFile(FILE, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: { line: number; chained: string | null }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      const parent = node.parent;
      const chained = ts.isPropertyAccessExpression(parent) && parent.expression === node ? parent.name.text : null;
      out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, chained });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("Relancer (frais Rydar) : destinataire WhatsApp", () => {
  it("chaque appel de platformWhatsAppTarget traite l'échec (.catch juste après l'appel)", () => {
    const calls = callsOf("platformWhatsAppTarget");
    // Ouverture de la fenêtre et retour d'un refus noté / retiré
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.filter((c) => c.chained !== "catch")).toEqual([]);
  });
});
