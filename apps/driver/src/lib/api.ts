import type {
  ChatThreadKey, DocumentType, DriverAccountState, DriverAccountStateKind, DriverBlocker, DriverChatOverview, DriverDocumentItem,
  DriverDocuments, DriverEarnings, DriverHome, DriverOffer, DriverSettlements, FleetReportType, FleetReportVoteResult, MarkChatReadResult,
  Ride, RideStatus, RpcResult, SendChatMessageResult, SettlementMethod,
} from "@rydar/shared";
import { extractErrorCode, humanizeError } from "@rydar/shared";
import { appConfig } from "./config";
import { supabase } from "./supabase";

/** Erreur d'appel serveur : message FR prêt à afficher + code métier (ex. RATE_LIMITED). */
export class ApiError extends Error {
  code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.code = code;
  }
}

/**
 * Message lisible : code connu (@rydar/shared), sinon texte « CODE: texte » renvoyé par la base
 * (ex. « RATE_LIMITED: trop de signalements, patientez quelques minutes »), sinon repli.
 */
export function errorText(raw: string | null | undefined, fallback: string) {
  const known = humanizeError(raw, "");
  if (known) return known;
  const m = /^([A-Z][A-Z_]{3,}[A-Z]):\s*([\s\S]+)$/.exec((raw ?? "").trim());
  if (m?.[2]) {
    const t = m[2].trim();
    return `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?…]$/.test(t) ? "" : "."}`;
  }
  return fallback;
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args ?? {});
  if (error) throw new ApiError(errorText(error.message, "Connexion impossible. Réessayez."), extractErrorCode(error.message));
  return data as T;
}

/** Bucket privé des justificatifs ; chemin imposé <org>/<chauffeur>/<type>-<horodatage>.<ext> (politique storage). */
export const DOCUMENTS_BUCKET = "driver-documents";
export const STORAGE_UNAVAILABLE = "Envoi de fichiers indisponible sur ce serveur.";

export type SubmitDocumentResult = RpcResult & { replaced_id?: string | null; document?: DriverDocumentItem };

/** accept_ride_offer : DRIVER_BLOCKED (mode centrale) porte le motif du blocage. */
export type AcceptResult = RpcResult & { ride_id?: string; reason?: DriverBlocker };

/** driver_declare_payment : « J'ai payé » (à confirmer par la centrale). */
export type DeclarePaymentResult = RpcResult & { count?: number; amount_cents?: number };

/** Codes de refus de la route de connexion (403) — messages FR fournis par le serveur. */
export type LoginDeniedCode = "BANNED" | "REJECTED" | "INACTIVE" | "ORGANIZATION_SUSPENDED" | "NOT_DRIVER";

/** Connexion acceptée : chauffeur actif ou candidat en attente de validation (null : inconnu, relu ensuite). */
export type SignInResult = { state: DriverAccountStateKind | null };

const BANNED_MESSAGE = "Accès refusé : ce compte a été banni par la centrale.";

