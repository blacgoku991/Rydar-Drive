// Super admin — Flotte Privée (docs/FLOTTE-PRIVEE.md § 8 et § 9.4) : règles pures de la fiche du client (limites
// effectives, préconditions indicatives du passage en Flotte Privée, clés du site et extrait d'intégration, passerelle
// depuis une demande de contact, textes du changement d'offre de service). Module neutre (ni « use client » ni
// « server-only ») : pages serveur, formulaires, actions serveur et tests (lib/private-fleet-admin.test.ts). La base
// reste seule juge (private.org_limits, private.private_fleet_blockers, svc_platform_*_private_fleet).
import {
  PRIVATE_FLEET_BLOCKERS, PRIVATE_FLEET_LIMITS, type PrivateFleetBlocker, type PrivateFleetSiteKeyKind, type PrivateFleetSwitchTarget, type Tone,
} from "@rydar/shared";

// -----------------------------------------------------------------------------
// Limites effectives (miroir de private.org_limits, 20260924007600)
// -----------------------------------------------------------------------------
/** Sans offre (plan_id null) : aucune limite, toutes les options (private.org_limits, 20260924002800). */
export const NO_PLAN_LIMITS: Readonly<Record<string, unknown>> = { api_access: true, booking_site: true, custom_domain: true, advanced_stats: true };

/**
 * Valeur d'une option lue comme la base : JSON vrai, ou texte « true », « t », « yes », « y », « on », « 1 » (même liste
 * que svc_platform_create_private_fleet pour api_access). Tout le reste (absent, faux, nombre) : non.
 */
export function limitEnabled(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return typeof value === "string" && ["true", "t", "yes", "y", "on", "1"].includes(value.trim().toLowerCase());
}

/**
 * Limites effectives d'une organisation : offre (sans offre : NO_PLAN_LIMITS), puis surcharge du super admin, puis, en
 * Flotte Privée, 1 chauffeur et 1 accès imposés APRÈS l'offre et la surcharge (ni l'une ni l'autre ne les lèvent).
 */
export function effectiveLimits(o: {
  planId: string | null;
  planLimits: Record<string, unknown> | null | undefined;
  override: Record<string, unknown> | null | undefined;
  privateFleet: boolean;
}): Record<string, unknown> {
  const base = o.planId == null ? NO_PLAN_LIMITS : (o.planLimits ?? {});
  return { ...base, ...(o.override ?? {}), ...(o.privateFleet ? PRIVATE_FLEET_LIMITS : {}) };
}

/** Accès à l'API effectif (le site du client réserve par l'API v1 : indispensable en Flotte Privée). */
export const apiAccessOf = (limits: Record<string, unknown>) => limitEnabled(limits.api_access);

// -----------------------------------------------------------------------------
// Préconditions du passage en Flotte Privée (miroir de private.private_fleet_blockers, à titre indicatif)
// -----------------------------------------------------------------------------
export type BlockersInput = {
  dispatchModel: string | null;
  members: { user_id: string; role: string; status: string }[];
  drivers: { user_id: string | null; status: string; application_status: string | null; deleted_at: string | null }[];
  network: {
    share_out: boolean;
    share_in: boolean;
    requested_at: string | null;
    approved_at: string | null;
    refused_reason: string | null;
  } | null;
  /** Courses partagées ouvertes ou acceptées (ride_network_shares de l'organisation) */
  openShares: number;
  /** Courses partenaires en cours d'exécution par l'organisation (ride_network_executions sans fin) */
  runningExecutions: number;
};

/**
 * Raisons qui empêchent le passage en Flotte Privée, dans l'ordre de PRIVATE_FLEET_BLOCKERS : modèle centrale ;
 * autre chose qu'un seul membre (propriétaire actif) ; plus d'une fiche non supprimée (candidatures comprises) ; aucune
 * fiche active sur le compte d'un propriétaire actif ; candidature en attente ; réseau partagé (partage, demande
 * d'adhésion en attente, course partagée ou exécutée en cours). Indicatif : la RPC fait foi (PRIVATE_FLEET_NOT_ELIGIBLE).
 */
export function privateFleetBlockersPreview(i: BlockersInput): PrivateFleetBlocker[] {
  const owners = new Set(i.members.filter((m) => m.status === "active" && m.role === "owner").map((m) => m.user_id));
  const alive = i.drivers.filter((d) => d.deleted_at == null);
  const n = i.network;
  const found: Record<PrivateFleetBlocker, boolean> = {
    model: i.dispatchModel !== "fleet",
    members: i.members.filter((m) => m.status !== "disabled").length !== 1 || owners.size === 0,
    drivers: alive.length > 1,
    owner_driver: !alive.some((d) => d.status === "active" && d.user_id != null && owners.has(d.user_id)),
    applications: alive.some((d) => d.application_status === "pending"),
    network:
      (!!n && (n.share_out || n.share_in || (n.requested_at != null && n.approved_at == null && n.refused_reason == null))) ||
      i.openShares > 0 ||
      i.runningExecutions > 0,
  };
  return PRIVATE_FLEET_BLOCKERS.filter((b) => found[b]);
}

