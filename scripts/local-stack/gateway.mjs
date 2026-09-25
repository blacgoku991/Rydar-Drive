// Mini passerelle façon Kong : /rest/v1 → PostgREST, /auth/v1 → GoTrue, /realtime/v1 → relais local (+ CORS).
import http from "node:http";
import { createRealtime } from "./realtime.mjs";

const PORT = Number(process.env.GATEWAY_PORT ?? 54321);
const ROUTES = [
  { prefix: "/rest/v1", target: { host: "127.0.0.1", port: Number(process.env.POSTGREST_PORT ?? 54331) } },
  { prefix: "/auth/v1", target: { host: "127.0.0.1", port: Number(process.env.GOTRUE_PORT ?? 54332) } },
];

const CORS = {
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers":
    "authorization,apikey,content-type,x-client-info,prefer,range,accept-profile,content-profile,x-supabase-api-version,x-rydar-client",
  "access-control-expose-headers": "content-range,x-supabase-api-version",
  "access-control-max-age": "86400",
};

const realtime = createRealtime(process.env.DATABASE_URL ?? `postgresql://postgres:postgres@127.0.0.1:5432/${process.env.DB_NAME ?? "rydar"}`);

http
  .createServer((req, res) => {
    const origin = req.headers.origin;
    const cors = { ...CORS, "access-control-allow-origin": origin ?? "*", vary: "origin" };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }
    const route = ROUTES.find((r) => req.url.startsWith(r.prefix));
    if (!route) {
      res.writeHead(404, { ...cors, "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "not available in local stack" }));
    }
    const headers = { ...req.headers, host: `${route.target.host}:${route.target.port}` };
    // Comme Kong : sans session, la clé apikey sert de jeton
    if (!headers.authorization && headers.apikey) headers.authorization = `Bearer ${headers.apikey}`;
    const upstream = http.request(
      { ...route.target, method: req.method, path: req.url.slice(route.prefix.length) || "/", headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, { ...up.headers, ...cors });
        up.pipe(res);
      },
    );
    upstream.on("error", (e) => {
      res.writeHead(502, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ message: `upstream error: ${e.message}` }));
    });
    req.pipe(upstream);
  })
  .on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/realtime/v1/websocket")) realtime.handleUpgrade(req, socket, head);
    else socket.destroy();
  })
  .listen(PORT, "127.0.0.1", () => console.log(`gateway http://127.0.0.1:${PORT}`));
