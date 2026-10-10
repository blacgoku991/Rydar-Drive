// Lexique de l'interface (docs/REFONTE-PANELS.md § 4) : un mot par chose, partout. Libellés et tons des codes écrits
// en base (statuts, erreurs d'envoi, gravités, actions de l'audit) : le code reste en base et, s'il aide le support,
// dans un détail replié ; il n'est jamais le texte principal à l'écran. Un code inconnu reçoit toujours un libellé
// lisible, jamais une exception. Module pur : ni « use client » ni « server-only » (testé : wording.test.ts).
import { formatNumber, type DispatchModel, type Tone } from "@rydar/shared";

/** Libellé et ton (couleur de la pastille, jetons de `components/ui/badge`). */
export type Labelled = { label: string; tone: Tone };

/** Première lettre en majuscule (« votre flotte » → « Votre flotte »). */
export function upperFirst(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * Nombre entier et nom accordé : « 0 course », « 1 course », « 3 courses » (0 et 1 au singulier, règle française),
 * nombre au format français (« 1 000 »). `many` : pluriel irrégulier ou expression (« courses sans chauffeur »).
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${Math.abs(n) >= 2 ? many : one}`;
}

// ----------------------------------------------------------------------------------------------- Flotte ou centrale

export type OrgWords = {
  /** « flotte » / « centrale » */
  noun: string;
  /** « votre flotte » / « votre centrale » */
  your: string;
  /** « la flotte » / « la centrale » */
  the: string;
  /** « de votre flotte » / « de votre centrale » */
  ofYour: string;
  /** « de la flotte » / « de la centrale » */
  ofThe: string;
  /** « à votre flotte » / « à votre centrale » */
  toYour: string;
};

const FLEET_WORDS: OrgWords = {
  noun: "flotte",
  your: "votre flotte",
  the: "la flotte",
  ofYour: "de votre flotte",
  ofThe: "de la flotte",
  toYour: "à votre flotte",
};
const CENTRALE_WORDS: OrgWords = {
  noun: "centrale",
  your: "votre centrale",
  the: "la centrale",
  ofYour: "de votre centrale",
  ofThe: "de la centrale",
  toYour: "à votre centrale",
};

/**
 * Mots de l'organisation selon son modèle : jamais « votre centrale » chez une flotte. Modèle absent ou inconnu
 * (Flotte Privée comprise, qui est une flotte) : « flotte ».
 */
export function orgWords(model: DispatchModel | string | null | undefined): OrgWords {
  return model === "centrale" ? CENTRALE_WORDS : FLEET_WORDS;
}

// ------------------------------------------------------------------------------------------ Notifications (téléphone)

export const NOTIFICATION_STATUS: Record<"queued" | "sending" | "sent" | "failed" | "cancelled", Labelled> = {
  sent: { label: "Envoyée", tone: "green" },
  queued: { label: "En file", tone: "amber" },
  sending: { label: "Envoi en cours", tone: "amber" },
  failed: { label: "Échec", tone: "red" },
  cancelled: { label: "Annulée", tone: "neutral" },
};

/** Statut d'une notification (public.notification_status) ; inconnu : « Statut inconnu ». */
export function notificationStatus(code: string | null | undefined): Labelled {
  return lookup(NOTIFICATION_STATUS, code) ?? { label: "Statut inconnu", tone: "neutral" };
}

const UNINSTALLED = "Application désinstallée ou notifications désactivées sur le téléphone";
const MISCONFIGURED = "Service d'envoi mal configuré sur le serveur (à signaler à l'équipe technique)";
const TOO_MANY = "Trop de notifications envoyées à ce téléphone\u00a0: nouvel essai automatique";
const TOO_SLOW = "Service d'envoi trop lent\u00a0: nouvel essai automatique";
const UNAVAILABLE = "Service d'envoi momentanément indisponible";
const INCOMPLETE = "Réponse incomplète du service d'envoi";

/**
 * Codes écrits dans notifications.last_error par le worker (apps/worker/src/notifications.ts et push/ : Expo, FCM,
 * APNs) et par les accusés de réception Expo. Le message brut qui suit le code (« CODE: détail ») n'est jamais affiché.
 */
export const NOTIFICATION_ERRORS: Record<string, string> = {
  // Aucun appareil enregistré pour le chauffeur (worker : complete_notification … 'NO_PUSH_TOKEN')
  NO_PUSH_TOKEN: "Application jamais ouverte ou notifications refusées",
  // Jeton mort : application désinstallée, notifications coupées (Expo, FCM, APNs)
  DeviceNotRegistered: UNINSTALLED,
  UNREGISTERED: UNINSTALLED,
  NOT_FOUND: UNINSTALLED,
  Unregistered: UNINSTALLED,
  BadDeviceToken: UNINSTALLED,
  InvalidExpoToken: "Téléphone non reconnu\u00a0: le chauffeur doit rouvrir l'application",
  // Message refusé
  MessageTooBig: "Message trop long pour une notification",
  INVALID_ARGUMENT: "Notification refusée par le service d'envoi",
  PayloadTooLarge: "Message trop long pour une notification",
  // Débit
  MessageRateExceeded: TOO_MANY,
  QUOTA_EXCEEDED: TOO_MANY,
  TooManyRequests: TOO_MANY,
  HTTP_429: TOO_MANY,
  // Configuration du serveur (identifiants Expo, Firebase ou Apple)
  InvalidCredentials: MISCONFIGURED,
  MismatchSenderId: MISCONFIGURED,
  SENDER_ID_MISMATCH: MISCONFIGURED,
  THIRD_PARTY_AUTH_ERROR: MISCONFIGURED,
  PERMISSION_DENIED: MISCONFIGURED,
  UNAUTHENTICATED: MISCONFIGURED,
  APNS_AUTH: MISCONFIGURED,
  DeviceTokenNotForTopic: MISCONFIGURED,
  BadTopic: MISCONFIGURED,
  InvalidProviderToken: MISCONFIGURED,
  ExpiredProviderToken: MISCONFIGURED,
  // Délais et disponibilité
  PUSH_TIMEOUT: TOO_SLOW,
  EXPO_TIMEOUT: TOO_SLOW,
  APNS_TIMEOUT: TOO_SLOW,
  EXPO_NETWORK: UNAVAILABLE,
  UNAVAILABLE: UNAVAILABLE,
  INTERNAL: UNAVAILABLE,
  ServiceUnavailable: UNAVAILABLE,
  InternalServerError: UNAVAILABLE,
  EXPO_BAD_RESPONSE: INCOMPLETE,
  NO_RESULT: INCOMPLETE,
  ExpoError: INCOMPLETE,
  // Annulées avant l'envoi par le ménage (statut « cancelled », migrations) : proposition déjà close (prise, refusée,
  // expirée ou annulée), réveil de position périmé
  offer_closed: "Proposition close avant l'envoi",
  wake_expired: "Demande de position expirée avant l'envoi",
};

/** Code d'une erreur brute : « DeviceNotRegistered: … », « PUSH_TIMEOUT: expo (20000 ms) », « NOT_FOUND/UNREGISTERED: … ». */
function notificationErrorCodes(raw: string): string[] {
  // Plusieurs appareils : erreurs jointes par « | » ; la première décide
  const first = raw.split("|")[0]!.trim();
  const code = /^[A-Za-z0-9_/]+/.exec(first)?.[0] ?? "";
  return code.split("/").filter(Boolean);
}

/**
 * Erreur d'envoi d'une notification en mots simples (notifications.last_error) ; aucune erreur : null ; code inconnu :
 * « Échec de l'envoi » (le code brut reste lisible dans le détail replié de l'écran qui l'affiche).
 */
export function notificationErrorLabel(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const codes = notificationErrorCodes(raw);
  // FCM « statut/code » : le code le plus précis (dernier) d'abord
  for (const code of [...codes].reverse()) {
    const known = has(NOTIFICATION_ERRORS, code) ? NOTIFICATION_ERRORS[code] : undefined;
    if (known) return known;
    if (/^PROVIDER_[A-Z]+_NOT_CONFIGURED$/.test(code) || /^FCM_OAUTH_/.test(code)) return MISCONFIGURED;
    if (/^HTTP_5\d\d$/.test(code)) return UNAVAILABLE;
  }
  return "Échec de l'envoi";
}

// -------------------------------------------------------------------------------------------------- Audit (super admin)

export const AUDIT_SEVERITY: Record<"info" | "warning" | "critical", Labelled> = {
  info: { label: "Info", tone: "neutral" },
  warning: { label: "Attention", tone: "amber" },
  critical: { label: "Critique", tone: "red" },
};

/** Gravité d'une ligne d'audit (audit_logs.severity) ; inconnue : traitée comme « Info ». */
export function auditSeverity(code: string | null | undefined): Labelled {
  return lookup(AUDIT_SEVERITY, code) ?? AUDIT_SEVERITY.info;
}

/** Auteur d'une ligne d'audit (public.actor_type). */
export const AUDIT_ACTOR: Record<"super_admin" | "system" | "user" | "driver" | "api" | "booking_site", string> = {
  super_admin: "Super admin",
  system: "Système",
  user: "Utilisateur",
  driver: "Chauffeur",
  api: "Site du client",
  booking_site: "Mini-site",
};

export function auditActorLabel(code: string | null | undefined): string {
  return lookup(AUDIT_ACTOR, code) ?? "Autre";
}

/**
 * Actions de l'audit écrites par apps/web (lib/audit.ts, routes de l'API) et par les migrations (première table,
 * complétée en R6). Les modifications enregistrées par le déclencheur générique (« table.insert / update / delete »,
 * private.audit_row_change) passent par AUDIT_ENTITIES.
 */
export const AUDIT_ACTIONS: Record<string, string> = {
  // Clés de connexion (API & site web, clé du site Flotte Privée)
  "api_key.created": "Clé de connexion créée",
  "api_key.revoked": "Clé de connexion révoquée",
  "api_key.rotated": "Clé de connexion remplacée",
  "webhook.created": "Webhook ajouté",
  // Abonnement
  "billing.checkout_started": "Paiement de l'abonnement commencé",
  "billing.plan_downgraded": "Offre réduite",
  "billing.subscription_ended": "Abonnement terminé",
  // Mini-site
  "booking_site.domain_verified": "Domaine du mini-site vérifié",
  // Demandes de contact
  "contact_request.updated": "Demande de contact mise à jour",
  "contact_request.replied": "Réponse à une demande de contact",
  "contact_request.deleted": "Demande de contact supprimée",
  // E-mails
  "email.requeue": "E-mails remis en file d'envoi",
  "email.retry": "Nouvel essai d'envoi d'un e-mail",
  "email.test_sent": "E-mail de test envoyé",
  // Messagerie
  "chat.message_removed": "Message retiré (modération)",
  "chat.report_dismissed": "Message signalé classé sans suite",
  // Chauffeurs
  "driver.account_created": "Compte chauffeur créé",
  "driver.account_locked": "Connexion du chauffeur bloquée",
  "driver.active": "Chauffeur activé",
  "driver.inactive": "Chauffeur désactivé",
  "driver.suspended": "Chauffeur suspendu",
  "driver.applied": "Candidature reçue",
  "driver.application_approved": "Candidature acceptée",
  "driver.application_rejected": "Candidature refusée",
  "driver.join_link_signup": "Inscription par le lien d'inscription",
  "driver.join_refused": "Inscription refusée",
  "driver.password_reset": "Mot de passe du chauffeur réinitialisé",
  "driver.sessions_revoked": "Chauffeur déconnecté de ses appareils",
  "driver.trust_level_changed": "Niveau de confiance du chauffeur modifié",
  "driver.banned": "Chauffeur banni",
  "driver.banned_device": "Appareil d'un chauffeur banni",
  "driver.banned_identity": "Identité d'un chauffeur bannie",
  "driver.ban_lifted": "Bannissement levé",
  "driver.platform_banned": "Chauffeur banni de toute la plateforme",
  "driver.platform_unbanned": "Bannissement de la plateforme levé",
  "driver.platform_ban_kept": "Bannissement de la plateforme maintenu",
  "driver.deletion_requested": "Suppression d'un compte chauffeur demandée",
  "driver.deleted": "Compte chauffeur supprimé",
  "driver.deletion_failed": "Échec de la suppression d'un compte chauffeur",
  "driver.deletion_retry": "Nouvel essai de suppression d'un compte chauffeur",
  "driver.lookup": "Recherche d'un chauffeur (suppressions de comptes)",
  "driver.network_consent": "Accord du chauffeur pour le réseau partagé",
  "driver.payout_details_updated": "Coordonnées de paiement du chauffeur modifiées",
  "driver.payout_details_deleted": "Coordonnées de paiement du chauffeur supprimées",
  "driver.private_fleet_attached": "Fiche chauffeur rattachée à la Flotte Privée",
  "driver_documents.number_set": "Numéro d'un document enregistré",
  "identity_ban.lifted": "Identité débloquée",
  // Signalements de fraude
  "fraud_report.platform_banned": "Signalement\u00a0: chauffeur banni de la plateforme",
  "fraud_report.platform_ban_lifted": "Signalement\u00a0: bannissement de la plateforme levé",
  "fraud_report.dismissed": "Signalement classé sans suite",
  // Équipe
  "member.added": "Membre ajouté",
  "member.invited": "Membre invité",
  "member.invitation_resent": "Invitation renvoyée",
  "member.invitation_cancelled": "Invitation annulée",
  "member.invitation_accepted": "Invitation acceptée",
  "member.updated": "Membre modifié",
  "member.login_unlocked": "Connexion d'un membre débloquée",
  // Clients
  "organization.created": "Client créé",
  "organization.plan_changed": "Offre du client modifiée",
  "organization.auth_unbanned": "Connexions débloquées après réactivation",
  "organization.dispatch_model_changed": "Modèle d'exploitation changé",
  "organization.join_link": "Lien d'inscription modifié",
  "organization.platform_fee_changed": "Frais Rydar modifiés",
  "organization.platform_fee_scheduled": "Hausse des frais Rydar programmée",
  "organization.platform_fee_schedule_cancelled": "Hausse des frais Rydar annulée",
  "organization.private_fleet_created": "Client Flotte Privée créé",
  "organization.private_fleet_enabled": "Passage en Flotte Privée",
  "organization.private_fleet_disabled": "Sortie de la Flotte Privée",
  "organization.terms_notice_sent": "Annonce des nouvelles conditions envoyée",
  // Plateforme
  "platform.booking_sites_enabled": "Mini-sites ouverts",
  "platform.booking_sites_disabled": "Mini-sites coupés",
  "platform.shared_network_enabled": "Réseau partagé ouvert",
  "platform.shared_network_disabled": "Réseau partagé fermé",
  "platform_billing.updated": "Coordonnées de paiement de Rydar modifiées",
  "platform_legal.updated": "Informations légales modifiées",
  // Frais Rydar
  "platform_fee.adjusted": "Correction des frais Rydar",
  "platform_fee.reminded": "Relance des frais Rydar envoyée",
  "platform_fee.terms_changed": "Conditions de paiement des frais Rydar modifiées",
  "platform_fee.reduction_approved": "Baisse des frais Rydar acceptée",
  "platform_fee.reduction_rejected": "Baisse des frais Rydar refusée",
  "platform_fee.reduction_superseded": "Baisse des frais Rydar remplacée",
  "platform_fee.whatsapp_allowed": "Relances WhatsApp des frais Rydar acceptées",
  "platform_fee.whatsapp_refused": "Relances WhatsApp des frais Rydar refusées",
  "platform_payment.declared": "Paiement à Rydar déclaré",
  "platform_payment.confirmed": "Paiement à Rydar confirmé",
  "platform_payment.recorded": "Paiement à Rydar enregistré",
  "platform_payment.rejected": "Paiement à Rydar refusé",
  "platform_payment.cancelled": "Paiement à Rydar annulé",
  "platform_payment.reopened": "Paiement à Rydar rouvert",
  // Réseau partagé
  "network.settings": "Réglages du réseau partagé modifiés",
  "network.terms_accepted": "Convention du réseau partagé acceptée",
  "network.approved": "Organisation validée pour le réseau partagé",
  "network.refused": "Organisation refusée pour le réseau partagé",
  "network.approval_lost": "Validation pour le réseau partagé perdue",
  "network.suspended": "Réseau partagé suspendu pour l'organisation",
  "network.restored": "Réseau partagé rétabli pour l'organisation",
  "network.exclusion": "Exclusion entre organisations du réseau partagé",
  "network.driver_excluded": "Chauffeur exclu du réseau partagé",
  "network.driver_auto_excluded": "Chauffeur exclu automatiquement du réseau partagé",
  "network.driver_exclusion_lifted": "Exclusion d'un chauffeur levée",
  "network.ride_validated": "Course partagée validée",
  "network.ride_contested": "Course partagée contestée",
  "network.ride_closed": "Course partagée clôturée",
  "network.payout_info_viewed": "Coordonnées de paiement consultées (réseau partagé)",
  // WhatsApp
  "whatsapp.configured": "WhatsApp relié",
  "whatsapp.removed": "WhatsApp retiré",
  "whatsapp.test_sent": "Message WhatsApp de test envoyé",
  // Sécurité
  "security.cross_tenant_access": "Accès refusé aux données d'un autre client",
  "security.tenant_field_rejected": "Demande refusée\u00a0: organisation imposée par la clé",
};

/** Entités du déclencheur générique d'audit : nom et accord (« ajouté », « ajoutée », « ajoutés »). */
const AUDIT_ENTITIES: Record<string, { noun: string; agree: "" | "e" | "s" | "es" }> = {
  organizations: { noun: "Client", agree: "" },
  organization_settings: { noun: "Réglages", agree: "s" },
  booking_sites: { noun: "Mini-site", agree: "" },
  organization_users: { noun: "Membre", agree: "" },
  drivers: { noun: "Fiche chauffeur", agree: "e" },
  vehicles: { noun: "Véhicule", agree: "" },
  api_keys: { noun: "Clé de connexion", agree: "e" },
  pricing_rules: { noun: "Tarif", agree: "" },
  plans: { noun: "Offre", agree: "e" },
  subscriptions: { noun: "Abonnement", agree: "" },
};

/** Préfixes des codes connus, pour le repli d'une action inconnue (« Chauffeur : … »). */
const AUDIT_DOMAINS: Record<string, string> = {
  api_key: "Clé de connexion",
  billing: "Abonnement",
  booking_site: "Mini-site",
  chat: "Messagerie",
  contact_request: "Demande de contact",
  driver: "Chauffeur",
  driver_documents: "Document",
  email: "E-mail",
  fraud_report: "Signalement",
  identity_ban: "Bannissement",
  member: "Membre",
  network: "Réseau partagé",
  organization: "Client",
  platform: "Plateforme",
  platform_billing: "Plateforme",
  platform_fee: "Frais Rydar",
  platform_legal: "Informations légales",
  platform_payment: "Paiement à Rydar",
  security: "Sécurité",
  webhook: "Webhook",
  whatsapp: "WhatsApp",
};

const OPERATIONS: Record<string, string> = { insert: "ajouté", update: "modifié", delete: "supprimé" };

/**
 * Action d'une ligne d'audit en mots simples. Inconnue : « Domaine : reste du code » sans tirets bas (« Chauffeur :
 * nouvelle action »), jamais une exception ; vide : « Action non précisée ».
 */
export function auditActionLabel(code: string | null | undefined): string {
  const raw = (code ?? "").trim();
  if (!raw) return "Action non précisée";
  if (has(AUDIT_ACTIONS, raw)) return AUDIT_ACTIONS[raw]!;
  const dot = raw.indexOf(".");
  const head = dot > 0 ? raw.slice(0, dot) : "";
  const tail = dot > 0 ? raw.slice(dot + 1) : raw;
  const entity = has(AUDIT_ENTITIES, head) ? AUDIT_ENTITIES[head] : undefined;
  const op = has(OPERATIONS, tail) ? OPERATIONS[tail] : undefined;
  if (entity && op) return `${entity.noun} ${op}${entity.agree}`;
  const words = (s: string) => s.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  const domain = has(AUDIT_DOMAINS, head) ? AUDIT_DOMAINS[head] : entity?.noun;
  if (domain) return `${domain}\u00a0: ${words(tail) || "action"}`;
  return upperFirst(words(raw)) || "Action non précisée";
}

// ----------------------------------------------------------------------------------------------- Journal du dispatch

/** Niveaux des événements de dispatch (public.event_level) : plus de « DBG », « WRN »… à l'écran. */
export const DISPATCH_LEVEL: Record<"debug" | "info" | "success" | "warning" | "error", Labelled> = {
  debug: { label: "Détail", tone: "neutral" },
  info: { label: "Info", tone: "neutral" },
  success: { label: "Réussi", tone: "green" },
  warning: { label: "Attention", tone: "amber" },
  error: { label: "Erreur", tone: "red" },
};

export function dispatchLevel(code: string | null | undefined): Labelled {
  return lookup(DISPATCH_LEVEL, code) ?? DISPATCH_LEVEL.info;
}

// ---------------------------------------------------------------------------------------------- Abonnement (Stripe)

/** Statuts d'abonnement (public.subscription_status, statuts Stripe). */
export const SUBSCRIPTION_STATUS: Record<
  "active" | "trialing" | "past_due" | "unpaid" | "canceled" | "incomplete" | "incomplete_expired" | "paused",
  Labelled
> = {
  active: { label: "Actif", tone: "green" },
  trialing: { label: "Période d'essai", tone: "blue" },
  past_due: { label: "Paiement en retard", tone: "amber" },
  unpaid: { label: "Impayé", tone: "red" },
  canceled: { label: "Résilié", tone: "neutral" },
  incomplete: { label: "Paiement à finaliser", tone: "amber" },
  incomplete_expired: { label: "Résilié", tone: "neutral" },
  paused: { label: "En pause", tone: "amber" },
};

export function subscriptionStatus(code: string | null | undefined): Labelled {
  return lookup(SUBSCRIPTION_STATUS, code) ?? { label: "Statut inconnu", tone: "neutral" };
}

/** Statuts de facture (invoices.status : statuts Stripe + « payment_failed » écrit par le webhook). */
export const INVOICE_STATUS: Record<"open" | "draft" | "paid" | "void" | "uncollectible" | "payment_failed", Labelled> = {
  open: { label: "À payer", tone: "amber" },
  draft: { label: "Brouillon", tone: "neutral" },
  paid: { label: "Payée", tone: "green" },
  void: { label: "Annulée", tone: "neutral" },
  uncollectible: { label: "Irrécouvrable", tone: "red" },
  payment_failed: { label: "Échec du paiement", tone: "red" },
};

export function invoiceStatus(code: string | null | undefined): Labelled {
  return lookup(INVOICE_STATUS, code) ?? { label: "Statut inconnu", tone: "neutral" };
}

// ------------------------------------------------------------------------------------------------------------ Outils

/** Clé propre d'une table (jamais une propriété héritée : « constructor », « toString »… venus de la base). */
function has(table: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

/** Valeur d'une table pour un code venu de la base. */
function lookup<T>(table: Record<string, T>, code: string | null | undefined): T | undefined {
  return code && has(table, code) ? table[code] : undefined;
}
