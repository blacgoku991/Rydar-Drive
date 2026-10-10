// Flotte Privée : état du site du client relié par l'API v1 (« Mon site », Accueil, Premiers pas) — module pur, testé.
// Clés et webhooks gérés par l'équipe Rydar (D16) : lecture seule ici. Clé « navigateur » = clé avec des origines
// autorisées (allowed_origins) ; sinon clé « serveur ».

export type SiteKeyRow = {
  id: string;
  name: string;
  prefix: string;
  last4?: string | null;
  scopes: string[] | null;
  allowed_origins: string[] | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

export type SiteWebhookRow = {
  id: string;
  url: string;
  enabled: boolean;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error?: string | null;
};

export type SiteKeyKind = "browser" | "server";

export const SITE_KEY_KIND_LABELS: Record<SiteKeyKind, string> = {
  browser: "Clé navigateur",
  server: "Clé serveur",
};

export const siteKeyKind = (k: Pick<SiteKeyRow, "allowed_origins">): SiteKeyKind => ((k.allowed_origins ?? []).length ? "browser" : "server");

/** Clé utilisable maintenant : ni révoquée, ni expirée. */
export const siteKeyActive = (k: Pick<SiteKeyRow, "revoked_at" | "expires_at">, now = Date.now()) =>
  !k.revoked_at && (!k.expires_at || Date.parse(k.expires_at) > now);

/** « https://www.monsite.fr » → « monsite.fr » ; adresse illisible : null. */
export function siteHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export type SiteLink = {
  /** Au moins une clé active */
  linked: boolean;
  /** Nom du site (origine d'une clé navigateur, sinon adresse d'un webhook actif), si connu */
  host: string | null;
  activeKeys: SiteKeyRow[];
  /** Dernière utilisation d'une clé active */
  lastUsedAt: string | null;
};

export function siteLink(keys: readonly SiteKeyRow[], webhooks: readonly SiteWebhookRow[], now = Date.now()): SiteLink {
  const activeKeys = keys.filter((k) => siteKeyActive(k, now));
  const fromOrigins = activeKeys.flatMap((k) => k.allowed_origins ?? []).map(siteHost).find((h): h is string => !!h) ?? null;
  const fromWebhook = webhooks.filter((w) => w.enabled).map((w) => siteHost(w.url)).find((h): h is string => !!h) ?? null;
  const lastUsedAt =
    activeKeys
      .map((k) => k.last_used_at)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1) ?? null;
  return { linked: activeKeys.length > 0, host: activeKeys.length ? (fromOrigins ?? fromWebhook) : null, activeKeys, lastUsedAt };
}

/** Origines d'une clé navigateur, sans le protocole (« monsite.fr, www.monsite.fr »). */
export function originsLabel(origins: readonly string[] | null | undefined): string {
  return (origins ?? []).map((o) => o.replace(/^https?:\/\//, "")).join(", ");
}
