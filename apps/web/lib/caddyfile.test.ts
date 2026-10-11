import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// deploy/Caddyfile (audit p5, worker-infra-2) : tout corps de requête vers le site est plafonné (sans plafond, Next
// garde jusqu'à 10 Mo par requête en mémoire, ~7 Mo par connexion mesurés), les en-têtes doivent arriver en 10 s, et
// /api/tls/allowed (réservé à Caddy, appel interne à web:3000) n'est jamais servi depuis Internet. Comportement vérifié
// avec Caddy 2.10 (scratchpad audit-p5/caddy-build) : 3 Mo → 413, 500 Ko → transmis, websocket gardé, en-têtes lents coupés.

const caddyfile = readFileSync(join(import.meta.dirname, "..", "..", "..", "deploy", "Caddyfile"), "utf8");

/** Blocs de premier niveau (ligne sans retrait finie par « { » jusqu'à la ligne « } ») qui transmettent au serveur web. */
function proxiedSites(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (current === null) {
      if (/^[^\s#].*\{$/.test(line)) current = [line];
    } else {
      current.push(line);
      if (line === "}") {
        blocks.push(current.join("\n"));
        current = null;
      }
    }
  }
  return blocks.filter((b) => b.includes("reverse_proxy web:3000"));
}

describe("deploy/Caddyfile : exposition du serveur web", () => {
  const sites = proxiedSites(caddyfile);

  it("deux blocs transmettent au serveur web (plateforme et mini-sites)", () => {
    expect(sites).toHaveLength(2);
  });

  it("chaque bloc plafonne TOUT corps de requête (request_body sans filtre) et ferme /api/tls/allowed", () => {
    for (const site of sites) {
      expect(site).toMatch(/\n\trequest_body \{\n\t\tmax_size 2MB\n\t\}/);
      expect(site).toMatch(/@tls_ask path \/api\/tls\/allowed\n\trespond @tls_ask 404/);
      // La fermeture précède la transmission (ordre de lecture ; Caddy place respond avant reverse_proxy)
      expect(site.indexOf("respond @tls_ask 404")).toBeLessThan(site.indexOf("reverse_proxy web:3000"));
    }
  });

  it("en-têtes lus en 10 s au plus, sans délai sur le corps (envois de documents vers api.DOMAINE)", () => {
    expect(caddyfile).toMatch(/servers \{\n\t\ttimeouts \{\n\t\t\tread_header 10s\n\t\t\}/);
    expect(caddyfile).not.toMatch(/^\s*read_body\s/m);
  });
});
