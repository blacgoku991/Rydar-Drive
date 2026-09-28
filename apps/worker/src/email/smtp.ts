// Envoi SMTP des e-mails de la file public.email_outbox (service « mailer », dist/mailer.js).
//
// Par défaut, le serveur mail du VPS lui-même (Postfix…) sur 127.0.0.1:25 : le conteneur tourne sur le réseau de
// l'hôte (deploy/docker-compose.yml), la connexion vient donc de la boucle locale, que Postfix relaie sans identifiant
// (mynetworks). Relais externe possible (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, réglage avancé) : chiffrement
// obligatoire dès qu'il y a un identifiant ou sur le port 587, certificat toujours vérifié hors boucle locale.
//
// Fonctions pures (réglages, message, classement des erreurs) testées sans réseau ; l'envoi réel est testé contre un
// faux serveur SMTP local (smtp.test.ts).
import nodemailer, { type SendMailOptions } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

export type Env = Record<string, string | undefined>;

/** E-mail réservé par private.claim_emails : colonnes utiles à l'envoi (id bigint, lu en chaîne par pg). */
export type OutboxEmail = {
  id: string | number;
  kind: string;
  to_email: string;
  reply_to: string | null;
  subject: string;
  body_text: string;
  attempts: number;
};

export type Mailbox = { name: string; address: string };

/**
 * Chiffrement retenu (journal de démarrage, point de santé) :
 *  - loopback-plain : serveur de la machine, sans identifiant, sans STARTTLS (certificat local souvent auto-signé) ;
 *  - starttls : STARTTLS si le serveur le propose, certificat vérifié ;
 *  - starttls-required : STARTTLS obligatoire (port 587 ou identifiant), certificat vérifié ;
 *  - implicit : TLS dès la connexion (port 465), certificat vérifié.
 */
export type TlsMode = "loopback-plain" | "starttls" | "starttls-required" | "implicit";

export type SmtpSettings = {
  transport: SMTPTransport.Options;
  from: Mailbox;
  /** Pour le journal et le point de santé : jamais le mot de passe ni l'identifiant. */
  summary: { host: string; port: number; tls: TlsMode; auth: boolean; from: string };
  /** Réglages ignorés (valeur invalide remplacée par le défaut) : journalisés au démarrage. */
  warnings: string[];
};

export const DEFAULT_SMTP_HOST = "127.0.0.1";
export const DEFAULT_SMTP_PORT = 25;
export const DEFAULT_FROM_NAME = "Rydar Drive";

/** Délais bornés : un serveur muet ne bloque jamais la file (voir aussi SEND_TIMEOUT_MS). */
export const SMTP_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000, dnsTimeout: 10_000 } as const;
/** Borne de sécurité d'un envoi ou d'une vérification complète, au-delà des délais de nodemailer. */
export const SEND_TIMEOUT_MS = 60_000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const CONTROL = /[\u0000-\u001f\u007f]/;
/** addr-spec simple : ni espace, ni chevron, ni séparateur de liste, ni guillemet, ni commentaire. */
const ADDRESS = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/u;

/** Adresse e-mail simple : garde-fou avant l'enveloppe (aucun second destinataire, aucune injection d'en-tête). */
export function isMailAddress(value: string): boolean {
  return value.length <= 254 && !CONTROL.test(value) && ADDRESS.test(value);
}

