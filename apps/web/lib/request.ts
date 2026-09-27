import "server-only";
import { headers } from "next/headers";

/**
 * Adresse IP du client. En production, Caddy (seul proxy devant le site) RÉÉCRIT X-Forwarded-For avec
 * l'IP réelle de la connexion et impose X-Real-IP (deploy/Caddyfile) : on lit donc X-Forwarded-For
 * en premier. CF-Connecting-IP n'est qu'un dernier recours (Caddy le retire) — un client ne doit pas
 * pouvoir choisir son IP pour contourner les limitations de débit.
 */
export function ipFromHeaders(h: Headers): string | null {
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip")?.trim() ||
    h.get("cf-connecting-ip")?.trim() ||
    null;
  return ip ? ip.slice(0, 64) : null;
}

/** Adresse IPv6 développée en 8 groupes de 4 chiffres hexadécimaux, null si invalide. */
function expandIpv6(ip: string): string[] | null {
  let s = ip;
  // IPv4 finale (::ffff:192.0.2.1) → deux groupes hexadécimaux
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((n) => n > 255)) return null;
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, "0"));
}

/**
 * Seau de limitation de débit d'une adresse : IPv4 inchangée, IPv6 regroupée par préfixe /64 (un abonné
 * reçoit en général tout un /64 : changer d'adresse à chaque requête ne doit pas contourner les limites).
 * IPv4 encapsulée (::ffff:a.b.c.d) → IPv4.
 */
export function ipBucket(ip: string | null | undefined): string {
  const raw = (ip ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
  if (!raw.includes(":")) return raw || "0.0.0.0";
  const g = expandIpv6(raw);
  if (!g) return raw;
  if (g.slice(0, 5).every((x) => x === "0000") && g[5] === "ffff") {
    const n = (x: string) => parseInt(x, 16);
    return [n(g[6]!) >> 8, n(g[6]!) & 255, n(g[7]!) >> 8, n(g[7]!) & 255].join(".");
  }
  return `${g.slice(0, 4).join(":")}::/64`;
}

export async function clientIp(): Promise<string> {
  return ipFromHeaders(await headers()) ?? "0.0.0.0";
}

export async function userAgent(): Promise<string> {
  return (await headers()).get("user-agent")?.slice(0, 300) ?? "";
}
