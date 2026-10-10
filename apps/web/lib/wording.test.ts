import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTOR,
  AUDIT_ALERT_SEVERITIES,
  AUDIT_PEOPLE_FILTER,
  AUDIT_SEVERITY,
  AUDIT_VIEWS,
  DISPATCH_LEVEL,
  INVOICE_STATUS,
  NOTIFICATION_ERRORS,
  NOTIFICATION_STATUS,
  SUBSCRIPTION_STATUS,
  auditActionLabel,
  auditActorLabel,
  auditHiddenByDefault,
  auditSeverity,
  auditViewOf,
  dispatchLevel,
  emailErrorParts,
  groupRepeats,
  invoiceStatus,
  notificationErrorLabel,
  notificationStatus,
  orgWords,
  plural,
  subscriptionStatus,
  upperFirst,
} from "./wording";

// Lexique de l'interface (docs/REFONTE-PANELS.md § 4) : chaque code connu a son libellé français, un code inconnu un
// repli lisible, jamais une exception ni un code brut en anglais.

const TONES = new Set(["neutral", "brand", "amber", "blue", "violet", "cyan", "green", "red"]);
/** Aucun code brut à l'écran : ni tiret bas, ni mot anglais des statuts. */
const RAW = /_|\b(queued|sending|sent|failed|cancelled|canceled|trialing|active|past_due|unpaid|open|draft|paid|void|warning|critical|debug|error|success)\b/;
const NBSP = "\u00a0";

describe("plural", () => {
  it("singulier jusqu'à 1, pluriel à partir de 2, nombre au format français", () => {
    expect(plural(0, "course")).toBe("0 course");
    expect(plural(1, "course")).toBe("1 course");
    expect(plural(2, "course")).toBe("2 courses");
    expect(plural(3, "course sans chauffeur", "courses sans chauffeur")).toBe("3 courses sans chauffeur");
    expect(plural(1000, "course").replace(/[\u202f\u00a0]/g, " ")).toBe("1 000 courses");
  });

  it("majuscule initiale", () => {
    expect(upperFirst("votre flotte")).toBe("Votre flotte");
    expect(upperFirst("")).toBe("");
  });
});

describe("orgWords : flotte ou centrale", () => {
  it("centrale", () => {
    expect(orgWords("centrale")).toEqual({
      noun: "centrale",
      your: "votre centrale",
      the: "la centrale",
      ofYour: "de votre centrale",
      ofThe: "de la centrale",
      toYour: "à votre centrale",
    });
  });

  it("flotte (et Flotte Privée, modèle absent ou inconnu) : jamais « centrale »", () => {
    for (const model of ["fleet", null, undefined, "", "autre"]) {
      const w = orgWords(model);
      expect(w.your).toBe("votre flotte");
      expect(w.the).toBe("la flotte");
      expect(w.ofYour).toBe("de votre flotte");
      expect(Object.values(w).join(" ")).not.toMatch(/centrale/);
    }
  });
});

