import "server-only";
import { createHash } from "node:crypto";
import Redis from "ioredis";
import { serverEnv } from "@/lib/env";

type Result = { ok: boolean; remaining: number; resetAt: number; limit: number };

let redis: Redis | null | undefined;
function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  const url = serverEnv().redisUrl;
  redis = url ? new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false }) : null;
  redis?.on("error", () => undefined);
  return redis;
}

const memory = new Map<string, { count: number; resetAt: number }>();
const MEMORY_MAX = 50_000;

/**
 * Clé de stockage de longueur fixe : préfixe lisible + empreinte de la clé complète. Une valeur géante
 * (adresse e-mail de plusieurs Mo, en-tête) ne peut ni gonfler Redis (éviction des autres compteurs)
 * ni la mémoire du process.
 */
function storageKey(key: string, bucket: number) {
  const sep = key.indexOf(":");
  const prefix = (sep > 0 ? key.slice(0, sep) : "k").slice(0, 24);
  return `rl:${prefix}:${createHash("sha256").update(key).digest("base64url").slice(0, 32)}:${bucket}`;
}

/**
 * Fenêtre fixe (Redis si REDIS_URL, sinon mémoire du process — suffisant en dev,
 * à éviter en production multi-instances).
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<Result> {
  const now = Date.now();
  const bucket = Math.floor(now / (windowSec * 1000));
  const resetAt = (bucket + 1) * windowSec * 1000;
  const k = storageKey(key, bucket);
  const client = getRedis();
  if (client && client.status === "ready") {
    try {
      const res = await client.multi().incr(k).pexpire(k, windowSec * 1000 + 1000).exec();
      const count = Number(res?.[0]?.[1] ?? 0);
      return { ok: count <= limit, remaining: Math.max(0, limit - count), resetAt, limit };
    } catch {
      // repli mémoire
    }
  }
  const entry = memory.get(k);
  const count = (entry?.count ?? 0) + 1;
  memory.set(k, { count, resetAt });
  if (memory.size > MEMORY_MAX) {
    for (const [key2, v] of memory) if (v.resetAt < now) memory.delete(key2);
    // Encore plein (rafale de clés distinctes) : les plus anciennes partent (ordre d'insertion)
    for (const key2 of memory.keys()) {
      if (memory.size <= MEMORY_MAX * 0.8) break;
      memory.delete(key2);
    }
  }
  return { ok: count <= limit, remaining: Math.max(0, limit - count), resetAt, limit };
}

/**
 * Plusieurs limites vérifiées DANS L'ORDRE (ex. IP puis compte) : on s'arrête à la première dépassée,
 * pour qu'une requête refusée pour son IP ne consomme pas le quota du compte visé.
 */
export async function rateLimitAll(checks: { key: string; limit: number; windowSec: number }[]): Promise<Result> {
  let last: Result = { ok: true, remaining: Infinity, resetAt: Date.now(), limit: Infinity };
  for (const c of checks) {
    last = await rateLimit(c.key, c.limit, c.windowSec);
    if (!last.ok) return last;
  }
  return last;
}

export async function resetRateLimit(key: string, windowSec: number) {
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const k = storageKey(key, bucket);
  memory.delete(k);
  const client = getRedis();
  if (client && client.status === "ready") await client.del(k).catch(() => undefined);
}
