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

export async function clientIp(): Promise<string> {
  return ipFromHeaders(await headers()) ?? "0.0.0.0";
}

export async function userAgent(): Promise<string> {
  return (await headers()).get("user-agent")?.slice(0, 300) ?? "";
}
