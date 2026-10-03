import { afterEach, describe, expect, it } from "vitest";
import { closedPort, decodeBody, decodeHeader, parseMessage, startFakeSmtp } from "./fake-smtp";
import {
  classifySmtpError, createSmtpSender, headerText, isMailAddress, mailOptions, parseMailbox, PermanentEmailError,
  SMTP_TIMEOUTS, smtpSettings, type OutboxEmail, type SmtpSender,
} from "./smtp";

const BODY = [
  "Sujet : Demande de tarif",
  "Nom : Émilie Durand",
  "Société : Taxis Éclair — Lyon",
  "",
  "Message :",
  "Bonjour, nous avons 12 chauffeurs ; quel serait le tarif ?",
  ".ligne qui commence par un point",
  "https://rydar.example/admin/contacts/2b1f0c9e-6f1e-4a53-9a3f-0d2f6f3b8c11",
].join("\n");

const email = (over: Partial<OutboxEmail> = {}): OutboxEmail => ({
  id: "41",
  kind: "contact_notify",
  to_email: "admin@rydar.example",
  reply_to: "client@exemple.org",
  subject: "Nouvelle demande de contact — Demande de tarif",
  body_text: BODY,
  attempts: 1,
  ...over,
});

describe("mailer — réglages SMTP depuis l'environnement", () => {
  it("défauts : serveur mail du VPS en boucle locale (127.0.0.1:25), sans STARTTLS ni identifiant", () => {
    const s = smtpSettings({ DOMAIN: "rydar.example" });
    expect(s.transport).toMatchObject({ host: "127.0.0.1", port: 25, secure: false, ignoreTLS: true, name: "rydar.example" });
    expect(s.transport.requireTLS).toBeFalsy();
    expect(s.transport.auth).toBeUndefined();
    expect(s.from).toEqual({ name: "Rydar Drive", address: "noreply@rydar.example" });
    expect(s.summary).toEqual({ host: "127.0.0.1", port: 25, tls: "loopback-plain", auth: false, from: "noreply@rydar.example" });
    expect(s.warnings).toEqual([]);
  });

  it("variables vides (Docker) = défauts ; sans DOMAIN : noreply@localhost et avertissement", () => {
    const empty = { SMTP_HOST: "", SMTP_PORT: "", SMTP_USER: "", SMTP_PASS: "", MAIL_FROM: "" };
    expect(smtpSettings({ ...empty, DOMAIN: "rydar.example" }).transport).toMatchObject({ host: "127.0.0.1", port: 25, ignoreTLS: true });
    const bare = smtpSettings(empty);
    expect(bare.from.address).toBe("noreply@localhost");
    expect(bare.transport.name).toBeUndefined();
    expect(bare.warnings.join(" ")).toMatch(/noreply@localhost/);
  });

  it("localhost et ::1 : boucle locale aussi", () => {
    expect(smtpSettings({ SMTP_HOST: "localhost" }).transport.ignoreTLS).toBe(true);
    expect(smtpSettings({ SMTP_HOST: "::1" }).transport.ignoreTLS).toBe(true);
    expect(smtpSettings({ SMTP_HOST: "[::1]" }).transport).toMatchObject({ host: "::1", ignoreTLS: true });
  });

  it("relais externe sur 587 avec identifiant : STARTTLS obligatoire, certificat vérifié, secret absent du résumé", () => {
    const s = smtpSettings({ SMTP_HOST: "smtp.exemple.net", SMTP_PORT: "587", SMTP_USER: "rydar@exemple.net", SMTP_PASS: "motdepasse-secret", DOMAIN: "rydar.example" });
    expect(s.transport).toMatchObject({ host: "smtp.exemple.net", port: 587, secure: false, requireTLS: true, auth: { user: "rydar@exemple.net", pass: "motdepasse-secret" } });
    expect(s.transport.ignoreTLS).toBeFalsy();
    expect(s.transport.tls).toMatchObject({ rejectUnauthorized: true });
    expect(s.summary).toMatchObject({ tls: "starttls-required", auth: true });
    expect(JSON.stringify(s.summary)).not.toMatch(/motdepasse-secret|rydar@exemple\.net/);
  });

  it("port 465 : TLS dès la connexion, certificat vérifié", () => {
    const s = smtpSettings({ SMTP_HOST: "smtp.exemple.net", SMTP_PORT: "465", SMTP_USER: "u", SMTP_PASS: "p" });
    expect(s.transport).toMatchObject({ secure: true, tls: { rejectUnauthorized: true } });
    expect(s.transport.ignoreTLS).toBeFalsy();
    expect(s.summary.tls).toBe("implicit");
  });

  it("hors boucle locale sans identifiant : STARTTLS s'il est proposé, jamais sans vérification du certificat", () => {
    const s = smtpSettings({ SMTP_HOST: "relais.exemple.net" });
    expect(s.transport).toMatchObject({ port: 25, secure: false, requireTLS: false, tls: { rejectUnauthorized: true } });
    expect(s.transport.ignoreTLS).toBeFalsy();
    expect(s.summary.tls).toBe("starttls");
  });

  it("boucle locale avec identifiant : l'identifiant ne passe jamais en clair (STARTTLS obligatoire)", () => {
    const s = smtpSettings({ SMTP_USER: "u", SMTP_PASS: "p" });
    expect(s.transport).toMatchObject({ host: "127.0.0.1", requireTLS: true, tls: { rejectUnauthorized: true } });
    expect(s.transport.ignoreTLS).toBeFalsy();
  });

  it("délais de connexion, d'accueil, de socket et de DNS bornés", () => {
    const t = smtpSettings({}).transport;
    for (const key of ["connectionTimeout", "greetingTimeout", "socketTimeout", "dnsTimeout"] as const) {
      expect(t[key]).toBe(SMTP_TIMEOUTS[key]);
      expect(t[key]).toBeGreaterThan(0);
      expect(t[key]).toBeLessThanOrEqual(60_000);
    }
    expect(t).toMatchObject({ disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false });
  });

  it("SMTP_PORT invalide : port 25 et avertissement", () => {
    for (const port of ["abc", "70000", "25a", "0"]) {
      const s = smtpSettings({ SMTP_PORT: port, DOMAIN: "rydar.example" });
      expect(s.transport.port).toBe(25);
      expect(s.warnings[0]).toMatch(/SMTP_PORT invalide/);
    }
  });

  it("MAIL_FROM : adresse seule (nom « Rydar Drive »), « Nom <adresse> », sinon défaut et avertissement", () => {
    expect(smtpSettings({ MAIL_FROM: "contact@rydar.example" }).from).toEqual({ name: "Rydar Drive", address: "contact@rydar.example" });
    expect(smtpSettings({ MAIL_FROM: "Support Rydar <support@rydar.example>" }).from).toEqual({ name: "Support Rydar", address: "support@rydar.example" });
    expect(parseMailbox('"Rydar Drive" <noreply@rydar.example>')).toEqual({ name: "Rydar Drive", address: "noreply@rydar.example" });
    for (const bad of ["pas une adresse", "a@b.fr\r\nBcc: espion@exemple.org", "Nom <a@b.fr>, autre@c.fr", "<a@b.fr", 'Nom "x" <a@b.fr>']) {
      const s = smtpSettings({ MAIL_FROM: bad, DOMAIN: "rydar.example" });
      expect(s.from).toEqual({ name: "Rydar Drive", address: "noreply@rydar.example" });
      expect(s.warnings.join(" ")).toMatch(/MAIL_FROM invalide/);
    }
  });
});