// -----------------------------------------------------------------------------
// Fiche du gérant
// -----------------------------------------------------------------------------
export type OwnerDriverRow = { status: string; deleted_at: string | null; user_id: string | null } | null;

/** État de la fiche du gérant : celle qui reçoit les réservations du site. */
export function ownerDriverState(d: OwnerDriverRow): { label: string; tone: Tone; receives: boolean } {
  if (!d) return { label: "Aucune fiche", tone: "red", receives: false };
  if (d.deleted_at) return { label: "Supprimée (compte chauffeur supprimé)", tone: "red", receives: false };
  if (!d.user_id) return { label: "Sans compte", tone: "red", receives: false };
  if (d.status === "active") return { label: "Active", tone: "green", receives: true };
  if (d.status === "suspended") return { label: "Suspendue", tone: "red", receives: false };
  return { label: "Désactivée", tone: "amber", receives: false };
}

// -----------------------------------------------------------------------------
// Clé du site
// -----------------------------------------------------------------------------
/** Clé « navigateur » : origines autorisées (portées du navigateur seulement) ; sinon clé serveur. */
export const siteKeyKind = (allowedOrigins: readonly string[] | null | undefined): PrivateFleetSiteKeyKind =>
  allowedOrigins && allowedOrigins.length > 0 ? "browser" : "server";

export const SITE_KEY_KIND_META: Record<PrivateFleetSiteKeyKind, { label: string; description: string }> = {
  server: {
    label: "Clé serveur",
    description:
      "Recommandée : appelée par le serveur du site, jamais visible des visiteurs. Devis, réservations, suivi, annulation ; le site enregistre lui-même ses webhooks.",
  },
  browser: {
    label: "Clé navigateur",
    description:
      "Lisible par tout visiteur du site : devis et réservations seulement, depuis les adresses listées (avec leur variante www), avec des limites par adresse IP et par téléphone.",
  },
};

/** Débit d'une clé du site (requêtes par minute), comme une clé créée par défaut depuis le tableau de bord. */
export const SITE_KEY_RATE_LIMIT_PER_MINUTE = 60;

/** Trajet d'exemple (mêmes champs pour le devis et la réservation), indenté de `pad` espaces. */
const exampleTrip = (pad: string) =>
  [
    "{",
    `${pad}  "pickup":  { "address": "Gare de Lyon, 75012 Paris" },`,
    `${pad}  "dropoff": { "address": "Aéroport Paris-Orly" },`,
    `${pad}  "date": "2026-10-14", "time": "08:30",`,
    `${pad}  "passengers": 2, "luggage": 2, "vehicle_category": "business"`,
    `${pad}}`,
  ].join("\n");

/**
 * Extrait d'intégration affiché une seule fois avec la clé : serveur (variable d'environnement, devis, réservation au
 * prix affiché, webhooks) ou navigateur (devis puis réservation depuis l'origine autorisée).
 */
export function siteKeySnippet(o: { kind: PrivateFleetSiteKeyKind; apiBase: string; key: string; origin?: string | null }): string {
  if (o.kind === "server") {
    const trip = exampleTrip("  ");
    return `# Serveur du site : clé dans une variable d'environnement (jamais dans le code envoyé au navigateur)
RYDAR_API_KEY=${o.key}

# 1. Devis : prix à afficher au client (data.price_cents)
curl -X POST ${o.apiBase}/quotes \\
  -H "Authorization: Bearer $RYDAR_API_KEY" -H "Content-Type: application/json" \\
  -d '${trip}'

# 2. Réservation : mêmes champs de trajet + client + prix affiché (409 PRICE_CHANGED si le prix a changé)
curl -X POST ${o.apiBase}/rides \\
  -H "Authorization: Bearer $RYDAR_API_KEY" -H "Content-Type: application/json" \\
  -H "Idempotency-Key: <un UUID par réservation>" \\
  -d '{ …trajet du devis…, "customer": { "name": "…", "phone": "…" },
        "expected_price_cents": <price_cents du devis>, "external_reference": "<référence du site>" }'

# 3. Webhooks (ride.accepted, ride.no_driver_found, ride.cancelled…) : une seule fois
curl -X POST ${o.apiBase}/webhooks \\
  -H "Authorization: Bearer $RYDAR_API_KEY" -H "Content-Type: application/json" \\
  -d '{ "url": "https://<site du client>/api/rydar-webhook" }'`;
  }
  return `// Site du client (navigateur), depuis ${o.origin || "l'adresse autorisée"} : devis puis réservation
const RYDAR_KEY = "${o.key}"; // clé navigateur : devis et réservations seulement
const headers = { Authorization: \`Bearer \${RYDAR_KEY}\`, "Content-Type": "application/json" };
const trip = ${exampleTrip("")};

const quote = await (await fetch("${o.apiBase}/quotes", { method: "POST", headers, body: JSON.stringify(trip) })).json();
// Afficher quote.data.price_cents au client avant la commande (null : demande sans prix)

const res = await fetch("${o.apiBase}/rides", {
  method: "POST",
  headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify({
    ...trip,
    customer: { name: "…", phone: "…" },
    ...(quote.data.price_cents != null ? { expected_price_cents: quote.data.price_cents } : {}),
  }),
});
// 201 : « En attente de confirmation par votre chauffeur » ; 409 PRICE_CHANGED : nouveau prix à faire accepter ;
// toute autre erreur (402, 403, 429…) : « Appelez-nous »`;
}

