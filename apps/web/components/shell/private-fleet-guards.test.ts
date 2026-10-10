import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Flotte Privée, « masqué ET bloqué » (docs/FLOTTE-PRIVEE.md § 7.4) — test statique (modèle : dashboard-links.test.ts).
// Chaque page interdite appelle sa garde (privateFleetPage, avant toute lecture) ; chaque action serveur listée appelle
// refuseInPrivateFleet (directement ou par une aide locale qui l'appelle). Les actions de integrations/actions.ts
// (lot L2) lisent organizations.private_fleet elles-mêmes : vérifiées par lib/private-fleet-admin.test.ts.

const WEB = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");

/** Début d'une déclaration de premier niveau (fin du corps de la fonction précédente). */
const TOP_LEVEL = /^(export |async |function |const |let |type |interface |\/\*\*|\/\/)/;

/** Corps (texte) de chaque fonction de premier niveau du fichier : nom → texte de la déclaration à la suivante. */
function functionBodies(src: string): Map<string, string> {
  const lines = src.split("\n");
  const out = new Map<string, string>();
  lines.forEach((line, i) => {
    const m = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[<(]/.exec(line);
    if (!m) return;
    let end = i + 1;
    while (end < lines.length && !TOP_LEVEL.test(lines[end]!)) end += 1;
    out.set(m[1]!, lines.slice(i, end).join("\n"));
  });
  return out;
}

/** Fonctions qui refusent en Flotte Privée : appel direct de la garde, ou d'une aide locale qui l'appelle. */
function guardedFunctions(src: string): Set<string> {
  const bodies = functionBodies(src);
  const guarded = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, body] of bodies) {
      if (guarded.has(name)) continue;
      const calls = (fn: string) => new RegExp(`\\b${fn}\\(`).test(body.slice(body.indexOf("{")));
      if (calls("refuseInPrivateFleet") || [...guarded].some(calls)) {
        guarded.add(name);
        changed = true;
      }
    }
  }
  return guarded;
}

const exportedAsync = (src: string) => [...src.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]!);

const ACTIONS: Record<string, string[] | "all"> = {
  // Chauffeurs : aucune création, ni statut, ni bannissement, ni confiance, ni mot de passe, ni sessions
  "app/dashboard/drivers/actions.ts": [
    "createDriver", "setDriverStatus", "banDriver", "liftDriverBan", "setDriverTrustLevel", "resetDriverPassword", "revokeDriverSessions",
  ],
  // Inscriptions / Réseau
  "app/dashboard/network/actions.ts": ["updateJoinLink", "approveApplication", "rejectApplication", "liftIdentityBan"],
  // Réseau partagé : toutes les actions du fichier
  "app/dashboard/reseau-partage/actions.ts": "all",
  // Équipe, réglages Dispatch / Centrale / WhatsApp
  "app/dashboard/settings/actions.ts": [
    "inviteMember", "updateMember", "resendMemberInvitation", "cancelMemberInvitation", "updateDispatchSettings", "updateCentraleSettings",
    "updateReminderChannels", "saveOrgWhatsApp", "removeOrgWhatsApp", "testOrgWhatsApp",
  ],
  // Messagerie
  "app/dashboard/messages/actions.ts": ["sendChatMessage", "markChatRead", "removeChatMessage", "dismissChatReport"],
  // Relancer / Retirer une course
  "app/dashboard/rides/actions.ts": ["redispatchRide", "relaunchRide"],
};

/** Actions qui restent permises en Flotte Privée (le test échoue si l'une d'elles est refusée par erreur). */
const ALLOWED: Record<string, string[]> = {
  "app/dashboard/drivers/actions.ts": ["updateDriver", "addDriverDocument", "reviewDriverDocument"],
  "app/dashboard/settings/actions.ts": ["updateOrganization", "savePricingRule", "updatePrivateBookingSettings"],
  "app/dashboard/rides/actions.ts": ["createRide", "cancelRide", "assignRide", "declineOffer", "updateRidePricing", "acknowledgeRideAlert"],
};

