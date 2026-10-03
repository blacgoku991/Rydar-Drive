import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTACT_LIMITS, CONTACT_REPLY_SUBJECT, CONTACT_STATUS_META, CONTACT_STATUSES, CONTACT_TOPIC_META, CONTACT_TOPIC_PARAM,
  CONTACT_TOPICS, contactAckEmail, contactHref, contactNotifyEmail, contactReplyEmail, contactReplySchema,
  contactRequestSchema, contactTopicFromParam, EMAIL_KIND_META, EMAIL_KINDS, EMAIL_STATUS_META, EMAIL_STATUSES,
  ERROR_MESSAGES, FLEET_SIZE_META, FLEET_SIZES, fieldErrors, humanizeError, sanitizeHeaderText, testEmail,
} from "./index";

const NBSP = "\u{a0}";
const MIGRATION = readFileSync(join(__dirname, "../../../supabase/migrations/20260924005700_contact_requests.sql"), "utf8");
/** Valeurs de la première contrainte « in ('a', 'b') » qui suit `column` (déclaration de colonne) dans la migration. */
function sqlValues(column: string): string[] {
  const at = MIGRATION.indexOf(column);
  const m = at < 0 ? null : / in \(([^)]*)\)/.exec(MIGRATION.slice(at));
  if (!m) throw new Error(`Contrainte introuvable : ${column}`);
  return [...m[1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!);
}
/** Typographie française d'un texte fixe : espace insécable avant « : ; ! ? » et dans les guillemets. */
function expectFrenchTypography(text: string) {
  expect(text).not.toMatch(/ [:;!?»]/);
  expect(text).not.toMatch(/« /);
  expect(text).not.toMatch(/[^\s\u{a0}][:;!?](\s|$)/u);
}
/** Types d'e-mails : dernière contrainte email_outbox_kind_check (20260924006600 : annonces aux organisations). */
function emailKindsInSql(): string[] {
  const sql = readFileSync(join(__dirname, "../../../supabase/migrations/20260924006600_platform_fee_schedule.sql"), "utf8");
  const m = /add constraint email_outbox_kind_check\s+check \(kind in \(([^)]*)\)\)/.exec(sql);
  if (!m) throw new Error("Contrainte email_outbox_kind_check introuvable");
  return [...m[1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!);
}
const codePoints = (s: string) => Array.from(s).length;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]/u;

const valid = {
  topic: "pricing",
  planCode: "pro",
  name: "Jean Dupont",
  company: "Taxi Bleu",
  email: "Jean.Dupont@TaxiBleu.fr",
  phone: "06 12 34 56 78",
  fleetSize: "6-20",
  message: "Bonjour, je souhaite un devis pour 12 chauffeurs.",
  website: "",
};

