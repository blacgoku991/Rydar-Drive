// Super admin — fiche d'un client (docs/REFONTE-PANELS.md, R4) : ce qui est « À surveiller » (orgWatchItems) et les
// résumés d'une ligne de la fiche (modèle et frais Rydar, offre et limites, abonnement, notifications de l'activité).
// N'invente rien : chaque ligne vient d'une donnée déjà lue par la fiche ; une lecture impossible le dit, jamais un
// faux zéro ni une liste vide. Module neutre (ni « use client » ni « server-only ») : page serveur, formulaires client
// et tests (org-watch.test.ts).
import {
  DISPATCH_MODEL_META, ORG_ROLE_LABELS, formatPrice, legalDateLabel, localIsoDay, type DispatchModel, type LegalAcceptanceState, type OrgRole,
  type PlatformAccount, type PlatformFeeChangeRow,
} from "@rydar/shared";
import { limitEnabled } from "@/components/admin/private-fleet-state";
import { feeTermsText } from "@/components/platform-fees/org-platform-format";
import { notificationErrorLabel, notificationStatus, plural, subscriptionStatus, type Labelled } from "@/lib/wording";

const NB = "\u00a0";

/** « 12 novembre 2026 » : jour « AAAA-MM-JJ », ou instant lu dans le fuseau du client. */
function dayLabel(value: string, timeZone: string): string {
  return legalDateLabel(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : localIsoDay(value, timeZone));
}

/** « 5 € par course terminée », « 10 % du prix + 0,50 € par course terminée », « aucuns frais par course ». */
export function ratesText(percent: number, fixedCents: number, currency = "EUR"): string {
  return feeTermsText({ fee_percent: percent, fee_fixed_cents: fixedCents, currency }, "aucuns frais par course");
}

// -----------------------------------------------------------------------------------------------------------------
// Hausse des frais annoncée
// -----------------------------------------------------------------------------------------------------------------

/**
 * Hausse programmée dont l'e-mail d'annonce n'est pas (ou ne sera plus) parti au moins 30 jours avant la date d'effet :
 * le ménage l'annulera (private.apply_platform_fee_changes). Envoi encore possible à temps : pas d'alerte.
 */
export function noticeLate(c: Pick<PlatformFeeChangeRow, "status" | "mode" | "effective_at" | "notice_sent_at">, now = Date.now()): boolean {
  if (c.status !== "scheduled" || c.mode !== "notice") return false;
  const limit = Date.parse(c.effective_at) - 30 * 86_400_000;
  return c.notice_sent_at ? Date.parse(c.notice_sent_at) > limit : now > limit;
}

type ScheduledChange = Pick<PlatformFeeChangeRow, "status" | "mode" | "effective_on" | "effective_at" | "notice_sent_at" | "percent" | "fixed_cents">;

// -----------------------------------------------------------------------------------------------------------------
// À surveiller
// -----------------------------------------------------------------------------------------------------------------

/** Couleur du point d'une ligne : rouge (retard, hausse qui sera annulée), ambre (à suivre), gris (information). */
export type WatchTone = "danger" | "warning" | "neutral";

export type OrgWatchItem = { key: string; tone: WatchTone; text: string; link?: { href: string; label: string } };

/** Acceptation des CGV et de l'accord de traitement en vigueur (OrgTermsStatus de la fiche) ; null : lecture impossible. */
type TermsInput = { state: LegalAcceptanceState; acceptedAt?: string | null; notifiedAt?: string | null } | null;

export type OrgWatchInput = {
  orgId: string;
  /** Fuseau du client (dates des annonces) */
  timeZone: string;
  /** Version des CGV en vigueur (ORG_LEGAL_VERSION, « AAAA-MM-JJ ») */
  termsVersion: string;
  terms: TermsInput;
  /** Compte des frais Rydar ; null : pas de compte à suivre ; « unreadable » : lecture impossible */
  fees: Pick<PlatformAccount, "due_cents" | "days_overdue" | "overdue_since" | "blocked" | "currency"> | null | "unreadable";
  /** Hausse des frais annoncée, pas encore appliquée, et frais actuels (pour la phrase « actuellement… ») */
  scheduled: ScheduledChange | null;
  rates: { percent: number; fixedCents: number; currency: string };
  /** Invitations pas encore acceptées (adhésion « invitée », ou compte invité qui ne s'est jamais connecté) */
  invitations: { name: string; role: OrgRole }[];
  /** Candidatures de chauffeurs en attente ; null : lecture impossible ; absent : sans objet (Flotte Privée) */
  applications?: number | null;
  now?: number;
};

/**
 * Lignes « À surveiller » de la fiche, de la plus urgente à la simple information : frais en retard, hausse qui sera
 * annulée faute de préavis, CGV non acceptées (ou mise à jour à accepter), invitations en attente, hausse programmée,
 * candidatures en attente, puis lectures impossibles. Rien à signaler : liste vide (l'encadré n'est pas affiché).
 */