/** Connexion via l'API web (anti brute force, contrôle du compte), repli direct Supabase. */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  if (appConfig.apiUrl) {
    const res = await fetch(`${appConfig.apiUrl}/api/auth/driver-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    }).catch(() => null);
    if (!res) throw new ApiError("Réseau indisponible.", "NETWORK");
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string; refresh_token?: string; state?: DriverAccountStateKind; error?: string; code?: string;
    };
    if (!res.ok || !json.access_token || !json.refresh_token) {
      throw new ApiError(json.error ?? "Connexion impossible.", json.code ?? (res.status === 429 ? "RATE_LIMITED" : null));
    }
    const { error } = await supabase.auth.setSession({ access_token: json.access_token, refresh_token: json.refresh_token });
    if (error) throw new ApiError("Session invalide.", "SESSION");
    return { state: json.state ?? null };
  }
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  if (error) {
    // Compte Auth banni (bannissement répercuté sur Supabase Auth)
    if ((error as { code?: string }).code === "user_banned" || /banned/i.test(error.message)) throw new ApiError(BANNED_MESSAGE, "BANNED");
    throw new ApiError("E-mail ou mot de passe incorrect.", "INVALID_CREDENTIALS");
  }
  return { state: null };
}

export const api = {
  home: () => rpc<DriverHome>("driver_home"),
  offers: () => rpc<DriverOffer[]>("driver_offers"),
  setOnline: (online: boolean) => rpc<RpcResult & { presence: string }>("driver_set_online", { p_online: online }),
  accept: (offerId: string) => rpc<AcceptResult>("accept_ride_offer", { p_offer_id: offerId }),
  decline: (offerId: string) => rpc<RpcResult>("decline_ride_offer", { p_offer_id: offerId }),
  updateStatus: (rideId: string, status: RideStatus) => rpc<RpcResult>("driver_update_ride_status", { p_ride_id: rideId, p_status: status }),
  location: (p: { lat: number; lng: number; heading?: number | null; speed?: number | null; accuracy?: number | null; battery?: number | null; recordedAt?: string }) =>
    rpc<{ ok: boolean; next_interval_s: number; presence: string }>("update_driver_location", {
      p_lat: p.lat,
      p_lng: p.lng,
      p_heading: p.heading ?? null,
      p_speed: p.speed ?? null,
      p_accuracy: p.accuracy ?? null,
      p_battery: p.battery ?? null,
      p_recorded_at: p.recordedAt ?? null,
    }),
  registerDevice: (p: { installationId: string; platform: "ios" | "android"; token?: string | null; provider?: "expo" | "fcm" | "apns"; deviceName?: string | null; osVersion?: string | null; appVersion?: string | null }) =>
    rpc<RpcResult>("driver_register_device", {
      p_installation_id: p.installationId,
      p_platform: p.platform,
      p_push_token: p.token ?? null,
      p_provider: p.provider ?? "expo",
      p_device_name: p.deviceName ?? null,
      p_os_version: p.osVersion ?? null,
      p_app_version: p.appVersion ?? null,
    }),
  unregisterToken: (token: string) => rpc<RpcResult>("driver_unregister_push_token", { p_token: token }),
  /** Courses du chauffeur (RLS : uniquement les siennes, coordonnées client incluses). */
  ride: async (id: string) => {
    const { data, error } = await supabase.from("rides").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error("Course indisponible.");
    return data as Ride | null;
  },
  // --- Messagerie + signalements (migration 002300) ------------------------------------------
  chatOverview: () => rpc<DriverChatOverview>("driver_chat_overview"),
  /** Message « Centrale » (fil direct) ou « Flotte » ; signalement = fil flotte + type (+ position, sinon dernière connue). */
  sendMessage: (p: { channel: "driver" | "fleet"; body?: string; reportType?: FleetReportType | null; lat?: number | null; lng?: number | null }) =>
    rpc<SendChatMessageResult>("send_chat_message", {
      p_org: null,
      p_channel: p.channel,
      p_driver_id: null,
      p_body: p.body ?? "",
      p_report_type: p.reportType ?? null,
      p_lat: p.lat ?? null,
      p_lng: p.lng ?? null,
    }),
  markRead: (thread: ChatThreadKey) => rpc<MarkChatReadResult>("mark_chat_read", { p_org: null, p_thread: thread }),
  voteReport: (id: string, stillThere: boolean) => rpc<FleetReportVoteResult>("vote_fleet_report", { p_message_id: id, p_still_there: stillThere }),
  // --- Gains + documents (migration 002400) ----------------------------------------------------
  earnings: (days = 7) => rpc<DriverEarnings>("driver_earnings", { p_days: days }),
  documents: () => rpc<DriverDocuments>("driver_documents"),
  submitDocument: (p: { type: DocumentType; filePath: string; expiresAt?: string | null; number?: string | null }) =>
    rpc<SubmitDocumentResult>("driver_submit_document", {
      p_type: p.type,
      p_number: p.number ?? null,
      p_expires_at: p.expiresAt ?? null,
      p_file_path: p.filePath,
      p_issued_at: null,
      p_label: null,
    }),
  /** Dépôt du fichier dans le stockage (INSERT seul : pas d'écrasement d'un justificatif). */
  uploadDocument: async (path: string, body: ArrayBuffer, contentType: string) => {
    const res = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .upload(path, body, { contentType, upsert: false })
      .catch((e: unknown) => ({ data: null, error: e }));
    if (!res.error) return;
    const e = res.error as { message?: string; status?: number | string; statusCode?: number | string; name?: string };
    const status = Number(e.status ?? e.statusCode ?? 0);
    const msg = String(e.message ?? "");
    // Pas de service Storage (stack locale), bucket absent, réponse non JSON ou réseau coupé vers /storage
    if (
      status === 404 || status === 502 || status === 503 || e.name === "StorageUnknownError" ||
      /not found|failed to fetch|network|bucket|unexpected token|json/i.test(msg)
    ) throw new ApiError(STORAGE_UNAVAILABLE, "STORAGE_UNAVAILABLE");
    if (status === 413 || /too large|payload/i.test(msg)) throw new ApiError("Fichier trop lourd : reprenez la photo.", "FILE_TOO_LARGE");
    if (status === 401 || status === 403 || /row-level security|unauthorized/i.test(msg)) throw new ApiError("Envoi refusé par le serveur.", "FORBIDDEN");
    throw new ApiError("Envoi du fichier impossible. Réessayez.", "UPLOAD_FAILED");
  },
  // --- Mode centrale (migration 002600) -------------------------------------------------------
  /** État du compte (actif, candidature en attente, refusé, banni, suspendu…) — fonctionne même compte non actif. */
  accountState: () => rpc<DriverAccountState>("driver_account_state"),
  /** Commissions à régler / gains à recevoir + de quoi payer (lien prérempli, moyens acceptés, référence). */
  settlements: (limit = 50) => rpc<DriverSettlements>("driver_settlements", { p_limit: limit }),
  /** « J'ai payé » : règlements signalés payés (lien, espèces ou virement), à confirmer par la centrale. */
  declarePayment: (ids: string[], method: SettlementMethod, note?: string | null) =>
    rpc<DeclarePaymentResult>("driver_declare_payment", { p_ids: ids, p_method: method, p_note: note?.trim() || null }),
  /**
   * Fiche chauffeur du compte connecté (RLS drivers_select : user_id = auth.uid()). Sert au candidat en
   * attente : driver_home lui est refusé et driver_account_state ne renvoie pas l'id de l'organisation,
   * indispensable au chemin de stockage des justificatifs (<org>/<chauffeur>/…).
   */
  myDriverRow: async (userId: string) => {
    const { data, error } = await supabase.from("drivers").select("id, organization_id").eq("user_id", userId).maybeSingle();
    if (error) throw new ApiError("Connexion impossible. Réessayez.", null);
    return data as { id: string; organization_id: string } | null;
  },
  upcoming: async () => {
    const { data } = await supabase
      .from("rides")
      .select("*")
      .in("status", ["ACCEPTED", "DRIVER_EN_ROUTE", "DRIVER_ARRIVED", "PASSENGER_ONBOARD", "IN_PROGRESS"])
      .order("pickup_at", { ascending: true })
      .limit(50);
    return (data ?? []) as Ride[];
  },
};

/** Centrale derrière un lien d'inscription (GET /api/join/{code}). */
export type JoinCentrale = {
  autoApprove: boolean;
  organization: { name: string; logoUrl: string | null; brandColor: string | null; city: string | null; phone: string | null };
};

/** Formulaire d'inscription par lien (mêmes champs que la page web, validés par le serveur). */
export type JoinInput = {
  firstName: string; lastName: string; phone: string; email: string; password: string; vtcCardNumber?: string;
  vehicle: { brand?: string; model: string; color?: string; plate: string; category: string; seats: number; luggageCapacity: number };
  acceptTerms: boolean;
};

export type JoinResponse =
  | { ok: true; status: "PENDING" | "APPROVED"; organizationName: string; email: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

function joinUrl(code: string) {
  if (!appConfig.apiUrl) throw new ApiError("Inscription indisponible : serveur non configuré.", "CONFIG");
  return `${appConfig.apiUrl}/api/join/${encodeURIComponent(code.trim().toLowerCase())}`;
}

export async function fetchJoinCentrale(code: string): Promise<JoinCentrale> {
  const res = await fetch(joinUrl(code)).catch(() => null);
  if (!res) throw new ApiError("Réseau indisponible.", "NETWORK");
  const json = (await res.json().catch(() => ({}))) as Partial<JoinCentrale> & { ok?: boolean; error?: string };
  if (!res.ok || !json.ok || !json.organization) throw new ApiError(json.error ?? "Lien d'inscription invalide.", "JOIN_LINK_INVALID");
  return { autoApprove: !!json.autoApprove, organization: json.organization };
}

export async function joinCentrale(code: string, input: JoinInput): Promise<JoinResponse> {
  const res = await fetch(joinUrl(code), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).catch(() => null);
  if (!res) return { ok: false, error: "Réseau indisponible." };
  return ((await res.json().catch(() => null)) as JoinResponse | null) ?? { ok: false, error: "Inscription impossible pour le moment. Réessayez." };
}

/** Code d'inscription tiré d'un lien collé (https://…/rejoindre/{code}) ou du code seul. */
export function parseJoinCode(text: string): string | null {
  const t = text.trim().toLowerCase();
  const m = /rejoindre\/([a-z0-9]{10,32})/.exec(t) ?? /^([a-z0-9]{10,32})$/.exec(t);
  return m?.[1] ?? null;
}