describe("contact : sujets, tailles de flotte, statuts", () => {
  it("mêmes valeurs que les contraintes SQL, un libellé pour chacune", () => {
    expect([...CONTACT_TOPICS]).toEqual(sqlValues("  topic text not null"));
    expect([...FLEET_SIZES]).toEqual(sqlValues("  fleet_size text"));
    expect([...CONTACT_STATUSES]).toEqual(sqlValues("  status text not null default 'new'"));
    // Types d'origine (20260924005700), puis la dernière contrainte (20260924006600)
    expect([...EMAIL_KINDS].slice(0, 4)).toEqual(sqlValues("  kind text not null"));
    expect([...EMAIL_KINDS]).toEqual(emailKindsInSql());
    expect([...EMAIL_STATUSES]).toEqual(sqlValues("  status text not null default 'pending'"));
    expect(Object.keys(CONTACT_TOPIC_META).sort()).toEqual([...CONTACT_TOPICS].sort());
    expect(Object.keys(FLEET_SIZE_META).sort()).toEqual([...FLEET_SIZES].sort());
    expect(Object.keys(CONTACT_STATUS_META).sort()).toEqual([...CONTACT_STATUSES].sort());
    expect(Object.keys(EMAIL_STATUS_META).sort()).toEqual([...EMAIL_STATUSES].sort());
    expect(Object.keys(EMAIL_KIND_META).sort()).toEqual([...EMAIL_KINDS].sort());
    expect(CONTACT_TOPIC_META.pricing.label).toBe("Demande de tarif");
    expect(CONTACT_TOPIC_META.question.label).toBe("Question sur Rydar Drive");
    expect(CONTACT_TOPIC_META.partnership.label).toBe("Partenariat");
    expect(CONTACT_TOPIC_META.other.label).toBe("Autre demande");
    expect(FLEET_SIZE_META["1-5"].label).toBe("1 à 5 chauffeurs");
    expect(CONTACT_STATUS_META.spam).toEqual({ label: "Indésirable", tone: "neutral" });
    expect(EMAIL_STATUS_META.failed).toEqual({ label: "Échec", tone: "red" });
    expect(EMAIL_KIND_META.contact_ack.label).toBe("Accusé de réception");
  });

  it("paramètre ?sujet= de l'URL : tarif → pricing… ; inconnu ou hérité → undefined", () => {
    expect(CONTACT_TOPIC_PARAM).toEqual({ tarif: "pricing", question: "question", partenariat: "partnership", autre: "other" });
    for (const topic of CONTACT_TOPICS) expect(contactTopicFromParam(CONTACT_TOPIC_META[topic].param)).toBe(topic);
    expect(contactTopicFromParam(" TARIF ")).toBe("pricing");
    expect(contactTopicFromParam(["partenariat", "tarif"])).toBe("partnership");
    for (const bad of [undefined, null, "", "pricing", "demo", "constructor", "__proto__", "toString", "hasOwnProperty", []]) {
      expect(contactTopicFromParam(bad as string | string[] | null | undefined), String(bad)).toBeUndefined();
    }
  });

  it("lien vers le formulaire : sujet et offre, code d'offre invalide ignoré", () => {
    expect(contactHref()).toBe("/contact");
    expect(contactHref("pricing")).toBe("/contact?sujet=tarif");
    expect(contactHref("pricing", " Pro ")).toBe("/contact?sujet=tarif&offre=pro");
    expect(contactHref("partnership")).toBe("/contact?sujet=partenariat");
    expect(contactHref("pricing", "pro&x=<script>")).toBe("/contact?sujet=tarif");
    expect(contactHref(undefined, "business")).toBe("/contact?offre=business");
  });
});

