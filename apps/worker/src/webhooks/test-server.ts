// Serveur HTTP local des tests des webhooks (127.0.0.1, port libre) : enregistre chaque requête reçue.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Received = { method: string; url: string; headers: IncomingMessage["headers"]; body: string; at: number };

export async function startServer(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body, at: Date.now() });
      void handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: (path = "/hook") => `http://127.0.0.1:${port}${path}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