describe("actions serveur refusées en Flotte Privée", () => {
  for (const [file, names] of Object.entries(ACTIONS)) {
    it(file, () => {
      const src = read(file);
      // Garde importée de lib/private-fleet.ts (chemin relatif : actions chargées telles quelles par les tests unitaires)
      expect(src).toMatch(/import \{[^}]*\brefuseInPrivateFleet\b[^}]*\} from "(?:@\/|(?:\.\.\/)+)lib\/private-fleet";/);
      const guarded = guardedFunctions(src);
      const list = names === "all" ? exportedAsync(src) : names;
      expect(list.length).toBeGreaterThan(0);
      const missing = list.filter((n) => !guarded.has(n));
      expect(missing).toEqual([]);
      // Toutes les actions listées existent toujours (un renommage ne doit pas vider le contrôle)
      for (const n of list) expect(exportedAsync(src)).toContain(n);
    });
  }

  it("actions permises : jamais refusées (profil, documents, tarifs, réservations)", () => {
    for (const [file, names] of Object.entries(ALLOWED)) {
      const guarded = guardedFunctions(read(file));
      expect(names.filter((n) => guarded.has(n)), file).toEqual([]);
    }
  });

  it("createDriver et inviteMember refusent AVANT toute création ou recherche de compte Auth", () => {
    const drivers = functionBodies(read("app/dashboard/drivers/actions.ts")).get("createDriver")!;
    const refuse = drivers.indexOf("refuseInPrivateFleet(");
    expect(refuse).toBeGreaterThan(0);
    for (const call of ["createAdminClient(", "auth.admin.createUser(", "auth.admin.inviteUserByEmail("]) {
      expect(drivers.indexOf(call), call).toBeGreaterThan(refuse);
    }
    const invite = functionBodies(read("app/dashboard/settings/actions.ts")).get("inviteMember")!;
    const refuseInvite = invite.indexOf("refuseInPrivateFleet(");
    expect(refuseInvite).toBeGreaterThan(0);
    for (const call of ["createAdminClient(", "findUserIdByEmail(", "auth.admin.createUser(", "auth.admin.inviteUserByEmail("]) {
      expect(invite.indexOf(call), call).toBeGreaterThan(refuseInvite);
    }
  });
});

const PAGES: [file: string, guard: string][] = [
  ["app/dashboard/drivers/page.tsx", 'privateFleetPage(ctx, { redirect: "/dashboard/profil" })'],
  ["app/dashboard/drivers/[id]/page.tsx", 'privateFleetPage(ctx, { redirect: "/dashboard/profil" })'],
  ["app/dashboard/network/page.tsx", 'privateFleetPage(ctx, "notFound")'],
  ["app/dashboard/reseau-partage/page.tsx", 'privateFleetPage(ctx, "notFound")'],
  ["app/dashboard/settlements/page.tsx", 'privateFleetPage(ctx, { redirect: "/dashboard" })'],
  ["app/dashboard/messages/page.tsx", 'privateFleetPage(ctx, { redirect: "/dashboard" })'],
  ["app/dashboard/dispatch/page.tsx", 'privateFleetPage(ctx, { redirect: "/dashboard" })'],
  ["app/dashboard/integrations/page.tsx", 'privateFleetPage(ctx, { redirect: "/dashboard/site" })'],
  ["app/dashboard/booking-site/page.tsx", 'privateFleetPage(ctx, { redirect: "/dashboard/site" })'],
];

/** Première lecture de données d'une page (après requireOrg). */
const FIRST_READ = /ctx\.supabase|networkAccess\(|await searchParams|Promise\.all\(|bookingSitesEnabled\(|loadChatOverview\(/;

describe("pages masquées en Flotte Privée : redirection ou 404 avant toute lecture", () => {
  for (const [file, guard] of PAGES) {
    it(file, () => {
      const src = read(file);
      const page = src.slice(src.indexOf("export default async function"));
      const at = page.indexOf(guard);
      expect(at, `${file} : ${guard}`).toBeGreaterThan(page.indexOf("requireOrg()"));
      const firstRead = page.search(FIRST_READ);
      if (firstRead >= 0) expect(at).toBeLessThan(firstRead);
    });
  }

  it("titre de la page Inscriptions : 404 aussi (sans lecture du réseau partagé)", () => {
    const src = read("app/dashboard/network/page.tsx");
    const meta = src.slice(src.indexOf("export async function generateMetadata"), src.indexOf("export default async function"));
    expect(meta.indexOf('privateFleetPage(ctx, "notFound")')).toBeGreaterThan(0);
    expect(meta.indexOf('privateFleetPage(ctx, "notFound")')).toBeLessThan(meta.indexOf("networkAccess("));
  });

  it("export du relevé du réseau partagé : 404 avant toute lecture", () => {
    const src = read("app/dashboard/reseau-partage/export/route.ts");
    const at = src.indexOf("if (isPrivateFleet(ctx.org)) return NextResponse.json");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(src.indexOf("networkAccess(ctx.supabase"));
  });

  it("pages propres à la Flotte Privée : renvoi vers la page standard ailleurs", () => {
    expect(read("app/dashboard/site/page.tsx")).toContain('if (!isPrivateFleet(ctx.org)) redirect("/dashboard/integrations");');
    expect(read("app/dashboard/profil/page.tsx")).toContain('if (!isPrivateFleet(ctx.org)) redirect("/dashboard/drivers");');
  });
});

describe("Checkout et mise en page", () => {
  it("/api/billing/checkout : offre contrôlée par checkoutPlanAllowed, drapeau relu en base", () => {
    const src = read("app/api/billing/checkout/route.ts");
    expect(src).toContain('import { checkoutPlanAllowed } from "./plan-access";');
    expect(src).toContain("checkoutPlanAllowed({");
    expect(src).toMatch(/select\("[^"]*\bprivate_fleet\b[^"]*"\)/);
    expect(src).not.toMatch(/\(plan as any\)\.is_public \|\|/);
  });
});