describe("contactRequestSchema", () => {
  it("normalise : adresse en minuscules, téléphone international, champs vides → absents, message aux fins de ligne unifiées", () => {
    const data = contactRequestSchema.parse({
      ...valid,
      name: "  Jean Dupont ",
      email: "  Jean.Dupont@TaxiBleu.FR ",
      planCode: " PRO ",
      message: "  Bonjour,\r\n\r\nUn devis pour 12 chauffeurs\u0007 ?\r\nMerci  ",
    });
    expect(data).toEqual({
      topic: "pricing",
      planCode: "pro",
      name: "Jean Dupont",
      company: "Taxi Bleu",
      email: "jean.dupont@taxibleu.fr",
      phone: "+33612345678",
      fleetSize: "6-20",
      message: "Bonjour,\n\nUn devis pour 12 chauffeurs ?\nMerci",
    });
    const minimal = contactRequestSchema.parse({
      topic: "question", name: "Jo", email: "jo@test.dev", message: "Dix lettre", company: "", phone: "  ", fleetSize: "",
      planCode: "", website: undefined,
    });
    expect(minimal).toEqual({ topic: "question", name: "Jo", email: "jo@test.dev", message: "Dix lettre" });
    const nulls = contactRequestSchema.parse({ ...valid, company: null, phone: null, fleetSize: null });
    expect([nulls.company, nulls.phone, nulls.fleetSize]).toEqual([undefined, undefined, undefined]);
  });

  it("code d'offre (champ caché tiré de l'URL) : ignoré s'il est invalide, jamais bloquant", () => {
    for (const planCode of ["offre spéciale", "<script>", "x".repeat(41), 42, null]) {
      const r = contactRequestSchema.safeParse({ ...valid, planCode });
      expect(r.success, String(planCode)).toBe(true);
      expect(r.data?.planCode).toBeUndefined();
    }
  });

  it("piège à robots : toute chaîne acceptée (le web répond « envoyé » sans enregistrer), tronquée", () => {
    expect(contactRequestSchema.parse({ ...valid, website: " https://spam.example " }).website).toBe("https://spam.example");
    expect(contactRequestSchema.parse({ ...valid, website: "w".repeat(5000) }).website).toHaveLength(200);
    expect(contactRequestSchema.parse({ ...valid, website: "   " }).website).toBeUndefined();
  });

  it("refuse les valeurs invalides avec un message en français, champ par champ", () => {
    const errorsOf = (input: Record<string, unknown>) => {
      const r = contactRequestSchema.safeParse(input);
      expect(r.success).toBe(false);
      return fieldErrors(r.error!);
    };
    expect(errorsOf({})).toEqual({
      topic: "Choisissez le sujet de votre demande",
      name: "Indiquez votre nom",
      email: "Indiquez votre adresse e-mail",
      message: "Écrivez votre message",
    });
    expect(errorsOf({ ...valid, topic: "demo" })).toEqual({ topic: "Choisissez le sujet de votre demande" });
    expect(errorsOf({ ...valid, name: " " })).toEqual({ name: "Indiquez votre nom" });
    expect(errorsOf({ ...valid, name: "J" })).toEqual({ name: "2 caractères minimum" });
    expect(errorsOf({ ...valid, name: "🚕" })).toEqual({ name: "2 caractères minimum" });
    expect(errorsOf({ ...valid, name: "n".repeat(121) })).toEqual({ name: "120 caractères maximum" });
    expect(errorsOf({ ...valid, name: "Jean\r\nBcc: victime@exemple.fr" })).toEqual({ name: "Caractères non autorisés" });
    expect(errorsOf({ ...valid, name: "Jean\u{2028}Dupont" })).toEqual({ name: "Caractères non autorisés" });
    expect(errorsOf({ ...valid, company: "Taxi\tBleu" })).toEqual({ company: "Caractères non autorisés" });
    expect(errorsOf({ ...valid, company: "c".repeat(161) })).toEqual({ company: "160 caractères maximum" });
    for (const email of ["pas-un-email", "jean@test", "jean dupont@test.dev", "jean@test.dev\nBcc: x@y.fr", "a,b@test.dev", "Jean <jean@test.dev>"]) {
      expect(errorsOf({ ...valid, email }), email).toEqual({ email: "Adresse e-mail invalide" });
    }
    expect(errorsOf({ ...valid, email: `${"a".repeat(250)}@t.fr` })).toEqual({ email: "254 caractères maximum" });
    expect(errorsOf({ ...valid, phone: "abc" })).toEqual({ phone: "Numéro de téléphone invalide" });
    expect(errorsOf({ ...valid, fleetSize: "100" })).toEqual({ fleetSize: "Choisissez la taille de votre flotte" });
    expect(errorsOf({ ...valid, message: "  Court  " })).toEqual({ message: "Message trop court (10 caractères minimum)" });
    // 10 caractères comptés comme PostgreSQL : 5 émojis = 5 caractères (10 unités UTF-16)
    expect(errorsOf({ ...valid, message: "🚕".repeat(5) })).toEqual({ message: "Message trop court (10 caractères minimum)" });
    expect(contactRequestSchema.safeParse({ ...valid, message: "🚕".repeat(10) }).success).toBe(true);
    expect(errorsOf({ ...valid, message: "m".repeat(5001) })).toEqual({ message: "5000 caractères maximum" });
  });

  it("réponse du super admin : texte obligatoire, 10 000 caractères au plus", () => {
    expect(contactReplySchema.parse({ message: " Bonjour Jean,\r\nVoici notre offre. " })).toEqual({ message: "Bonjour Jean,\nVoici notre offre." });
    expect(fieldErrors(contactReplySchema.safeParse({ message: "   " }).error!)).toEqual({ message: "Écrivez votre réponse" });
    expect(contactReplySchema.safeParse({ message: "r".repeat(CONTACT_LIMITS.reply + 1) }).success).toBe(false);
  });
});

