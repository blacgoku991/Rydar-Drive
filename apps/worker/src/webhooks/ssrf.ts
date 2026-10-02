// Webhooks sortants : garde contre les requêtes vers le réseau interne (SSRF). L'URL est saisie par une centrale :
// sans contrôle, elle pourrait viser le worker lui-même, la base, Redis, les métadonnées du fournisseur cloud…
//  - https:// seulement, sans identifiants dans l'URL ; « localhost » refusé ;
//  - le nom est résolu ICI et TOUTES ses adresses doivent être publiques (une seule adresse interne = refus) : boucle
//    locale, réseaux privés (10/8, 172.16/12, 192.168/16), lien local (169.254/16, fe80::/10), CGNAT (100.64/10),
//    IPv6 unique-local (fc00::/7), multidiffusion, adresse non spécifiée, 0.0.0.0/8, et ces mêmes plages sous forme
//    IPv4 dans IPv6 (::ffff:a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16) ; plages réservées (documentation, essais,
//    240/4, Teredo…) refusées aussi ;
//  - la connexion part vers une adresse ainsi validée et vers aucune autre (pinnedLookup : aucune seconde résolution
//    DNS, donc pas de « DNS rebinding » entre le contrôle et la connexion) ; le certificat TLS reste vérifié pour le nom.
// Exception : WEBHOOK_ALLOW_PRIVATE_URLS=1 (tests, développement ; JAMAIS en production) accepte les adresses internes
// et http://.
import { promises as dns } from "node:dns";
import { isIP, type LookupFunction } from "node:net";

/** Catégorie d'une adresse non publique (null : adresse publique, joignable). */
export type AddressClass =
  | "loopback"
  | "private"
  | "link-local"
  | "cgnat"
  | "unique-local"
  | "site-local"
  | "multicast"
  | "unspecified"
  | "this-network"
  | "reserved"
  | "invalid";

/** Libellés (français) des refus, enregistrés dans last_error et visibles par la centrale. */
export const ADDRESS_CLASS_LABELS: Record<AddressClass, string> = {
  loopback: "boucle locale",
  private: "réseau privé",
  "link-local": "adresse de lien local",
  cgnat: "réseau partagé d'opérateur (CGNAT)",
  "unique-local": "réseau privé IPv6",
  "site-local": "réseau privé IPv6 (site local)",
  multicast: "multidiffusion",
  unspecified: "adresse non spécifiée",
  "this-network": "réseau 0.0.0.0/8",
  reserved: "plage réservée",
  invalid: "adresse invalide",
};

/** Refus d'une URL de webhook : message en français, sans adresse IP (rien sur la topologie du réseau interne). */
export class WebhookUrlError extends Error {
  constructor(message: string, public readonly reason: AddressClass | "url" | "dns" = "url") {
    super(message);
    this.name = "WebhookUrlError";
  }
}

/** WEBHOOK_ALLOW_PRIVATE_URLS=1 exactement (tests, développement) : adresses internes et http:// acceptées. */
export function webhookAllowPrivate(env: Record<string, string | undefined> = process.env): boolean {
  return (env.WEBHOOK_ALLOW_PRIVATE_URLS || "").trim() === "1";
}

// ----------------------------------------------------------------- IPv4

/** a.b.c.d décimal (forme canonique, celle de dns.lookup et de l'analyseur d'URL) → entier non signé, null sinon. */
function parseV4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

const V4_BLOCKS: [string, number, AddressClass][] = [
  ["0.0.0.0", 8, "this-network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "cgnat"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "reserved"], // affectations IETF (dont 192.0.0.170/171, découverte NAT64)
  ["192.0.2.0", 24, "reserved"], // documentation TEST-NET-1
  ["192.88.99.0", 24, "reserved"], // relais 6to4 (obsolète)
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "reserved"], // bancs d'essai
  ["198.51.100.0", 24, "reserved"], // documentation TEST-NET-2
  ["203.0.113.0", 24, "reserved"], // documentation TEST-NET-3
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"], // réservé, dont 255.255.255.255 (diffusion)
];
const V4_RANGES = V4_BLOCKS.map(([base, bits, cls]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (parseV4(base)! & mask) >>> 0, mask, cls };
});