// -----------------------------------------------------------------------------
// Passerelle depuis une demande de contact (sujet « eligibility »)
// -----------------------------------------------------------------------------
/** « Jean-Pierre de La Fontaine » → prénom « Jean-Pierre », nom « de La Fontaine » ; un seul mot : prénom seul. */
export function splitFullName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

/** Valeurs proposées au formulaire de création à partir d'une demande (nom découpé, e-mail, téléphone, entreprise). */
export type PrivateFleetPrefill = {
  name?: string;
  email?: string;
  phone?: string;
  ownerFirstName?: string;
  ownerLastName?: string;
  ownerEmail?: string;
  ownerPhone?: string;
};

export function prefillFromContact(c: { name: string; email: string; phone: string | null; company: string | null }): PrivateFleetPrefill {
  const { firstName, lastName } = splitFullName(c.name);
  return {
    name: c.company?.trim() || undefined,
    email: c.email,
    phone: c.phone ?? undefined,
    ownerFirstName: firstName || undefined,
    ownerLastName: lastName || undefined,
    ownerEmail: c.email,
    ownerPhone: c.phone ?? undefined,
  };
}

/** Ligne ajoutée à la note interne d'une demande (note existante gardée, coupée par le début si elle est trop longue). */
export function appendNote(existing: string | null | undefined, line: string, max: number): string {
  const before = (existing ?? "").trim();
  if (!before) return line.slice(0, max);
  const room = max - line.length - 2;
  if (room <= 0) return line.slice(0, max);
  return `${before.length > room ? before.slice(0, room) : before}\n\n${line}`;
}

// -----------------------------------------------------------------------------
// Changer d'offre de service (PackConversionDialog)
// -----------------------------------------------------------------------------
export const SWITCH_TARGET_META: Record<PrivateFleetSwitchTarget, { label: string; action: string }> = {
  private_fleet: { label: "Flotte Privée", action: "Passer en Flotte Privée" },
  fleet: { label: "Flotte standard", action: "Passer en flotte standard" },
  centrale: { label: "Centrale à commission", action: "Passer en centrale" },
};

/** « Ce qui change » / « Ce qui reste » d'un changement d'offre de service (docs/FLOTTE-PRIVEE.md § 9). */
export function conversionSummary(target: PrivateFleetSwitchTarget): { changes: string[]; keeps: string[] } {
  if (target === "private_fleet") {
    return {
      changes: [
        "Un seul chauffeur (le propriétaire, sur son compte) et un seul accès au tableau de bord, quelle que soit l'offre.",
        "Lien d'inscription /rejoindre fermé ; ni candidatures, ni réseau partagé, ni centrale.",
        "Chaque réservation lui est proposée « à confirmer », en ligne ou non, quelle que soit la distance (confirmation au plus tard 60 min avant la prise en charge, 5 min pour une réservation immédiate).",
        "Espace web épuré ; clés API et webhooks gérés par l'équipe Rydar depuis cette fiche.",
      ],
      keeps: [
        "Courses, clients, prix et grilles tarifaires.",
        "Fiche du gérant (niveau « Confirmé »), documents, clés API et webhooks : le site continue de réserver.",
        "Frais Rydar par course (inchangés : réglez-les ensuite), registre des frais, acceptations légales, abonnement.",
      ],
    };
  }
  const changes = [
    "Profil de dispatch standard : vagues GPS de 4 à 16 km, relance de 4 à 8 km, 30 s pour répondre.",
    "Limites de l'offre choisie (sans offre : aucune limite).",
    "Deviennent possibles : ajouter des chauffeurs, inviter des membres, ouvrir le lien /rejoindre, le réseau partagé (s'il est ouvert).",
    "Menu standard du tableau de bord ; l'application du chauffeur relit son état.",
  ];
  if (target === "centrale") {
    changes.push(
      "Centrale à commission : part chauffeur, commission et règlements pour les autres chauffeurs ; les courses non closes qui ont un prix sont réparties.",
      "Le gérant qui roule ne se doit jamais de commission : ses courses n'ouvrent aucun règlement.",
    );
  }
  return {
    changes,
    keeps: [
      "Courses, clients, prix et grilles tarifaires.",
      "Fiche du gérant (niveau « Confirmé »), documents, clés API et webhooks : le site continue de réserver.",
      "Registre des frais Rydar, acceptations légales, abonnement.",
    ],
  };
}
