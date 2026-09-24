import "server-only";
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

/**
 * Fenêtre fixe (Redis si REDIS_URL, sinon mémoire du process — suffisant en dev,
 * à éviter en production multi-instances).
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<Result> {
  const now = Date.now();
  const bucket = Math.floor(now / (windowSec * 1000));
  const resetAt = (bucket + 1) * windowSec * 1000;
  const k = `rl:${key}:${bucket}`;
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
  if (memory.size > 50_000) {
    for (const [key2, v] of memory) if (v.resetAt < now) memory.delete(key2);
  }
  return { ok: count <= limit, remaining: Math.max(0, limit - count), resetAt, limit };
}

export async function resetRateLimit(key: string, windowSec: number) {
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const k = `rl:${key}:${bucket}`;
  memory.delete(k);
  const client = getRedis();
  if (client && client.status === "ready") await client.del(k).catch(() => undefined);
}