function classifyV4Int(n: number): AddressClass | null {
  if (n === 0) return "unspecified";
  for (const r of V4_RANGES) if (((n & r.mask) >>> 0) === r.net) return r.cls;
  return null;
}

// ----------------------------------------------------------------- IPv6

/** Adresse IPv6 (zone « %eth0 » ignorée, IPv4 finale acceptée) → 8 groupes de 16 bits, null si invalide. */
function parseV6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (isIP(s) !== 6) return null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseV4(tail);
    if (v4 == null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string | undefined) => (part ? part.split(":").map((h) => parseInt(h, 16)) : []);
  const head = groups(halves[0]);
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = groups(halves[1]);
  const fill = 8 - head.length - rest.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

const embedded = (hi: number, lo: number) => ((hi << 16) | lo) >>> 0;
const zero = (g: number[], from: number, to: number) => g.slice(from, to).every((x) => x === 0);

function classifyV6Groups(g: number[]): AddressClass | null {
  if (zero(g, 0, 8)) return "unspecified";
  if (zero(g, 0, 7) && g[7] === 1) return "loopback";
  // IPv4 dans IPv6 : la connexion aboutit à l'adresse IPv4 portée → même verdict qu'elle
  if (zero(g, 0, 5) && g[5] === 0xffff) return classifyV4Int(embedded(g[6]!, g[7]!)); // ::ffff:a.b.c.d (mappée)
  if (zero(g, 0, 4) && g[4] === 0xffff && g[5] === 0) return classifyV4Int(embedded(g[6]!, g[7]!)); // ::ffff:0:a.b.c.d (traduite)
  if (zero(g, 0, 6)) return "reserved"; // ::a.b.c.d (compatible IPv4, obsolète)
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(g, 2, 6)) return classifyV4Int(embedded(g[6]!, g[7]!)); // NAT64 64:ff9b::/96
  if (g[0] === 0x2002) return classifyV4Int(embedded(g[1]!, g[2]!)); // 6to4 2002:a.b.c.d::/48
  if ((g[0]! & 0xfe00) === 0xfc00) return "unique-local"; // fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
  if ((g[0]! & 0xffc0) === 0xfec0) return "site-local"; // fec0::/10 (obsolète)
  if ((g[0]! & 0xff00) === 0xff00) return "multicast"; // ff00::/8
  if (g[0] === 0x2001 && g[1] === 0) return "reserved"; // Teredo 2001::/32 (IPv4 masquée dans l'adresse)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "reserved"; // documentation 2001:db8::/32
  if (g[0] === 0x3fff && (g[1]! & 0xf000) === 0) return "reserved"; // documentation 3fff::/20
  // Hors de 2000::/3 (seul espace unicast global attribué) : 64:ff9b:1::/48, 100::/64, ::/8 restant…
  if ((g[0]! & 0xe000) !== 0x2000) return "reserved";
  return null;
}

/** Catégorie d'une adresse IP (v4 ou v6) non publique ; null si elle est publique ; « invalid » si illisible. */
export function classifyAddress(ip: string): AddressClass | null {
  const s = ip.trim().replace(/^\[|\]$/g, "");
  const v4 = parseV4(s);
  if (v4 != null) return classifyV4Int(v4);
  const v6 = parseV6(s);
  return v6 ? classifyV6Groups(v6) : "invalid";
}

// ----------------------------------------------------------------- URL et résolution

export type PinnedAddress = { address: string; family: 4 | 6 };
/** Résolution d'un nom : toutes les adresses (A et AAAA), dans l'ordre du résolveur. */
export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export const systemResolver: Resolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