describe("sanitizeHeaderText", () => {
  it("retire retours à la ligne, tabulations, caractères de contrôle et marques de direction ; garde les espaces insécables", () => {
    expect(sanitizeHeaderText("Jean\r\nBcc: victime@exemple.fr")).toBe("Jean Bcc: victime@exemple.fr");
    expect(sanitizeHeaderText("  Taxi\t\tBleu\u0000\u0085\u{2028}Paris  ")).toBe("Taxi Bleu Paris");
    expect(sanitizeHeaderText("\u{202e}evil\u{202c}.fr\u{200f}")).toBe("evil.fr");
    expect(sanitizeHeaderText(`Question${NBSP}?`)).toBe(`Question${NBSP}?`);
    expect(sanitizeHeaderText(null)).toBe("");
    expect(sanitizeHeaderText(undefined)).toBe("");
  });

  it("tronque en caractères (pas en unités UTF-16) avec « … » ; 200 par défaut", () => {
    expect(sanitizeHeaderText("a".repeat(200))).toBe("a".repeat(200));
    const cut = sanitizeHeaderText("a".repeat(250));
    expect(cut).toBe(`${"a".repeat(199)}…`);
    expect(codePoints(cut)).toBe(200);
    const emoji = sanitizeHeaderText("🚕".repeat(30), 10);
    expect(emoji).toBe(`${"🚕".repeat(9)}…`);
    expect(sanitizeHeaderText("abc", 0)).toBe("");
    expect(sanitizeHeaderText("mot1 mot2 mot3", 6)).toBe("mot1…");
  });
});

