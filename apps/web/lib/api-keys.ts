import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Format : rdk_{env}_{prefix8}_{secret32}  — ex. rdk_live_k3d9x2ma_7GQ…
// Seuls le préfixe (identification) et un HMAC-SHA256 poivré sont stockés.
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const KEY_RE = /^rdk_(live|test)_([a-z0-9]{8})_([A-Za-z0-9]{32})$/;

function randomString(length: number, alphabet = ALPHABET): string {
  const bytes = randomBytes(length * 2);
  let out = "";
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b < 256 - (256 % alphabet.length)) out += alphabet[b % alphabet.length];
  }
  return out.length === length ? out : randomString(length, alphabet);
}

export function generateApiKey(environment: "live" | "test" = "live") {
  const prefixId = randomString(8, "abcdefghijkmnopqrstuvwxyz23456789");
  const secret = randomString(32);
  const key = `rdk_${environment}_${prefixId}_${secret}`;
  return { key, prefix: `rdk_${environment}_${prefixId}`, last4: secret.slice(-4) };
}

export function hashApiKey(key: string, pepper: string): string {
  if (!pepper || pepper.length < 16) throw new Error("API_KEY_PEPPER absent ou trop court");
  return createHmac("sha256", pepper).update(key).digest("hex");
}

export function parseApiKey(raw: string | null | undefined): { key: string; prefix: string } | null {
  if (!raw) return null;
  const key = raw.trim();
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return { key, prefix: `rdk_${m[1]}_${m[2]}` };
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Extrait la clé de `Authorization: Bearer …` ou `X-API-Key`. */
export function extractApiKey(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return headers.get("x-api-key");
}