/** Texte d'en-tête sur une seule ligne : caractères de contrôle (CR, LF…) retirés, espaces resserrés, longueur bornée. */
export function headerText(value: string, max = 200): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** MAIL_FROM : « adresse » ou « Nom <adresse> » ; sans nom, « Rydar Drive ». null si invalide. */
export function parseMailbox(value: string): Mailbox | null {
  const v = value.trim();
  if (!v || CONTROL.test(v)) return null;
  const bracket = /^([^<>]*)<([^<>]+)>$/.exec(v);
  const address = (bracket ? bracket[2]! : v).trim();
  if (!isMailAddress(address)) return null;
  const name = (bracket ? bracket[1]! : "").trim().replace(/^"(.*)"$/, "$1").trim();
  if (/["\\]/.test(name)) return null;
  return { name: name || DEFAULT_FROM_NAME, address };
}

function parsePort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 65535 ? n : null;
}

/**
 * Réglages du transport depuis l'environnement (valeurs vides = défauts : Docker passe des variables vides) :
 * SMTP_HOST (127.0.0.1), SMTP_PORT (25), SMTP_USER / SMTP_PASS (facultatifs), MAIL_FROM (« Rydar Drive
 * <noreply@DOMAIN> », noreply@localhost sans DOMAIN), DOMAIN (aussi nom annoncé au serveur, EHLO).
 */
export function smtpSettings(env: Env): SmtpSettings {
  const warnings: string[] = [];
  const host = (env.SMTP_HOST || "").trim() || DEFAULT_SMTP_HOST;
  const rawPort = (env.SMTP_PORT || "").trim();
  let port = DEFAULT_SMTP_PORT;
  if (rawPort) {
    const parsed = parsePort(rawPort);
    if (parsed) port = parsed;
    else warnings.push(`SMTP_PORT invalide (« ${rawPort} ») : port ${DEFAULT_SMTP_PORT} utilisé`);
  }
  const user = (env.SMTP_USER || "").trim();
  const pass = env.SMTP_PASS || "";
  if (user && !pass) warnings.push("SMTP_USER renseigné sans SMTP_PASS : l'authentification échouera");
  const domain = (env.DOMAIN || "").trim().toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(host.toLowerCase());
  const secure = port === 465;

  const transport: SMTPTransport.Options = {
    host: host === "[::1]" ? "::1" : host,
    port,
    secure,
    ...SMTP_TIMEOUTS,
    // Texte brut seulement : aucun fichier ni aucune URL lus pour composer un message
    disableFileAccess: true,
    disableUrlAccess: true,
    // Jamais de journal de nodemailer : il contiendrait les adresses et le contenu des messages
    logger: false,
    debug: false,
  };
  // Nom annoncé (EHLO) : le domaine du site plutôt que le nom de la machine, souvent refusé par les relais stricts
  if (domain) transport.name = domain;
  if (user) transport.auth = { user, pass };

  let tls: TlsMode;
  if (secure) {
    tls = "implicit";
    transport.tls = { rejectUnauthorized: true };
  } else if (loopback && !user) {
    // Boucle locale : rien ne sort de la machine, et Postfix y présente souvent un certificat auto-signé
    tls = "loopback-plain";
    transport.ignoreTLS = true;
  } else {
    // Un identifiant ne circule jamais en clair : STARTTLS obligatoire avec identifiant ou sur le port 587
    const required = port === 587 || !!user;
    tls = required ? "starttls-required" : "starttls";
    transport.requireTLS = required;
    transport.tls = { rejectUnauthorized: true };
  }

  const fallback: Mailbox = { name: DEFAULT_FROM_NAME, address: `noreply@${domain || "localhost"}` };
  let from = fallback;
  const rawFrom = (env.MAIL_FROM || "").trim();
  if (rawFrom) {
    const parsed = parseMailbox(rawFrom);
    if (parsed) from = parsed;
    else warnings.push(`MAIL_FROM invalide (attendu : adresse@domaine ou « Nom <adresse@domaine> ») : ${fallback.address} utilisée`);
  } else if (!domain) {
    warnings.push("DOMAIN et MAIL_FROM vides : expéditeur noreply@localhost, refusé par la plupart des serveurs de destination");
  }

  return { transport, from, summary: { host, port, tls, auth: !!user, from: from.address }, warnings };
}

/** Erreur propre au message (adresse invalide, message vide) : jamais réessayée. */
export class PermanentEmailError extends Error {
  override name = "PermanentEmailError";
}

/** Délai global d'un envoi dépassé (serveur qui ne répond plus) : réessayé. */
export class SendTimeoutError extends Error {
  override name = "SendTimeoutError";
  readonly code = "ESENDTIMEOUT";
}

/** Types écrits automatiquement (pas la réponse rédigée par le super admin) : en-tête Auto-Submitted (RFC 3834). */
const AUTOMATIC_KINDS = new Set(["contact_notify", "contact_ack", "test"]);

/**
 * Message nodemailer d'une ligne de la file : texte brut UTF-8, un seul destinataire (enveloppe explicite, jamais
 * déduite d'un en-tête), adresses passées en objets (aucune analyse de liste d'adresses), objet sur une ligne.
 */
export function mailOptions(email: OutboxEmail, from: Mailbox): SendMailOptions {
  const to = (email.to_email || "").trim();
  if (!isMailAddress(to)) throw new PermanentEmailError("Adresse du destinataire invalide");
  const replyTo = (email.reply_to || "").trim();
  if (replyTo && !isMailAddress(replyTo)) throw new PermanentEmailError("Adresse de réponse invalide");
  const subject = headerText(email.subject || "");
  if (!subject) throw new PermanentEmailError("Objet vide");
  const text = email.body_text || "";
  if (!text.trim()) throw new PermanentEmailError("Message vide");
  return {
    from,
    to: { name: "", address: to },
    ...(replyTo ? { replyTo: { name: "", address: replyTo } } : {}),
    subject,
    text,
    envelope: { from: from.address, to: [to] },
    ...(AUTOMATIC_KINDS.has(email.kind) ? { headers: { "Auto-Submitted": "auto-generated" } } : {}),
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

/** Classement d'un échec d'envoi, repris par private.complete_email et par le point de santé. */
export type Classified = {
  /** true : jamais réessayé (status 'failed' aussitôt). */
  permanent: boolean;
  /** true : le serveur n'a pas pu servir du tout (connexion, TLS, identifiants, délai) → « smtpReady » à false. */
  smtpDown: boolean;
  /** Motif en français, sur une ligne, 500 caractères au plus (colonne last_error). */
  message: string;
};

const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
const cap = (s: string) => (s.length > 500 ? `${s.slice(0, 499)}…` : s);

/** Serveur injoignable ou connexion coupée (codes de nodemailer, puis erreurs réseau de Node). */
const UNREACHABLE_CODES = new Set([
  "ECONNECTION", "ESOCKET", "EDNS", "EPROTOCOL", "ECONFIG", "EPROXY",
  "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
]);

/**
 * Code SMTP 5xx → définitif ; 4xx, connexion refusée ou coupée, DNS, TLS, délai → réessai (délai croissant côté SQL).
 * Message refusé par nodemailer avant tout échange (enveloppe ou message invalide) → définitif.
 */
export function classifySmtpError(error: unknown): Classified {
  const e = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; responseCode?: unknown; message?: unknown };
  const detail = oneLine(typeof e.message === "string" && e.message ? e.message : String(error)) || "erreur inconnue";
  const code = typeof e.code === "string" ? e.code : "";
  const status = typeof e.responseCode === "number" ? e.responseCode : 0;
  const auth = code === "EAUTH" || code === "ENOAUTH";
  if (error instanceof PermanentEmailError) return { permanent: true, smtpDown: false, message: cap(detail) };
  if (status >= 500 && status <= 599) {
    return { permanent: true, smtpDown: auth, message: cap(`Refus définitif du serveur mail (${status}) : ${detail}`) };
  }
  if (status >= 400 && status <= 499) {
    return { permanent: false, smtpDown: auth, message: cap(`Refus temporaire du serveur mail (${status}) : ${detail}`) };
  }
  if (code === "EENVELOPE" || code === "EMESSAGE") {
    return { permanent: true, smtpDown: false, message: cap(`Message refusé avant l'envoi : ${detail}`) };
  }
  if (auth) return { permanent: false, smtpDown: true, message: cap(`Identifiants SMTP refusés : ${detail}`) };
  if (code === "ETLS") return { permanent: false, smtpDown: true, message: cap(`Échec du chiffrement avec le serveur mail : ${detail}`) };
  if (code === "ETIMEDOUT" || code === "ESENDTIMEOUT") {
    return { permanent: false, smtpDown: true, message: cap(`Délai dépassé avec le serveur mail : ${detail}`) };
  }
  if (UNREACHABLE_CODES.has(code)) return { permanent: false, smtpDown: true, message: cap(`Serveur mail injoignable : ${detail}`) };
  return { permanent: false, smtpDown: false, message: cap(`Échec de l'envoi : ${detail}`) };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SendTimeoutError(`aucune réponse en ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

export type SmtpSender = {
  /** Envoie une ligne de la file ; rejette avec l'erreur de nodemailer (à classer) ou PermanentEmailError. */
  send(email: OutboxEmail): Promise<void>;
  /** Connexion, EHLO, STARTTLS et identifiants s'il y a lieu, puis QUIT : serveur utilisable ? */
  verify(): Promise<void>;
  close(): void;
};

/** Transport nodemailer sans pool : une connexion par message (quelques e-mails par jour, jamais de connexion morte). */
export function createSmtpSender(settings: SmtpSettings, opts: { timeoutMs?: number } = {}): SmtpSender {
  const transporter = nodemailer.createTransport(settings.transport);
  const ms = opts.timeoutMs || SEND_TIMEOUT_MS;
  return {
    async send(email) {
      await withTimeout(transporter.sendMail(mailOptions(email, settings.from)), ms);
    },
    async verify() {
      await withTimeout(transporter.verify(), ms);
    },
    close() {
      transporter.close();
    },
  };
}