describe("notifications", () => {
  it("chaque statut : libellé français et ton connu", () => {
    expect(Object.keys(NOTIFICATION_STATUS).sort()).toEqual(["cancelled", "failed", "queued", "sending", "sent"]);
    expect(notificationStatus("sent")).toEqual({ label: "Envoyée", tone: "green" });
    expect(notificationStatus("queued").label).toBe("En file");
    expect(notificationStatus("sending").label).toBe("Envoi en cours");
    expect(notificationStatus("failed")).toEqual({ label: "Échec", tone: "red" });
    expect(notificationStatus("cancelled").label).toBe("Annulée");
    for (const v of Object.values(NOTIFICATION_STATUS)) {
      expect(v.label).not.toMatch(RAW);
      expect(TONES.has(v.tone)).toBe(true);
    }
  });

  it("statut inconnu ou absent : repli lisible", () => {
    expect(notificationStatus("bounced")).toEqual({ label: "Statut inconnu", tone: "neutral" });
    expect(notificationStatus(null).label).toBe("Statut inconnu");
    expect(notificationStatus("toString").label).toBe("Statut inconnu");
  });

  it("erreurs écrites par le worker (last_error) : mots simples, message brut jamais repris", () => {
    expect(notificationErrorLabel("NO_PUSH_TOKEN")).toBe("Application jamais ouverte ou notifications refusées");
    expect(notificationErrorLabel('DeviceNotRegistered: "ExponentPushToken[AbCdEf…]" is not a registered push notification recipient')).toBe(
      "Application désinstallée ou notifications désactivées sur le téléphone",
    );
    // Plusieurs appareils : la première erreur décide
    expect(notificationErrorLabel("PUSH_TIMEOUT: expo (20000 ms) | DeviceNotRegistered: gone")).toBe(`Service d'envoi trop lent${NBSP}: nouvel essai automatique`);
    // FCM « statut/code »
    expect(notificationErrorLabel("NOT_FOUND/UNREGISTERED: Requested entity was not found.")).toMatch(/désinstallée/);
    expect(notificationErrorLabel("INVALID_ARGUMENT: Invalid value at 'message.data[0].value'")).toBe("Notification refusée par le service d'envoi");
    expect(notificationErrorLabel("HTTP_429: ")).toMatch(/Trop de notifications/);
    expect(notificationErrorLabel("HTTP_503: ")).toBe("Service d'envoi momentanément indisponible");
    expect(notificationErrorLabel("PROVIDER_FCM_NOT_CONFIGURED")).toMatch(/mal configuré/);
    expect(notificationErrorLabel("FCM_OAUTH_invalid_grant")).toMatch(/mal configuré/);
    expect(notificationErrorLabel("APNS_AUTH: secretOrPrivateKey must be an asymmetric key")).toMatch(/mal configuré/);
    expect(notificationErrorLabel("BadDeviceToken")).toMatch(/désinstallée/);
    expect(notificationErrorLabel("EXPO_TIMEOUT (10000 ms)")).toMatch(/trop lent/);
    expect(notificationErrorLabel("EXPO_NETWORK: fetch failed")).toMatch(/indisponible/);
    expect(notificationErrorLabel("InvalidExpoToken")).toMatch(/rouvrir l'application/);
    for (const label of Object.values(NOTIFICATION_ERRORS)) expect(label).not.toMatch(/_|Expo|FCM|APNs|push\b/i);
  });

  it("annulées avant l'envoi (offer_closed, wake_expired écrits par le ménage) : la raison, jamais « Échec de l'envoi »", () => {
    expect(notificationErrorLabel("offer_closed")).toBe("Proposition close avant l'envoi");
    expect(notificationErrorLabel("wake_expired")).toBe("Demande de position expirée avant l'envoi");
  });

  it("erreur inconnue : « Échec de l'envoi » ; aucune erreur : null", () => {
    expect(notificationErrorLabel("WeirdNewCode: boom")).toBe("Échec de l'envoi");
    expect(notificationErrorLabel("::: |")).toBe("Échec de l'envoi");
    expect(notificationErrorLabel("constructor")).toBe("Échec de l'envoi");
    expect(notificationErrorLabel(null)).toBeNull();
    expect(notificationErrorLabel("  ")).toBeNull();
  });
});

describe("audit", () => {
  it("gravités : Info, Attention, Critique ; inconnue → Info", () => {
    expect(Object.keys(AUDIT_SEVERITY).sort()).toEqual(["critical", "info", "warning"]);
    expect(auditSeverity("info")).toEqual({ label: "Info", tone: "neutral" });
    expect(auditSeverity("warning")).toEqual({ label: "Attention", tone: "amber" });
    expect(auditSeverity("critical")).toEqual({ label: "Critique", tone: "red" });
    expect(auditSeverity("nope").label).toBe("Info");
    expect(auditSeverity(undefined).label).toBe("Info");
  });

  it("auteurs : Super admin, Système, Utilisateur… ; inconnu → « Autre »", () => {
    expect(auditActorLabel("super_admin")).toBe("Super admin");
    expect(auditActorLabel("system")).toBe("Système");
    expect(auditActorLabel("user")).toBe("Utilisateur");
    expect(auditActorLabel("driver")).toBe("Chauffeur");
    expect(auditActorLabel("api")).toBe("Site du client");
    expect(auditActorLabel("booking_site")).toBe("Mini-site");
    expect(auditActorLabel("robot")).toBe("Autre");
    expect(auditActorLabel(null)).toBe("Autre");
    for (const label of Object.values(AUDIT_ACTOR)) expect(label).not.toMatch(RAW);
  });

  it("actions connues (web et migrations) : libellés français, sans code brut", () => {
    expect(auditActionLabel("api_key.created")).toBe("Clé de connexion créée");
    expect(auditActionLabel("organization.private_fleet_created")).toBe("Client Flotte Privée créé");
    expect(auditActionLabel("driver.banned")).toBe("Chauffeur banni");
    expect(auditActionLabel("security.cross_tenant_access")).toBe("Accès refusé aux données d'un autre client");
    expect(auditActionLabel("platform.booking_sites_disabled")).toBe("Mini-sites coupés");
    for (const [code, label] of Object.entries(AUDIT_ACTIONS)) {
      expect(label, code).not.toMatch(/_|\btenant\b|\bpush\b/);
      expect(label.trim(), code).toBe(label);
      expect(label.length, code).toBeGreaterThan(3);
    }
  });

  it("actions ajoutées en R6 (web et migrations) : accès, statut d'un client, offres, webhooks", () => {
    expect(auditActionLabel("member.access_granted")).toBe("Accès au tableau de bord donné");
    expect(auditActionLabel("member.access_restored")).toBe("Accès au tableau de bord rétabli");
    expect(auditActionLabel("member.access_revoked")).toBe("Accès au tableau de bord retiré");
    // « organization. » + statut (svc_platform_set_org_status)
    expect(auditActionLabel("organization.active")).toBe("Client réactivé");
    expect(auditActionLabel("organization.suspended")).toBe("Client suspendu");
    expect(auditActionLabel("organization.archived")).toBe("Client archivé");
    expect(auditActionLabel("plan.created")).toBe("Offre créée");
    expect(auditActionLabel("plan.updated")).toBe("Offre modifiée");
    expect(auditActionLabel("plan.something_new")).toBe(`Offre${NBSP}: something new`);
    for (const code of ["webhook.created", "webhook.updated", "webhook.deleted", "webhook.enabled", "webhook.disabled", "webhook.secret_rotated", "webhook.ping", "webhook.redelivered"]) {
      expect(AUDIT_ACTIONS, code).toHaveProperty([code]);
      expect(auditActionLabel(code), code).toMatch(/webhook/i);
    }
    expect(auditActionLabel("webhook.disabled")).toBe("Webhook désactivé");
    expect(auditActionLabel("webhook.ping")).toBe("Test d'un webhook envoyé");
  });

  it("toute action écrite par apps/web ou par les migrations a son libellé (jamais le repli)", () => {
    const repo = join(import.meta.dirname, "..", "..", "..");
    const codes = new Set<string>();
    // Web : audit({ action: "…" }), action: cond ? "…" : "…" et `driver.${status}` (active, inactive, suspended)
    const webFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : webFiles(p);
        return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
      });
    for (const file of [...webFiles(join(repo, "apps/web/app")), ...webFiles(join(repo, "apps/web/lib"))]) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!/\baction:/.test(line) || /^\s*(\/\/|\*)/.test(line)) continue;
        for (const m of line.matchAll(/"([a-z_]+\.[a-z_]+)"/g)) codes.add(m[1]!);
        if (line.includes("`driver.${status}`")) for (const s of ["active", "inactive", "suspended"]) codes.add(`driver.${s}`);
      }
    }
    // Migrations : littéraux des insertions dans audit_logs et des appels à private.webhook_audit ; « organization. »
    // suivi du statut (active, suspended, archived) ; déclencheur générique couvert par le test précédent
    const dir = join(repo, "supabase/migrations");
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".sql"))) {
      const sql = readFileSync(join(dir, name), "utf8");
      for (const m of sql.matchAll(/insert\s+into\s+public\.audit_logs\b[^;]*|private\.webhook_audit\s*\([^;]*/gi)) {
        for (const lit of m[0].matchAll(/'([a-z_]+\.[a-z_]+)'/g)) if (!/^(public|private)\./.test(lit[1]!)) codes.add(lit[1]!);
        if (/'organization\.'\s*\|\|\s*p_status/.test(m[0])) for (const s of ["active", "suspended", "archived"]) codes.add(`organization.${s}`);
      }
    }
    expect(codes.size).toBeGreaterThan(100);
    for (const code of ["member.access_granted", "plan.updated", "webhook.ping", "organization.archived", "driver.inactive", "security.cross_tenant_access"]) {
      expect(codes.has(code), code).toBe(true);
    }
    expect([...codes].filter((c) => !Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, c)).sort()).toEqual([]);
  });

  it("déclencheur générique (table.insert / update / delete) : entité et accord", () => {
    expect(auditActionLabel("drivers.insert")).toBe("Fiche chauffeur ajoutée");
    expect(auditActionLabel("organizations.update")).toBe("Client modifié");
    expect(auditActionLabel("organization_settings.update")).toBe("Réglages modifiés");
    expect(auditActionLabel("api_keys.insert")).toBe("Clé de connexion ajoutée");
    expect(auditActionLabel("plans.delete")).toBe("Offre supprimée");
    expect(auditActionLabel("vehicles.insert")).toBe("Véhicule ajouté");
  });

  it("action inconnue : repli lisible (domaine connu, sinon le code en mots), jamais d'exception", () => {
    expect(auditActionLabel("driver.some_new_thing")).toBe(`Chauffeur${NBSP}: some new thing`);
    expect(auditActionLabel("drivers.archive")).toBe(`Fiche chauffeur${NBSP}: archive`);
    expect(auditActionLabel("totally_unknown.code_here")).toBe("Totally unknown code here");
    expect(auditActionLabel("x")).toBe("X");
    expect(auditActionLabel("constructor")).toBe("Constructor");
    expect(auditActionLabel("driver.")).toBe(`Chauffeur${NBSP}: action`);
    expect(auditActionLabel("")).toBe("Action non précisée");
    expect(auditActionLabel(null)).toBe("Action non précisée");
    expect(auditActionLabel("___")).toBe("Action non précisée");
    for (const code of ["driver.some_new_thing", "a.b.c_d", "._.", "toString", "__proto__"]) {
      expect(() => auditActionLabel(code)).not.toThrow();
      expect(auditActionLabel(code)).not.toMatch(/_/);
    }
  });
});

