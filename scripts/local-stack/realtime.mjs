// Realtime local (Broadcast « from database ») compatible supabase-js (protocole Phoenix vsn 2.0.0).
// Les messages écrits par realtime.send() dans realtime.messages sont relus AVEC le JWT de
// l'abonné (rôle authenticated + RLS rydar_realtime_receive) : mêmes droits qu'en production.
import { createHmac, timingSafeEqual } from "node:crypto";
import pg from "pg";
import { WebSocketServer } from "ws";
import { JWT_SECRET } from "./keys.mjs";

const POLL_MS = Number(process.env.REALTIME_POLL_MS ?? 150);

function verifyJwt(token) {
  const [head, body, sig] = String(token ?? "").split(".");
  if (!head || !body || !sig) return null;
  const expected = createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  if (claims.exp && claims.exp * 1000 < Date.now()) return null;
  return claims;
}

export function createRealtime(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const wss = new WebSocketServer({ noServer: true });
  /** @type {Set<{ ws: import("ws").WebSocket, topic: string, dbTopic: string, claims: object, cursor: number, joinRef: string }>} */
  const subs = new Set();
  let lastMax = 0;
  let busy = false;

  const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

  async function readAs(sub, fromId) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true), set_config('realtime.topic', $2, true)", [
        JSON.stringify(sub.claims),
        sub.dbTopic,
      ]);
      const { rows } = await client.query(
        "select id, event, payload from realtime.messages where topic = $1 and id > $2 and extension = 'broadcast' order by id limit 500",
        [sub.dbTopic, fromId],
      );
      await client.query("commit");
      return rows;
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** Évalue la policy RLS pour ce topic : sonde insérée puis relue en tant qu'abonné, transaction annulée. */
  async function canListen(dbTopic, claims) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query(
        "insert into realtime.messages (topic, extension, payload, event) values ($1, 'broadcast', '{}', 'probe') returning id",
        [dbTopic],
      );
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true), set_config('realtime.topic', $2, true)", [JSON.stringify(claims), dbTopic]);
      const res = await client.query("select exists (select 1 from realtime.messages where id = $1) as ok", [rows[0].id]);
      return res.rows[0].ok === true;
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  }

  async function tick() {
    if (busy || subs.size === 0) return;
    busy = true;
    try {
      const { rows } = await pool.query("select coalesce(max(id), 0)::bigint as max from realtime.messages");
      const max = Number(rows[0].max);
      if (max === lastMax) return;
      lastMax = max;
      for (const sub of subs) {
        if (sub.cursor >= max) continue;
        const msgs = await readAs(sub, sub.cursor).catch(() => []);
        sub.cursor = msgs.length ? Number(msgs.at(-1).id) : max;
        for (const m of msgs) send(sub.ws, [null, null, sub.topic, "broadcast", { type: "broadcast", event: m.event, payload: m.payload }]);
      }
    } catch (e) {
      console.error("[realtime]", e.message);
    } finally {
      busy = false;
    }
  }
  setInterval(tick, POLL_MS).unref();
  // Ménage : la table ne sert qu'au relais
  setInterval(() => pool.query("delete from realtime.messages where inserted_at < now() - interval '5 minutes'").catch(() => undefined), 60_000).unref();

  wss.on("connection", (ws) => {
    let token = null;
    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const [joinRef, ref, topic, event, payload] = msg;
      if (topic === "phoenix" && event === "heartbeat") return send(ws, [null, ref, "phoenix", "phx_reply", { status: "ok", response: {} }]);
      if (event === "access_token") {
        const claims = verifyJwt(payload?.access_token);
        if (claims) for (const s of subs) if (s.ws === ws && s.topic === topic) s.claims = claims;
        return;
      }
      if (event === "phx_leave") {
        for (const s of subs) if (s.ws === ws && s.topic === topic) subs.delete(s);
        return send(ws, [joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]);
      }
      if (event === "phx_join") {
        token = payload?.access_token ?? token;
        const claims = verifyJwt(token);
        if (!claims || claims.role !== "authenticated") {
          return send(ws, [joinRef, ref, topic, "phx_reply", { status: "error", response: { reason: "Unauthorized: invalid or missing access token" } }]);
        }
        const sub = { ws, topic, dbTopic: topic.replace(/^realtime:/, ""), claims, cursor: 0, joinRef };
        if (!(await canListen(sub.dbTopic, claims).catch(() => false))) {
          return send(ws, [joinRef, ref, topic, "phx_reply", { status: "error", response: { reason: "Unauthorized: You do not have permissions to read from this Channel topic" } }]);
        }
        try {
          const { rows } = await pool.query("select coalesce(max(id), 0)::bigint as max from realtime.messages");
          sub.cursor = Number(rows[0].max);
        } catch {
          /* base indisponible : on repartira de 0 */
        }
        subs.add(sub);
        return send(ws, [joinRef, ref, topic, "phx_reply", { status: "ok", response: { postgres_changes: [] } }]);
      }
      // broadcast client → serveur : non utilisé par Rydar (accusé simple)
      if (ref) send(ws, [joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]);
    });
    ws.on("close", () => {
      for (const s of subs) if (s.ws === ws) subs.delete(s);
    });
  });

  return {
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    },
  };
}