export type WebhookTarget = {
  url: URL;
  /** Nom (ou IP, sans crochets) : en-tête Host et nom vérifié par TLS. */
  hostname: string;
  port: number;
  /** Adresses validées : la connexion ne part que vers elles. */
  addresses: PinnedAddress[];
};

const DNS_ERRORS = new Set(["ENOTFOUND", "ENODATA", "EAI_NONAME", "EAI_NODATA", "EAI_FAIL"]);

/**
 * Valide l'URL d'un webhook puis résout son nom ; toute adresse non publique fait refuser l'URL entière (sauf
 * allowPrivate). Lève WebhookUrlError (message en français, enregistré tel quel dans last_error).
 */
export async function resolveWebhookTarget(rawUrl: string, opts: { allowPrivate: boolean; resolve?: Resolver }): Promise<WebhookTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookUrlError("URL invalide");
  }
  if (url.protocol !== "https:" && !(opts.allowPrivate && url.protocol === "http:")) {
    throw new WebhookUrlError("Seules les URL https:// sont acceptées");
  }
  if (url.username || url.password) throw new WebhookUrlError("Identifiants dans l'URL refusés");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
  if (!hostname) throw new WebhookUrlError("URL invalide");

  let found: { address: string; family: number }[];
  if (isIP(hostname)) {
    found = [{ address: hostname, family: isIP(hostname) }];
  } else {
    const bare = hostname.toLowerCase().replace(/\.+$/, "");
    if (!opts.allowPrivate && (bare === "localhost" || bare.endsWith(".localhost"))) {
      throw new WebhookUrlError(`Adresse refusée : ${ADDRESS_CLASS_LABELS.loopback} (seules les adresses publiques sont acceptées)`, "loopback");
    }
    try {
      found = await (opts.resolve ?? systemResolver)(hostname);
    } catch (error) {
      const code = String((error as { code?: unknown }).code ?? "");
      throw new WebhookUrlError(DNS_ERRORS.has(code) ? "Nom d'hôte introuvable (DNS)" : `Résolution DNS impossible${code ? ` (${code})` : ""}`, "dns");
    }
  }
  if (!found.length) throw new WebhookUrlError("Nom d'hôte introuvable (DNS)", "dns");

  const addresses: PinnedAddress[] = [];
  for (const a of found) {
    const cls = classifyAddress(a.address);
    if (cls && !(opts.allowPrivate && cls !== "invalid")) {
      throw new WebhookUrlError(`Adresse refusée : ${ADDRESS_CLASS_LABELS[cls]} (seules les adresses publiques sont acceptées)`, cls);
    }
    addresses.push({ address: a.address, family: isIP(a.address) === 6 ? 6 : 4 });
  }
  return { url, hostname, port, addresses };
}

/**
 * Fonction `lookup` de node:net / node:https qui ne résout rien : elle renvoie les adresses déjà validées (filtrées
 * par famille si demandé ; toutes si `all`, cas de l'autoSelectFamily de Node). Aucune autre adresse n'est joignable.
 */
export function pinnedLookup(addresses: PinnedAddress[]): LookupFunction {
  return ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const o = (typeof options === "object" && options ? options : {}) as { family?: number | string; all?: boolean };
    const fam = o.family === 4 || o.family === "IPv4" ? 4 : o.family === 6 || o.family === "IPv6" ? 6 : 0;
    const list = fam ? addresses.filter((a) => a.family === fam) : addresses;
    if (!list.length) {
      callback(Object.assign(new Error("Aucune adresse validée pour cette famille IP"), { code: "ENOTFOUND" }), o.all ? [] : undefined);
      return;
    }
    if (o.all) callback(null, list.map((a) => ({ address: a.address, family: a.family })));
    else callback(null, list[0]!.address, list[0]!.family);
  }) as LookupFunction;
}