describe("supervision : vues de l'audit", () => {
  const ACTORS = ["system", "user", "driver", "api", "booking_site", "super_admin"];
  const SEVERITIES = ["info", "warning", "critical"];

  /** Évalue le filtre PostgREST « a.neq.x,b.neq.y » (or) sur une ligne : il doit dire la même chose que la règle. */
  const keptByFilter = (row: Record<string, string>) =>
    AUDIT_PEOPLE_FILTER.split(",").some((clause) => {
      const [column, op, value] = clause.split(".");
      expect(op).toBe("neq");
      return row[column!] !== value;
    });

  it("vue par défaut « Actions des personnes » : seules les écritures « Info » du système sont masquées", () => {
    for (const actor_type of ACTORS) {
      for (const severity of SEVERITIES) {
        const hidden = auditHiddenByDefault({ actor_type, severity });
        expect(hidden, `${actor_type} ${severity}`).toBe(actor_type === "system" && severity === "info");
        // Jamais une alerte masquée, quel que soit son auteur
        if (severity !== "info") expect(hidden).toBe(false);
        expect(keptByFilter({ actor_type, severity }), `${actor_type} ${severity}`).toBe(!hidden);
      }
    }
  });

  it("vue d'après l'adresse : ?severity=security (clé existante), ?vue=tout, sinon la vue par défaut", () => {
    expect(auditViewOf({})).toBe("people");
    expect(auditViewOf({ severity: "security" })).toBe("security");
    expect(auditViewOf({ vue: "tout" })).toBe("all");
    expect(auditViewOf({ severity: "security", vue: "tout" })).toBe("security");
    for (const bad of [{ severity: "SECURITY" }, { vue: "autre" }, { vue: ["tout", "tout"] }, { severity: ["security"] }]) expect(auditViewOf(bad)).toBe("people");
    expect(AUDIT_VIEWS).toEqual({ people: "Actions des personnes", security: "Alertes de sécurité", all: "Tout (détail technique)" });
    expect([...AUDIT_ALERT_SEVERITIES]).toEqual(["warning", "critical"]);
  });
});