export function orgWatchItems(i: OrgWatchInput): OrgWatchItem[] {
  const now = i.now ?? Date.now();
  const danger: OrgWatchItem[] = [];
  const warning: OrgWatchItem[] = [];
  const neutral: OrgWatchItem[] = [];
  const unreadable: string[] = [];
  const version = legalDateLabel(i.termsVersion);

  // Frais Rydar échus (échéance passée) : le blocage de la création de courses est dit s'il s'applique
  if (i.fees === "unreadable") unreadable.push("frais Rydar");
  else if (i.fees && i.fees.due_cents > 0 && i.fees.overdue_since) {
    const days = i.fees.days_overdue;
    const amount = formatPrice(i.fees.due_cents, i.fees.currency);
    danger.push({
      key: "fees",
      tone: "danger",
      text: `Frais Rydar en retard${NB}: ${amount} ${days > 0 ? `dus depuis ${plural(days, "jour")}` : "dus aujourd'hui"}${
        i.fees.blocked ? `${NB}; création de courses bloquée` : ""
      }.`,
      link: { href: `/admin/frais/${i.orgId}`, label: "Voir le compte" },
    });
  }

  // Hausse annoncée : rouge si l'e-mail d'annonce n'est pas parti 30 jours avant (elle sera annulée à sa date)
  if (i.scheduled) {
    const late = noticeLate(i.scheduled, now);
    const target = ratesText(Number(i.scheduled.percent), i.scheduled.fixed_cents, i.rates.currency);
    const current = ratesText(i.rates.percent, i.rates.fixedCents, i.rates.currency);
    const item: OrgWatchItem = {
      key: "scheduled",
      tone: late ? "danger" : "warning",
      text:
        `Hausse des frais Rydar programmée le ${dayLabel(i.scheduled.effective_on, i.timeZone)}${NB}: ${target} (actuellement ${current}).` +
        (late ? ` L'e-mail d'annonce n'est pas parti 30${NB}jours avant${NB}: la hausse sera annulée à cette date.` : ""),
      link: { href: "#modele-et-frais", label: "Voir le modèle et les frais" },
    };
    (late ? danger : warning).push(item);
  }

  // CGV et accord de traitement en vigueur
  if (!i.terms) unreadable.push("acceptation des CGV");
  else if (i.terms.state !== "accepted") {
    const notified = i.terms.notifiedAt ? dayLabel(i.terms.notifiedAt, i.timeZone) : null;
    const legal = { href: "/admin/legal", label: "Informations légales" };
    warning.push(
      i.terms.state === "updated"
        ? {
            key: "terms",
            tone: "warning",
            text: notified
              ? `Mise à jour des CGV du ${version} pas encore acceptée (annoncée par e-mail le ${notified}).`
              : `Mise à jour des CGV du ${version} ni acceptée ni annoncée par e-mail (version précédente acceptée).`,
            ...(notified ? {} : { link: legal }),
          }
        : {
            key: "terms",
            tone: "warning",
            text: notified
              ? `CGV et accord de traitement du ${version} pas encore acceptés (annoncés par e-mail le ${notified}).`
              : `CGV et accord de traitement du ${version} ni acceptés ni annoncés par e-mail${NB}: une hausse des frais n'est possible que sur accord écrit.`,
            ...(notified ? {} : { link: legal }),
          },
    );
  }

  // Invitations pas encore acceptées (le compte n'a pas encore choisi son mot de passe, ou l'accès attend son lien)
  if (i.invitations.length) {
    const names = i.invitations.map((m) => `${m.name} (${(ORG_ROLE_LABELS[m.role] ?? m.role).toLowerCase()})`).join(", ");
    warning.push({
      key: "invitations",
      tone: "warning",
      text: `${plural(i.invitations.length, "invitation pas encore acceptée", "invitations pas encore acceptées")}${NB}: ${names}.`,
    });
  }

  // Candidatures : le client les valide dans son espace (information pour Rydar)
  if (i.applications === null) unreadable.push("candidatures");
  else if (i.applications) {
    neutral.push({
      key: "applications",
      tone: "neutral",
      text: `${plural(i.applications, "candidature de chauffeur", "candidatures de chauffeurs")} en attente de validation par le client.`,
    });
  }

  if (unreadable.length) {
    neutral.push({ key: "unreadable", tone: "neutral", text: `Lecture impossible${NB}: ${unreadable.join(", ")}. Réessayez dans un instant.` });
  }
  return [...danger, ...warning, ...neutral];
}

// -----------------------------------------------------------------------------------------------------------------
// Modèle et frais Rydar (résumé au-dessus de « Modifier le modèle ou les frais »)
// -----------------------------------------------------------------------------------------------------------------

export type SummaryItem = { label: string; value: string; tone?: WatchTone };

