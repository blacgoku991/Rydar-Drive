// Outils de test de l'expéditeur d'e-mails (jamais importés par le code de production) : faux serveur SMTP minimal sur
// 127.0.0.1 (port aléatoire, sans TLS ni authentification) qui garde l'enveloppe et le message reçus de chaque
// session, et décodage MIME de ce qu'il reçoit (en-têtes RFC 2047, quoted-printable, base64).
import { createServer, type AddressInfo, type Socket } from "node:net";

export type SmtpSession = {
  ehlo: string | null;
  mailFrom: string | null;
  /** Destinataires acceptés (RCPT TO répondu 250). */
  rcptTo: string[];
  /** Message transmis après DATA (lignes jointes par CRLF, points de tête retirés), null si aucun. */
  data: string | null;
  commands: string[];
};

/**
 * Démarre le faux serveur (port aléatoire, ou `port` pour le relancer au même endroit). `rcpt` impose la réponse à
 * RCPT TO pour un destinataire (ex. « 550 5.1.1 … ») ; null : destinataire accepté.
 */
export async function startFakeSmtp(opts: { port?: number; rcpt?: (address: string) => string | null } = {}) {
  const sessions: SmtpSession[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const session: SmtpSession = { ehlo: null, mailFrom: null, rcptTo: [], data: null, commands: [] };
    sessions.push(session);
    let buffer = "";
    let dataLines: string[] | null = null;
    // latin1 : un octet = un caractère, rien n'est réinterprété
    socket.setEncoding("latin1");
    socket.write("220 fake.test ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf("\r\n"); i >= 0; i = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (dataLines) {
          if (line === ".") {
            session.data = dataLines.join("\r\n");
            dataLines = null;
            socket.write("250 2.0.0 Ok: queued as FAKE\r\n");
          } else {
            dataLines.push(line.startsWith(".") ? line.slice(1) : line);
          }
          continue;
        }
        session.commands.push(line);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO") {
          session.ehlo = line.slice(5).trim();
          socket.write(verb === "EHLO" ? "250-fake.test\r\n250 8BITMIME\r\n" : "250 fake.test\r\n");
        } else if (verb === "MAIL") {
          session.mailFrom = /<([^>]*)>/.exec(line)?.[1] ?? "";
          socket.write("250 2.1.0 Ok\r\n");
        } else if (verb === "RCPT") {
          const address = /<([^>]*)>/.exec(line)?.[1] ?? "";
          const reply = opts.rcpt?.(address) ?? null;
          if (reply) socket.write(`${reply}\r\n`);
          else {
            session.rcptTo.push(address);
            socket.write("250 2.1.5 Ok\r\n");
          }
        } else if (verb === "DATA") {
          dataLines = [];
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (verb === "RSET" || verb === "NOOP") {
          socket.write("250 2.0.0 Ok\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 2.0.0 Bye\r\n");
        } else {
          socket.write("502 5.5.2 Error: command not recognized\r\n");
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    sessions,
    /** Sessions qui ont transmis un message complet. */
    messages: () => sessions.filter((s) => s.data !== null),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Port où rien n'écoute (ouvert puis refermé) : connexion refusée. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** En-têtes (clés en minuscules, lignes repliées rejointes) et corps d'un message reçu. */
export function parseMessage(raw: string) {
  const split = raw.indexOf("\r\n\r\n");
  const head = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? "" : raw.slice(split + 4);
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function qWordBytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "_") bytes.push(0x20);
    else if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(c.charCodeAt(0));
  }
  return bytes;
}

/** Valeur d'en-tête décodée (mots encodés RFC 2047 en UTF-8, Q ou B ; espaces entre mots encodés ignorés). */
export function decodeHeader(value: string): string {
  const joined = value.replace(/\r\n[ \t]+/g, " ").replace(/\?=\s+=\?/g, "?==?");
  const re = /=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g;
  let out = "";
  let pending: number[] = [];
  let last = 0;
  const flush = () => {
    if (pending.length) out += Buffer.from(pending).toString("utf8");
    pending = [];
  };
  for (let m = re.exec(joined); m; m = re.exec(joined)) {
    if (m.index > last) {
      flush();
      out += joined.slice(last, m.index);
    }
    pending.push(...(m[2]!.toUpperCase() === "B" ? Buffer.from(m[3]!, "base64") : qWordBytes(m[3]!)));
    last = re.lastIndex;
  }
  flush();
  return out + joined.slice(last);
}

/** Corps décodé selon Content-Transfer-Encoding (quoted-printable, base64, 7bit / 8bit), en UTF-8. */
export function decodeBody(body: string, transferEncoding: string | undefined): string {
  const cte = (transferEncoding || "7bit").toLowerCase();
  if (cte === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (cte === "quoted-printable") {
    const soft = body.replace(/=\r\n/g, "");
    const bytes: number[] = [];
    for (let i = 0; i < soft.length; i++) {
      if (soft[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
        bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(soft.charCodeAt(i));
    }
    return Buffer.from(bytes).toString("utf8");
  }
  return Buffer.from(body, "latin1").toString("utf8");
}