describe("supervision : lignes identiques regroupées", () => {
  const key = (e: { org: string; msg: string }) => `${e.org}|${e.msg}`;

  it("seulement les lignes qui se suivent ; la première (la plus récente) est gardée avec le nombre", () => {
    const events = [
      { id: 6, org: "a", msg: "Plus de position GPS de Julien" },
      { id: 5, org: "a", msg: "Plus de position GPS de Julien" },
      { id: 4, org: "a", msg: "Plus de position GPS de Julien" },
      { id: 3, org: "b", msg: "Plus de position GPS de Julien" },
      { id: 2, org: "a", msg: "Plus de position GPS de Julien" },
      { id: 1, org: "a", msg: "Course refusée" },
    ];
    expect(groupRepeats(events, key).map((g) => [g.item.id, g.count])).toEqual([
      [6, 3],
      [3, 1],
      [2, 1],
      [1, 1],
    ]);
  });

  it("liste vide ou sans répétition : inchangée", () => {
    expect(groupRepeats([], key)).toEqual([]);
    const one = [{ org: "a", msg: "x" }];
    expect(groupRepeats(one, key)).toEqual([{ item: one[0], count: 1 }]);
  });
});

describe("supervision : motif d'échec d'un e-mail", () => {
  it("motif en français affiché, message brut du serveur mail à part", () => {
    expect(emailErrorParts("Serveur mail injoignable : connect ECONNREFUSED 127.0.0.1:25")).toEqual({
      reason: "Serveur mail injoignable",
      detail: "connect ECONNREFUSED 127.0.0.1:25",
    });
    expect(emailErrorParts("Refus définitif du serveur mail (550) : 550 5.1.1 <x@y.fr>: Recipient address rejected")).toEqual({
      reason: "Refus définitif du serveur mail (550)",
      detail: "550 5.1.1 <x@y.fr>: Recipient address rejected",
    });
    expect(emailErrorParts(`Délai dépassé avec le serveur mail${NBSP}: aucune réponse en 30 s`)?.reason).toBe("Délai dépassé avec le serveur mail");
  });

  it("sans séparateur : tout est le motif ; vide : null", () => {
    expect(emailErrorParts("Adresse de réponse invalide")).toEqual({ reason: "Adresse de réponse invalide", detail: null });
    expect(emailErrorParts("Échec de l'envoi (motif inconnu)")).toEqual({ reason: "Échec de l'envoi (motif inconnu)", detail: null });
    expect(emailErrorParts("Échec de l'envoi : ")).toEqual({ reason: "Échec de l'envoi", detail: null });
    expect(emailErrorParts(null)).toBeNull();
    expect(emailErrorParts("   ")).toBeNull();
  });
});