export function modelFeesSummary(o: {
  model: DispatchModel;
  privateFleet: boolean;
  percent: number;
  fixedCents: number;
  currency: string;
  terms: TermsInput;
  scheduled: ScheduledChange | null;
  timeZone: string;
  now?: number;
}): SummaryItem[] {
  const items: SummaryItem[] = [
    { label: "Modèle", value: o.privateFleet ? `${DISPATCH_MODEL_META.fleet.label} (imposé par la Flotte Privée)` : DISPATCH_MODEL_META[o.model].label },
    { label: "Frais Rydar", value: ratesText(o.percent, o.fixedCents, o.currency) },
    !o.terms
      ? { label: "CGV", value: "lecture impossible", tone: "neutral" }
      : o.terms.state === "accepted"
        ? { label: "CGV", value: o.terms.acceptedAt ? `acceptées le ${dayLabel(o.terms.acceptedAt, o.timeZone)}` : "acceptées" }
        : { label: "CGV", value: o.terms.state === "updated" ? "mise à jour pas encore acceptée" : "pas encore acceptées", tone: "warning" },
  ];
  if (o.scheduled) {
    items.push({
      label: "Hausse programmée",
      value: `le ${dayLabel(o.scheduled.effective_on, o.timeZone)} (${ratesText(Number(o.scheduled.percent), o.scheduled.fixed_cents, o.currency)})`,
      tone: noticeLate(o.scheduled, o.now ?? Date.now()) ? "danger" : "warning",
    });
  }
  return items;
}

// -----------------------------------------------------------------------------------------------------------------
// Offre et limites
// -----------------------------------------------------------------------------------------------------------------

/** Limites chiffrées réglables par client (vide = valeur de l'offre). */
export const PLAN_NUMBER_LIMITS = [
  { key: "max_drivers", label: "Chauffeurs max." },
  { key: "max_rides_per_month", label: "Courses par mois" },
  { key: "max_admins", label: "Administrateurs" },
] as const;

/** Options de l'offre (mêmes libellés que les cartes des offres). */
export const PLAN_OPTION_LIMITS = [
  { key: "api_access", label: "API de réservation", short: "API de réservation" },
  { key: "booking_site", label: "Mini-site", short: "mini-site" },
  { key: "custom_domain", label: "Domaine personnalisé", short: "domaine personnalisé" },
  { key: "advanced_stats", label: "Statistiques avancées", short: "statistiques avancées" },
] as const;

/** Nombre d'une limite (JSON) ; absent, null ou autre chose qu'un entier positif : illimité. */
const limitNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * « Offre Pro · 40 chauffeurs · 3 000 courses par mois · 5 administrateurs · API de réservation, mini-site,
 * statistiques avancées » : limites EFFECTIVES (effectiveLimits : offre, surcharge, puis Flotte Privée).
 */
export function planSummary(planName: string | null, limits: Record<string, unknown>): string {
  const drivers = limitNumber(limits.max_drivers);
  const rides = limitNumber(limits.max_rides_per_month);
  const admins = limitNumber(limits.max_admins);
  const options = PLAN_OPTION_LIMITS.filter((opt) => limitEnabled(limits[opt.key])).map((opt) => opt.short);
  return [
    planName ? `Offre ${planName}` : "Sans offre",
    drivers == null ? "chauffeurs illimités" : plural(drivers, "chauffeur"),
    rides == null ? "courses illimitées" : `${plural(rides, "course")} par mois`,
    admins == null ? "administrateurs illimités" : plural(admins, "administrateur"),
    options.length ? options.join(", ") : "aucune option",
  ].join(" · ");
}

/** Abonnement du client (dernière ligne de subscriptions) ; null : aucun. */
export type SubscriptionInput = {
  status: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
} | null;

/** « Abonnement : Actif », « Abonnement : Période d'essai jusqu'au 24 octobre 2026 », « Sans abonnement en ligne ». */
export function subscriptionLine(s: SubscriptionInput, timeZone: string): string {
  if (!s) return "Sans abonnement en ligne";
  if (s.status === "trialing") return `Abonnement${NB}: Période d'essai${s.trial_ends_at ? ` jusqu'au ${dayLabel(s.trial_ends_at, timeZone)}` : ""}`;
  if (s.status === "active" && s.cancel_at_period_end && s.current_period_end) {
    return `Abonnement${NB}: Actif jusqu'au ${dayLabel(s.current_period_end, timeZone)} (résiliation demandée)`;
  }
  return `Abonnement${NB}: ${subscriptionStatus(s.status).label}`;
}

// -----------------------------------------------------------------------------------------------------------------
// Activité : notifications envoyées aux chauffeurs
// -----------------------------------------------------------------------------------------------------------------

/**
 * Ligne d'une notification : statut et raison en français (échec ou annulation), code brut pour le détail replié
 * (type et last_error tels qu'écrits en base : jamais le texte principal).
 */
export function notificationLine(n: { status: string; type: string; last_error: string | null }): { status: Labelled; reason: string | null; code: string } {
  return {
    status: notificationStatus(n.status),
    reason: notificationErrorLabel(n.last_error),
    code: [n.type, n.last_error].filter(Boolean).join(" · "),
  };
}