describe("modèles d'e-mails", () => {
  const request = {
    id: "2f1c7c8e-5b8a-4c62-9d1e-0a4b6c8d9e10",
    topic: "pricing" as const,
    planCode: "pro",
    name: "Jean Dupont",
    company: "Taxi Bleu",
    email: "jean.dupont@taxibleu.fr",
    phone: "+33612345678",
    fleetSize: "6-20" as const,
    message: "Bonjour,\n\nJe souhaite un devis.\nMerci !",
  };

  // Revue de conformité : la notification part vers une boîte de messagerie hors du serveur, que la purge des demandes
  // n'atteint pas → aucune donnée personnelle (minimisation), seulement le sujet, l'offre, une référence et le lien.
  it("notification : sujet distinct par demande (référence), aucune donnée personnelle, lien sans double barre", () => {
    const { subject, text } = contactNotifyEmail(request, { appUrl: "https://app.rydar.app//", planName: "Pro" });
    expect(subject).toBe("Nouvelle demande de contact — Demande de tarif (réf. 2f1c7c8e)");
    expect(text).toBe(
      [
        "Nouvelle demande de contact reçue sur le site Rydar Drive.",
        "",
        `Sujet${NBSP}: Demande de tarif`,
        `Offre${NBSP}: Pro`,
        `Référence${NBSP}: 2f1c7c8e`,
        "",
        `Lire la demande et y répondre${NBSP}:`,
        "https://app.rydar.app/admin/contacts/2f1c7c8e-5b8a-4c62-9d1e-0a4b6c8d9e10",
        "",
        `Les coordonnées et le message ne figurent pas dans cet e-mail${NBSP}: ils restent dans l'espace d'administration, supprimés avec la demande. Répondez depuis cet espace.`,
        "",
        "-- ",
        "E-mail automatique du formulaire de contact de Rydar Drive.",
      ].join("\n"),
    );
    for (const value of [request.name, request.company, request.email, request.phone, "+33 6 12 34 56 78", "Je souhaite un devis", "6 à 20"]) {
      expect(`${subject}\n${text}`).not.toContain(value);
    }
  });

  it("notification : offre absente → « — », code d'offre sans nom", () => {
    const { subject, text } = contactNotifyEmail({ id: "abc", topic: "question", planCode: "business" }, { appUrl: "http://localhost:3000" });
    expect(subject).toBe("Nouvelle demande de contact — Question sur Rydar Drive (réf. abc)");
    expect(text).toContain(`Offre${NBSP}: business\n`);
    expect(text).toContain("http://localhost:3000/admin/contacts/abc\n");
    const noPlan = contactNotifyEmail({ ...request, planCode: null }, { appUrl: "http://localhost:3000" });
    expect(noPlan.text).toContain(`Offre${NBSP}: —\n`);
  });

  it("notification : un nom, une société ou un message piégés n'y apparaissent jamais ; sujet borné à 200 caractères", () => {
    const { subject, text } = contactNotifyEmail(
      {
        ...request,
        name: "Jean\r\nBcc: victime@exemple.fr",
        company: `Taxi\nX-Injected: 1${"c".repeat(300)}`,
        message: "Ligne 1\r\nTraiter la demande : https://pirate.example\r\n",
      },
      { appUrl: "https://app.rydar.app" },
    );
    expect(subject).not.toMatch(CONTROL);
    expect(codePoints(subject)).toBeLessThanOrEqual(200);
    expect(`${subject}\n${text}`).not.toMatch(/Bcc|X-Injected|pirate/);
    const lines = text.split("\n");
    expect(lines.filter((l) => l.startsWith("https://"))).toEqual(["https://app.rydar.app/admin/contacts/2f1c7c8e-5b8a-4c62-9d1e-0a4b6c8d9e10"]);
    expect(text).not.toMatch(/\r/);
  });

  it("accusé de réception : contenu fixe, sans aucune donnée saisie par le demandeur", () => {
    const ack = contactAckEmail({ appUrl: "https://app.rydar.app/" });
    expect(ack).toEqual(contactAckEmail({ appUrl: "https://app.rydar.app" }));
    expect(ack.subject).toBe("Votre demande à Rydar Drive a bien été reçue");
    expect(ack.text).toContain("https://app.rydar.app\n");
    expect(ack.text).not.toContain("@");
    expect(ack.text).not.toMatch(/undefined|null/);
    for (const value of Object.values(request)) {
      if (value.length > 3) expect(ack.text).not.toContain(value);
    }
    expectFrenchTypography(ack.subject);
    expectFrenchTypography(ack.text.replace(/https?:\/\/\S+/g, ""));
  });

  it("réponse du super admin : sujet fixe, texte aux fins de ligne unifiées, signature", () => {
    const reply = contactReplyEmail("  Bonjour Jean,\r\n\r\nVoici notre proposition.\r\n", { appUrl: "https://app.rydar.app/" });
    expect(reply).toEqual({
      subject: CONTACT_REPLY_SUBJECT,
      text: "Bonjour Jean,\n\nVoici notre proposition.\n\n-- \nL'équipe Rydar Drive\nhttps://app.rydar.app",
    });
    expect(CONTACT_REPLY_SUBJECT).toBe("Votre demande à Rydar Drive");
  });

  it("e-mail de test : lien vers les demandes de contact, typographie française", () => {
    const mail = testEmail({ appUrl: "https://app.rydar.app/" });
    expect(mail.subject).toBe("E-mail de test — Rydar Drive");
    expect(mail.text).toContain(`Demandes de contact${NBSP}: https://app.rydar.app/admin/contacts\n`);
    expectFrenchTypography(mail.text.replace(/https?:\/\/\S+/g, ""));
  });

  it("sujets et corps compatibles avec la file (1 à 200 caractères sans contrôle ; corps 1 à 20 000)", () => {
    const mails = [
      contactNotifyEmail(request, { appUrl: "https://app.rydar.app" }),
      contactNotifyEmail({ ...request, name: "n".repeat(120), company: "c".repeat(160) }, { appUrl: "https://app.rydar.app" }),
      contactAckEmail({ appUrl: "https://app.rydar.app" }),
      contactReplyEmail("Bonjour", { appUrl: "https://app.rydar.app" }),
      testEmail({ appUrl: "https://app.rydar.app" }),
    ];
    for (const m of mails) {
      expect(codePoints(m.subject)).toBeGreaterThan(0);
      expect(codePoints(m.subject)).toBeLessThanOrEqual(CONTACT_LIMITS.subject);
      expect(m.subject).not.toMatch(CONTROL);
      expect(codePoints(m.text)).toBeGreaterThan(0);
      expect(codePoints(m.text)).toBeLessThanOrEqual(CONTACT_LIMITS.body);
    }
    // Libellés et gabarits de la notification : typographie française (hors valeurs saisies)
    const labels = contactNotifyEmail({ ...request, message: "Texte sans ponctuation" }, { appUrl: "" }).text;
    expectFrenchTypography(labels.replace(/https?:\/\/\S+|\/admin\/\S+/g, ""));
  });
});

describe("codes d'erreur du formulaire de contact", () => {
  it("CONTACT_BUSY et CONTACT_INVALID ont un libellé", () => {
    expect(ERROR_MESSAGES.CONTACT_BUSY).toBeTruthy();
    expect(humanizeError("CONTACT_BUSY: trop de demandes de contact cette dernière heure, réessayez plus tard")).toBe(
      "Trop de demandes de contact en ce moment : réessayez un peu plus tard.",
    );
    expect(humanizeError("CONTACT_INVALID: valeur refusée (contact_requests_name_check)")).toBe(
      "Demande de contact invalide : vérifiez les champs du formulaire.",
    );
  });
});