describe("journal du dispatch", () => {
  it("niveaux : Détail, Info, Réussi, Attention, Erreur (plus de DBG, WRN…) ; inconnu → Info", () => {
    expect(Object.fromEntries(Object.entries(DISPATCH_LEVEL).map(([k, v]) => [k, v.label]))).toEqual({
      debug: "Détail",
      info: "Info",
      success: "Réussi",
      warning: "Attention",
      error: "Erreur",
    });
    expect(dispatchLevel("error").tone).toBe("red");
    expect(dispatchLevel("warning").tone).toBe("amber");
    expect(dispatchLevel("trace").label).toBe("Info");
    expect(dispatchLevel(null).label).toBe("Info");
  });
});

describe("abonnement et factures", () => {
  it("statuts d'abonnement en français ; inconnu → « Statut inconnu »", () => {
    expect(subscriptionStatus("active").label).toBe("Actif");
    expect(subscriptionStatus("trialing").label).toBe("Période d'essai");
    expect(subscriptionStatus("past_due").label).toBe("Paiement en retard");
    expect(subscriptionStatus("unpaid").label).toBe("Impayé");
    expect(subscriptionStatus("canceled").label).toBe("Résilié");
    expect(subscriptionStatus("incomplete").label).toBe("Paiement à finaliser");
    expect(subscriptionStatus("paused").label).toBe("En pause");
    expect(subscriptionStatus("whatever")).toEqual({ label: "Statut inconnu", tone: "neutral" });
    for (const v of Object.values(SUBSCRIPTION_STATUS)) {
      expect(v.label).not.toMatch(RAW);
      expect(TONES.has(v.tone)).toBe(true);
    }
  });

  it("statuts de facture en français ; inconnu → « Statut inconnu »", () => {
    expect(invoiceStatus("open").label).toBe("À payer");
    expect(invoiceStatus("draft").label).toBe("Brouillon");
    expect(invoiceStatus("paid")).toEqual({ label: "Payée", tone: "green" });
    expect(invoiceStatus("void").label).toBe("Annulée");
    expect(invoiceStatus("uncollectible").label).toBe("Irrécouvrable");
    expect(invoiceStatus("payment_failed").tone).toBe("red");
    expect(invoiceStatus(undefined).label).toBe("Statut inconnu");
    for (const v of Object.values(INVOICE_STATUS)) {
      expect(v.label).not.toMatch(RAW);
      expect(TONES.has(v.tone)).toBe(true);
    }
  });
});

describe("typographie", () => {
  it("espace insécable avant « : ; ! ? » dans tous les libellés (frTypo), jamais une espace ordinaire ni rien", () => {
    const all = [
      ...Object.values(NOTIFICATION_ERRORS),
      ...Object.values(AUDIT_ACTIONS),
      ...[NOTIFICATION_STATUS, AUDIT_SEVERITY, DISPATCH_LEVEL, SUBSCRIPTION_STATUS, INVOICE_STATUS].flatMap((t) => Object.values(t).map((v) => v.label)),
      auditActionLabel("driver.nouvelle_action"),
    ];
    for (const label of all) expect(label, label).not.toMatch(/[^\u00a0][:;!?]/);
    expect(all.some((l) => l.includes(`${NBSP}:`))).toBe(true);
  });
});