describe("mailer — message construit depuis une ligne de la file", () => {
  const from = { name: "Rydar Drive", address: "noreply@rydar.example" };

  it("un seul destinataire (enveloppe explicite), Reply-To, texte brut, Auto-Submitted pour un envoi automatique", () => {
    const o = mailOptions(email(), from);
    expect(o).toMatchObject({
      from,
      to: { name: "", address: "admin@rydar.example" },
      replyTo: { name: "", address: "client@exemple.org" },
      subject: "Nouvelle demande de contact — Demande de tarif",
      text: BODY,
      envelope: { from: "noreply@rydar.example", to: ["admin@rydar.example"] },
      headers: { "Auto-Submitted": "auto-generated" },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(o.html).toBeUndefined();
    expect(o.attachments).toBeUndefined();
  });

  it("annonces aux organisations (frais Rydar, CGV) : Auto-Submitted", () => {
    for (const kind of ["platform_fee_change", "org_terms_update"]) {
      expect(mailOptions(email({ kind }), from).headers).toEqual({ "Auto-Submitted": "auto-generated" });
    }
  });

  it("réponse rédigée par le super admin : pas d'Auto-Submitted ; sans reply_to : pas de Reply-To", () => {
    const o = mailOptions(email({ kind: "contact_reply", reply_to: null, to_email: "client@exemple.org" }), from);
    expect(o.headers).toBeUndefined();
    expect(o.replyTo).toBeUndefined();
    expect(o.envelope).toEqual({ from: "noreply@rydar.example", to: ["client@exemple.org"] });
  });

  it("adresse invalide, liste ou injection d'en-tête : refus définitif avant tout envoi", () => {
    for (const to of ["", "pas-une-adresse", "a@b.fr, c@d.fr", "a@b.fr\r\nBcc: espion@exemple.org", "Nom <a@b.fr>", "a b@c.fr"]) {
      let error: unknown = null;
      try {
        mailOptions(email({ to_email: to }), from);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(PermanentEmailError);
      expect(classifySmtpError(error)).toMatchObject({ permanent: true, smtpDown: false, message: "Adresse du destinataire invalide" });
    }
    expect(() => mailOptions(email({ reply_to: "x@y.fr\nBcc: z@w.fr" }), from)).toThrow("Adresse de réponse invalide");
    expect(() => mailOptions(email({ subject: "\r\n" }), from)).toThrow("Objet vide");
    expect(() => mailOptions(email({ body_text: "  " }), from)).toThrow("Message vide");
  });

  it("objet ramené sur une ligne (CR, LF et caractères de contrôle retirés)", () => {
    expect(mailOptions(email({ subject: "Ligne 1\r\nBcc: espion@exemple.org\u0000" }), from).subject).toBe("Ligne 1 Bcc: espion@exemple.org");
    expect(headerText("  a\tb  c ")).toBe("a b c");
    expect(headerText("x".repeat(300))).toHaveLength(200);
  });

  it("adresses simples acceptées, dont un domaine accentué ; séparateurs et chevrons refusés", () => {
    for (const ok of ["a@b.fr", "prenom.nom+rydar@sous.domaine.example", "contact@société.fr"]) expect(isMailAddress(ok)).toBe(true);
    for (const bad of ["a@b", "@b.fr", "a@@b.fr", "a;b@c.fr", "<a@b.fr>", "a@b.fr ", `${"x".repeat(250)}@b.fr`]) expect(isMailAddress(bad)).toBe(false);
  });
});

describe("mailer — classement des erreurs SMTP", () => {
  const smtpError = (props: Record<string, unknown>, message = "Can't send mail") => Object.assign(new Error(message), props);

  it("code 5xx sur l'expéditeur, un destinataire ou le message : définitif", () => {
    for (const responseCode of [500, 550, 552, 554]) {
      for (const command of ["RCPT TO", "MAIL FROM", "DATA", undefined]) {
        const c = classifySmtpError(smtpError({ code: command === "DATA" ? "EMESSAGE" : "EENVELOPE", responseCode, command, response: `${responseCode} 5.1.1 rejected` }));
        expect(c).toMatchObject({ permanent: true, smtpDown: false });
        expect(c.message).toContain(`Refus définitif du serveur mail (${responseCode})`);
      }
    }
  });

  it("refus pendant l'accueil, EHLO ou STARTTLS (réglage du serveur) : réessai, serveur signalé indisponible", () => {
    const cases = [
      { code: "EPROTOCOL", command: "CONN", responseCode: 554 },
      { code: "ECONNECTION", command: "EHLO", responseCode: 421 },
      { code: "ECONNECTION", command: "EHLO", responseCode: 502 },
      { code: "ETLS", command: "STARTTLS", responseCode: 454 },
      { code: "ETLS", command: "STARTTLS", responseCode: 530 },
    ];
    for (const props of cases) {
      const c = classifySmtpError(smtpError(props, `refus ${props.responseCode}`));
      expect(c).toMatchObject({ permanent: false, smtpDown: true });
      expect(c.message).toBe(`Serveur mail indisponible (${props.responseCode}) : refus ${props.responseCode}`);
    }
  });

  it("code 4xx : réessai", () => {
    for (const responseCode of [421, 450, 451, 452]) {
      const c = classifySmtpError(smtpError({ code: "EENVELOPE", responseCode }));
      expect(c).toMatchObject({ permanent: false, smtpDown: false });
      expect(c.message).toContain(`Refus temporaire du serveur mail (${responseCode})`);
    }
  });

  it("connexion refusée, coupée, DNS, TLS, délai : réessai, serveur signalé indisponible", () => {
    for (const code of ["ESOCKET", "ECONNECTION", "EDNS", "ECONNREFUSED", "ETLS", "ETIMEDOUT", "ESENDTIMEOUT"]) {
      expect(classifySmtpError(smtpError({ code }, "connect ECONNREFUSED 127.0.0.1:25"))).toMatchObject({ permanent: false, smtpDown: true });
    }
    expect(classifySmtpError(smtpError({ code: "ESOCKET" }, "connect ECONNREFUSED 127.0.0.1:25")).message).toBe(
      "Serveur mail injoignable : connect ECONNREFUSED 127.0.0.1:25",
    );
  });

  it("identifiants refusés (535, ou manquants) : réessai, serveur signalé indisponible — jamais tout en échec d'un coup", () => {
    const c = classifySmtpError(smtpError({ code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" }, "Invalid login: 535 5.7.8 Authentication failed"));
    expect(c).toEqual({ permanent: false, smtpDown: true, message: "Identifiants SMTP refusés (535) : Invalid login: 535 5.7.8 Authentication failed" });
    expect(classifySmtpError(smtpError({ code: "EAUTH", command: "API" }, 'Missing credentials for "PLAIN"'))).toMatchObject({
      permanent: false,
      smtpDown: true,
      message: 'Identifiants SMTP refusés : Missing credentials for "PLAIN"',
    });
  });

  it("enveloppe ou message refusés par nodemailer avant tout échange : définitif", () => {
    expect(classifySmtpError(smtpError({ code: "EENVELOPE" }, "No recipients defined"))).toMatchObject({ permanent: true, smtpDown: false });
    expect(classifySmtpError(smtpError({ code: "EMESSAGE" }, "Message size larger than allowed 1000"))).toMatchObject({ permanent: true });
  });

  it("erreur inconnue : réessai ; motif sur une ligne, 500 caractères au plus", () => {
    const c = classifySmtpError(new Error(`ligne 1\r\nligne 2 ${"x".repeat(900)}`));
    expect(c.permanent).toBe(false);
    expect(c.smtpDown).toBe(false);
    expect(c.message.length).toBeLessThanOrEqual(500);
    expect(c.message).not.toMatch(/[\r\n]/);
    expect(classifySmtpError("texte")).toMatchObject({ permanent: false, message: "Échec de l'envoi : texte" });
  });
});

describe("mailer — envoi réel par nodemailer vers un faux serveur SMTP (127.0.0.1)", () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  async function setup(opts: Parameters<typeof startFakeSmtp>[0] = {}) {
    const server = await startFakeSmtp(opts);
    const sender: SmtpSender = createSmtpSender(smtpSettings({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(server.port), DOMAIN: "rydar.example" }));
    cleanup.push(() => sender.close(), () => server.close());
    return { server, sender };
  }

  it("enveloppe, en-têtes (objet UTF-8 encodé, Reply-To, Auto-Submitted) et corps texte brut UTF-8", async () => {
    const { server, sender } = await setup();
    await sender.send(email());

    const [session] = server.messages();
    expect(server.messages()).toHaveLength(1);
    expect(session!.ehlo).toBe("rydar.example");
    expect(session!.mailFrom).toBe("noreply@rydar.example");
    expect(session!.rcptTo).toEqual(["admin@rydar.example"]);
    expect(session!.commands.filter((c) => c.startsWith("RCPT"))).toHaveLength(1);

    const { headers, body } = parseMessage(session!.data!);
    expect(headers.get("from")).toMatch(/^"?Rydar Drive"? <noreply@rydar\.example>$/);
    expect(headers.get("to")).toBe("admin@rydar.example");
    expect(headers.get("reply-to")).toBe("client@exemple.org");
    expect(headers.get("auto-submitted")).toBe("auto-generated");
    expect(headers.has("cc")).toBe(false);
    expect(headers.has("bcc")).toBe(false);
    // Objet non ASCII : mots encodés RFC 2047 en UTF-8, jamais d'octet brut dans l'en-tête
    const rawSubject = headers.get("subject")!;
    expect(rawSubject).toMatch(/=\?UTF-8\?[QB]\?/i);
    expect(rawSubject).toMatch(/^[\x20-\x7e]+$/);
    expect(decodeHeader(rawSubject)).toBe("Nouvelle demande de contact — Demande de tarif");
    expect(headers.get("content-type")).toMatch(/^text\/plain; charset=utf-8$/i);
    expect(headers.get("message-id")).toMatch(/@rydar\.example>$/);
    expect(headers.get("date")).toBeTruthy();
    // Corps transmis en 7 bits (quoted-printable ou base64), identique une fois décodé
    expect(session!.data!).toMatch(/^[\x09\x0d\x0a\x20-\x7e]*$/);
    const text = decodeBody(body, headers.get("content-transfer-encoding")).replace(/\r\n/g, "\n");
    expect(text.replace(/\n+$/, "")).toBe(BODY);
  });

  it("destinataire refusé (550) : erreur classée définitive", async () => {
    const { server, sender } = await setup({
      rcpt: (to) => (to === "inconnu@exemple.org" ? "550 5.1.1 <inconnu@exemple.org>: Recipient address rejected: User unknown" : null),
    });
    const error = await sender.send(email({ to_email: "inconnu@exemple.org" })).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ responseCode: 550 });
    const c = classifySmtpError(error);
    expect(c).toMatchObject({ permanent: true, smtpDown: false });
    expect(c.message).toContain("(550)");
    expect(server.messages()).toHaveLength(0);
  });

  it("refus temporaire (450) : erreur classée à réessayer", async () => {
    const { server, sender } = await setup({ rcpt: () => "450 4.2.0 <client@exemple.org>: Recipient address rejected: try again later" });
    const error = await sender.send(email({ to_email: "client@exemple.org" })).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ responseCode: 450 });
    expect(classifySmtpError(error)).toMatchObject({ permanent: false, smtpDown: false });
    expect(server.messages()).toHaveLength(0);
  });

  it("aucun serveur mail (connexion refusée) : réessai, serveur signalé indisponible", async () => {
    const port = await closedPort();
    const sender = createSmtpSender(smtpSettings({ SMTP_PORT: String(port), DOMAIN: "rydar.example" }));
    cleanup.push(() => sender.close());
    const error = await sender.send(email()).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const c = classifySmtpError(error);
    expect(c).toMatchObject({ permanent: false, smtpDown: true });
    expect(c.message).toMatch(/^Serveur mail injoignable : .*ECONNREFUSED/);
    await expect(sender.verify()).rejects.toThrow(/ECONNREFUSED/);
  });

  it("serveur qui refuse la machine dès l'accueil (554) : réessai, serveur signalé indisponible, aucun message", async () => {
    const { server, sender } = await setup({ greeting: "554 5.7.1 fake.test: access denied" });
    const error = await sender.send(email()).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ responseCode: 554, command: "CONN" });
    expect(classifySmtpError(error)).toMatchObject({ permanent: false, smtpDown: true });
    expect(classifySmtpError(error).message).toMatch(/^Serveur mail indisponible \(554\) : /);
    await expect(sender.verify()).rejects.toMatchObject({ responseCode: 554 });
    expect(server.messages()).toHaveLength(0);
  });

  it("vérification (verify) : EHLO puis QUIT, aucun message transmis", async () => {
    const { server, sender } = await setup();
    await sender.verify();
    expect(server.sessions.length).toBeGreaterThan(0);
    expect(server.sessions[0]!.ehlo).toBe("rydar.example");
    expect(server.messages()).toHaveLength(0);
  });
});
