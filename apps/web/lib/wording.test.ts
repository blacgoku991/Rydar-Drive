import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTOR,
  AUDIT_SEVERITY,
  DISPATCH_LEVEL,
  INVOICE_STATUS,
  NOTIFICATION_ERRORS,
  NOTIFICATION_STATUS,
  SUBSCRIPTION_STATUS,
  auditActionLabel,
  auditActorLabel,
  auditSeverity,
  dispatchLevel,
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
