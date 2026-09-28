import { ipBucket } from "@/lib/request";

/** Fenêtre de l'anti brute force de la connexion au tableau de bord (15 min). */
export const LOGIN_WINDOW = 15 * 60;

export const loginPairKey = (email: string, ip: string) => `loginip:${ipBucket(ip)}:${email}`;
export const loginEmailKey = (email: string) => `login:email:${email}`;

/**
 * Limites de la connexion au tableau de bord, vérifiées dans cet ordre : IP (IPv6 regroupée par /64), couple
 * (adresse, IP) strict, puis plafond global plus haut de l'adresse. Un tiers qui connaît l'adresse d'un gérant ne
 * bloque donc plus sa connexion depuis une autre IP (il lui faudrait une dizaine de sources pour atteindre le plafond).
 */
export function loginLimits(email: string, ip: string) {
  return [
    { key: `login:ip:${ipBucket(ip)}`, limit: 30, windowSec: LOGIN_WINDOW },
    { key: loginPairKey(email, ip), limit: 6, windowSec: LOGIN_WINDOW },
    { key: loginEmailKey(email), limit: 60, windowSec: LOGIN_WINDOW },
  ];
}
