import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Fiche d'un client du super admin (docs/REFONTE-PANELS.md, R4) :
//  1. « À surveiller » : une ligne par sujet, la plus urgente d'abord, lien vers l'endroit où agir ; lecture impossible
//     dite comme telle (jamais un faux zéro) ; rien à signaler → aucune ligne ;
//  2. résumés d'une ligne : modèle et frais Rydar, offre et limites effectives, abonnement, notifications (code brut
//     seulement pour le détail replié) ;
//  3. ordre de la fiche et garde-fous (mêmes lectures sans « Clés API », formulaire du modèle inchangé, invitation par
//     e-mail par défaut, bascules de la Flotte Privée hors de sa carte, aucun « Option 1 / 2 » ni « rattacheur »).

vi.mock("@/lib/wording", async () => await import("../../lib/wording"));
vi.mock("@/components/admin/private-fleet-state", async () => await import("./private-fleet-state"));
vi.mock("@/components/platform-fees/org-platform-format", async () => await import("../platform-fees/org-platform-format"));

const w = await import("./org-watch");
const { NO_PLAN_LIMITS, effectiveLimits } = await import("./private-fleet-state");

/** Espaces insécables (typographie, séparateur des milliers, montants) ramenées à des espaces simples. */
const nb = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const ORG = "10000000-0000-4000-a000-00000000000c";
const NOW = Date.parse("2026-10-10T10:00:00Z");
type Input = Parameters<typeof w.orgWatchItems>[0];
const BASE: Input = {
  orgId: ORG,
  timeZone: "Europe/Paris",
  termsVersion: "2026-10-02",
  terms: { state: "accepted", acceptedAt: "2026-10-03T09:00:00Z", notifiedAt: null },
  fees: null,
  scheduled: null,
  rates: { percent: 0, fixedCents: 500, currency: "EUR" },
  invitations: [],
  applications: 0,
  now: NOW,
};
const FEES = { due_cents: 9500, days_overdue: 4, overdue_since: "2026-10-06", blocked: false, currency: "EUR" };
/** Hausse annoncée le 1er octobre (e-mail parti), effet le 12 novembre 2026. */
const SCHEDULED = {
  status: "scheduled" as const,
  mode: "notice" as const,
  effective_on: "2026-11-12",
  effective_at: "2026-11-11T23:00:00Z",
  notice_sent_at: "2026-10-01T08:00:00Z",
  percent: 10,
  fixed_cents: 0,
};
const items = (patch: Partial<Input>) => w.orgWatchItems({ ...BASE, ...patch });

// ----------------------------------------------------------------------------------------------- 1. À surveiller

describe("À surveiller", () => {
  it("rien à signaler : aucune ligne (l'encadré n'est pas affiché)", () => {
    expect(items({})).toEqual([]);
    // Frais à jour (rien d'échu), aucune candidature, Flotte Privée (candidatures sans objet)
    expect(items({ fees: { ...FEES, due_cents: 0, overdue_since: null, days_overdue: 0 }, applications: undefined })).toEqual([]);
  });

  it("frais en retard : montant, jours de retard, blocage ; lien vers le compte des frais", () => {
    const [late] = items({ fees: { ...FEES, blocked: true } });
    expect(late).toMatchObject({ key: "fees", tone: "danger", link: { href: `/admin/frais/${ORG}`, label: "Voir le compte" } });
    expect(nb(late!.text)).toBe("Frais Rydar en retard : 95 € dus depuis 4 jours ; création de courses bloquée.");
    expect(nb(items({ fees: { ...FEES, days_overdue: 1 } })[0]!.text)).toBe("Frais Rydar en retard : 95 € dus depuis 1 jour.");
    expect(nb(items({ fees: { ...FEES, days_overdue: 0 } })[0]!.text)).toBe("Frais Rydar en retard : 95 € dus aujourd'hui.");
  });

  it("CGV non acceptées : ni annoncées (lien vers les informations légales) ou annoncées (date) ; mise à jour à accepter", () => {
    const [pending] = items({ terms: { state: "pending", notifiedAt: null } });
    expect(pending).toMatchObject({ key: "terms", tone: "warning", link: { href: "/admin/legal", label: "Informations légales" } });
    expect(nb(pending!.text)).toBe(
      "CGV et accord de traitement du 2 octobre 2026 ni acceptés ni annoncés par e-mail : une hausse des frais n'est possible que sur accord écrit.",
    );
    const [notified] = items({ terms: { state: "pending", notifiedAt: "2026-10-05T08:00:00Z" } });
    expect(notified!.link).toBeUndefined();
    expect(nb(notified!.text)).toBe("CGV et accord de traitement du 2 octobre 2026 pas encore acceptés (annoncés par e-mail le 5 octobre 2026).");
    expect(nb(items({ terms: { state: "updated", notifiedAt: null } })[0]!.text)).toBe(
      "Mise à jour des CGV du 2 octobre 2026 ni acceptée ni annoncée par e-mail (version précédente acceptée).",
    );
    expect(nb(items({ terms: { state: "updated", notifiedAt: "2026-10-05T08:00:00Z" } })[0]!.text)).toBe(
      "Mise à jour des CGV du 2 octobre 2026 pas encore acceptée (annoncée par e-mail le 5 octobre 2026).",
    );
  });

  it("invitations pas encore acceptées : noms et rôles, accord du nombre", () => {
    const [one] = items({ invitations: [{ name: "Nadia Benhamou", role: "owner" }] });
    expect(one).toMatchObject({ key: "invitations", tone: "warning" });
    expect(nb(one!.text)).toBe("1 invitation pas encore acceptée : Nadia Benhamou (propriétaire).");
    expect(nb(items({ invitations: [{ name: "A", role: "admin" }, { name: "b@exemple.fr", role: "dispatcher" }] })[0]!.text)).toBe(
      "2 invitations pas encore acceptées : A (administrateur), b@exemple.fr (dispatcher).",
    );
  });

  it("hausse programmée : date et taux ; e-mail d'annonce pas parti 30 jours avant → rouge (elle sera annulée)", () => {
    const [ok] = items({ scheduled: SCHEDULED });
    expect(ok).toMatchObject({ key: "scheduled", tone: "warning", link: { href: "#modele-et-frais" } });
    expect(nb(ok!.text)).toBe(
      "Hausse des frais Rydar programmée le 12 novembre 2026 : 10 % du prix de chaque course terminée (actuellement 5 € par course terminée).",
    );
    const [late] = items({ scheduled: { ...SCHEDULED, notice_sent_at: "2026-10-20T08:00:00Z" } });
    expect(late!.tone).toBe("danger");
    expect(nb(late!.text)).toContain("L'e-mail d'annonce n'est pas parti 30 jours avant : la hausse sera annulée à cette date.");
  });

  it("candidatures en attente (information : le client les valide) ; Flotte Privée : sans objet", () => {
    const [apps] = items({ applications: 3 });
    expect(apps).toMatchObject({ key: "applications", tone: "neutral" });
    expect(apps!.text).toBe("3 candidatures de chauffeurs en attente de validation par le client.");
    expect(items({ applications: 1 })[0]!.text).toBe("1 candidature de chauffeur en attente de validation par le client.");
    expect(items({ applications: undefined })).toEqual([]);
  });

  it("lecture impossible : dite en une ligne (jamais un faux zéro ni « rien à signaler »)", () => {
    const list = items({ terms: null, fees: "unreadable", applications: null });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: "unreadable", tone: "neutral" });
    expect(nb(list[0]!.text)).toBe("Lecture impossible : frais Rydar, acceptation des CGV, candidatures. Réessayez dans un instant.");
  });

  it("ordre : rouge, puis ambre, puis information ; lectures impossibles en dernier", () => {
    const list = items({
      fees: FEES,
      scheduled: { ...SCHEDULED, notice_sent_at: null, effective_at: "2026-10-30T23:00:00Z", effective_on: "2026-10-31" },
      terms: { state: "pending", notifiedAt: null },
      invitations: [{ name: "Léa", role: "dispatcher" }],
      applications: null,
    });
    expect(list.map((i) => i.key)).toEqual(["fees", "scheduled", "terms", "invitations", "unreadable"]);
    expect(list.map((i) => i.tone)).toEqual(["danger", "danger", "warning", "warning", "neutral"]);
    // Typographie : espace insécable avant « : ; ! ? », jamais une espace ordinaire
    for (const i of list) expect(i.text, i.text).not.toMatch(/ [:;!?]/);
  });
});

describe("hausse dont l'annonce est partie trop tard (noticeLate)", () => {
  it("annonce partie au moins 30 jours avant : à l'heure ; partie trop tard, ou pas partie à moins de 30 jours : en retard", () => {
    expect(w.noticeLate(SCHEDULED, NOW)).toBe(false);
    expect(w.noticeLate({ ...SCHEDULED, notice_sent_at: "2026-10-20T08:00:00Z" }, NOW)).toBe(true);
    expect(w.noticeLate({ ...SCHEDULED, notice_sent_at: null }, NOW)).toBe(false);
    expect(w.noticeLate({ ...SCHEDULED, notice_sent_at: null }, Date.parse("2026-10-20T00:00:00Z"))).toBe(true);
    // Hausse sur accord écrit ou déjà appliquée : jamais en retard
    expect(w.noticeLate({ ...SCHEDULED, mode: "consent", notice_sent_at: null }, Date.parse("2026-11-01T00:00:00Z"))).toBe(false);
    expect(w.noticeLate({ ...SCHEDULED, status: "applied", notice_sent_at: null }, Date.parse("2026-11-01T00:00:00Z"))).toBe(false);
  });
});

// --------------------------------------------------------------------------------------------- 2. Résumés d'une ligne

describe("résumés de la fiche", () => {
  const SUMMARY = { model: "fleet" as const, privateFleet: false, percent: 0, fixedCents: 500, currency: "EUR", terms: BASE.terms, scheduled: null, timeZone: "Europe/Paris", now: NOW };

  it("modèle et frais Rydar : modèle (imposé en Flotte Privée), frais, CGV, hausse programmée", () => {
    expect(w.modelFeesSummary(SUMMARY).map((i) => [i.label, nb(i.value), i.tone ?? null])).toEqual([
      ["Modèle", "Flotte", null],
      ["Frais Rydar", "5 € par course terminée", null],
      ["CGV", "acceptées le 3 octobre 2026", null],
    ]);
    const fp = w.modelFeesSummary({ ...SUMMARY, privateFleet: true, fixedCents: 0, terms: { state: "pending" }, scheduled: SCHEDULED });
    expect(fp.map((i) => [i.label, nb(i.value), i.tone ?? null])).toEqual([
      ["Modèle", "Flotte (imposé par la Flotte Privée)", null],
      ["Frais Rydar", "aucuns frais par course", null],
      ["CGV", "pas encore acceptées", "warning"],
      ["Hausse programmée", "le 12 novembre 2026 (10 % du prix de chaque course terminée)", "warning"],
    ]);
    expect(w.modelFeesSummary({ ...SUMMARY, model: "centrale", terms: null })[0]!.value).toBe("Centrale à commission");
    expect(w.modelFeesSummary({ ...SUMMARY, terms: null })[2]).toEqual({ label: "CGV", value: "lecture impossible", tone: "neutral" });
    expect(w.modelFeesSummary({ ...SUMMARY, terms: { state: "updated" } })[2]!.value).toBe("mise à jour pas encore acceptée");
  });

  it("offre et limites : limites effectives (offre, ajustements, Flotte Privée), illimité, options", () => {
    const pro = { max_drivers: 40, max_rides_per_month: 3000, max_admins: 5, api_access: true, booking_site: true, custom_domain: false, advanced_stats: true };
    expect(nb(w.planSummary("Pro", pro))).toBe("Offre Pro · 40 chauffeurs · 3 000 courses par mois · 5 administrateurs · API de réservation, mini-site, statistiques avancées");
    expect(w.planSummary(null, NO_PLAN_LIMITS as Record<string, unknown>)).toBe(
      "Sans offre · chauffeurs illimités · courses illimitées · administrateurs illimités · API de réservation, mini-site, domaine personnalisé, statistiques avancées",
    );
    // Flotte Privée : 1 chauffeur et 1 accès imposés après l'offre et l'ajustement
    const fp = effectiveLimits({ planId: "p", planLimits: pro, override: { max_drivers: 80, booking_site: false }, privateFleet: true });
    expect(nb(w.planSummary("Pro", fp))).toBe("Offre Pro · 1 chauffeur · 3 000 courses par mois · 1 administrateur · API de réservation, statistiques avancées");
    expect(w.planSummary("Mini", { max_rides_per_month: 1 })).toBe("Offre Mini · chauffeurs illimités · 1 course par mois · administrateurs illimités · aucune option");
    // Flotte Privée sur une offre publique (mini-site et domaine compris) : ni l'un ni l'autre cité ; les limites, elles,
    // restent celles de la base (effectiveLimits n'y touche pas)
    const business = { ...pro, max_drivers: 250, custom_domain: true };
    const fpBusiness = effectiveLimits({ planId: "b", planLimits: business, override: null, privateFleet: true });
    expect(fpBusiness.booking_site).toBe(true);
    expect(nb(w.planSummary("Business", fpBusiness, { privateFleet: true }))).toBe(
      "Offre Business · 1 chauffeur · 3 000 courses par mois · 1 administrateur · API de réservation, statistiques avancées",
    );
    expect(w.planSummary("Business", fpBusiness)).toContain("mini-site, domaine personnalisé");
    expect(nb(w.planSummary("Mini", { max_rides_per_month: 1, booking_site: true }, { privateFleet: true }))).toContain("aucune option");
  });

  it("abonnement : statut en français, fin d'essai ou de période ; aucun abonnement", () => {
    const sub = { status: "active", trial_ends_at: null, current_period_end: "2026-11-01T00:00:00Z", cancel_at_period_end: false };
    expect(nb(w.subscriptionLine(null, "Europe/Paris"))).toBe("Sans abonnement en ligne");
    expect(nb(w.subscriptionLine(sub, "Europe/Paris"))).toBe("Abonnement : Actif");
    expect(nb(w.subscriptionLine({ ...sub, cancel_at_period_end: true }, "Europe/Paris"))).toBe("Abonnement : Actif jusqu'au 1er novembre 2026 (résiliation demandée)");
    expect(nb(w.subscriptionLine({ ...sub, status: "trialing", trial_ends_at: "2026-10-24T08:00:00Z" }, "Europe/Paris"))).toBe(
      "Abonnement : Période d'essai jusqu'au 24 octobre 2026",
    );
    expect(nb(w.subscriptionLine({ ...sub, status: "trialing" }, "Europe/Paris"))).toBe("Abonnement : Période d'essai");
    expect(nb(w.subscriptionLine({ ...sub, status: "past_due" }, "Europe/Paris"))).toBe("Abonnement : Paiement en retard");
    expect(nb(w.subscriptionLine({ ...sub, status: "nouveau_statut" }, "Europe/Paris"))).toBe("Abonnement : Statut inconnu");
  });

  it("notifications : statut et raison en français ; code brut (type, erreur) réservé au détail replié", () => {
    expect(w.notificationLine({ status: "failed", type: "ride_offer", last_error: "NO_PUSH_TOKEN" })).toEqual({
      status: { label: "Échec", tone: "red" },
      reason: "Application jamais ouverte ou notifications refusées",
      code: "ride_offer · NO_PUSH_TOKEN",
    });
    expect(w.notificationLine({ status: "cancelled", type: "ride_offer_scheduled", last_error: "offer_closed" })).toMatchObject({
      status: { label: "Annulée" },
      reason: "Proposition close avant l'envoi",
    });
    expect(w.notificationLine({ status: "queued", type: "ride_reminder", last_error: null })).toEqual({
      status: { label: "En file", tone: "amber" },
      reason: null,
      code: "ride_reminder",
    });
  });
});

// ------------------------------------------------------------------------------------- 3. Ordre de la fiche, garde-fous

const WEB = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");
const PAGE = read("app/admin/organizations/[id]/page.tsx");
const FILES = [
  "app/admin/organizations/[id]/page.tsx",
  "components/admin/dispatch-model.tsx",
  "components/admin/private-fleet-card.tsx",
  "components/admin/admin-widgets.tsx",
  "components/admin/organization-access.tsx",
  "components/admin/org-network-card.tsx",
  "components/platform-fees/admin-org-fees-card.tsx",
];

describe("fiche d'un client : ordre et garde-fous", () => {
  it("ordre : en-tête, À surveiller, chiffres, Flotte Privée, accès, argent, offre, replis, zone sensible", () => {
    const markers = [
      'back={{ href: "/admin/organizations", label: "Clients" }}',
      "<WatchCallout",
      "<StatCard",
      "<PrivateFleetCard",
      "<OrganizationAccessCard",
      "<OrgPlatformFeesCard",
      'title="Modèle et frais Rydar"',
      'title="Offre et limites"',
      'title="Offre de service et réseau partagé"',
      'title="Activité"',
      'part="sensitive"',
    ];
    const at = markers.map((m) => PAGE.indexOf(m));
    expect(at.every((i) => i >= 0), JSON.stringify(markers.filter((_, i) => at[i]! < 0))).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Seule action d'en-tête : « Réactiver » (client suspendu ou archivé)
    expect(PAGE).toContain('actions={status !== "active" ? <OrganizationStatusActions orgId={id} status={status} part="reactivate" /> : undefined}');
  });

  it("mêmes lectures, sans la carte « Clés API » ni son compteur", () => {
    expect(PAGE).not.toMatch(/from\("api_keys"\)/);
    expect(PAGE).not.toMatch(/label="Clés API"/);
    for (const read of ['rpc("org_kpis"', 'rpc("admin_platform_account"', 'rpc("admin_platform_fee_schedule"', 'from("legal_acceptances")', 'from("network_memberships")']) {
      expect(PAGE).toContain(read);
    }
  });

  it("modèle et frais : DispatchModelForm inchangé (même clé de remontage, mêmes propriétés), déplié par « Modifier le modèle ou les frais »", () => {
    expect(PAGE).toContain('key={`${model}:${org.platform_fee_percent}:${org.platform_fee_fixed_cents}:${schedule?.scheduled?.id ?? ""}`}');
    expect(PAGE).toMatch(/title="Modifier le modèle ou les frais"[\s\S]*?<DispatchModelForm/);
    for (const prop of ["orgId={id}", "model={model}", "joinEnabled={!!org.join_enabled}", "schedule={schedule}", "terms={terms}", "modelLocked={privateFleet}"]) {
      expect(PAGE).toContain(prop);
    }
  });

  it("Flotte Privée : bascules hors de sa carte, dans « Offre de service et réseau partagé » ; « Passer en Flotte Privée » en contour", () => {
    const card = read("components/admin/private-fleet-card.tsx");
    const fleetCard = card.slice(card.indexOf("export async function PrivateFleetCard"), card.indexOf("export async function PrivateFleetExitCard"));
    expect(fleetCard).not.toContain("PackConversionButtons");
    expect(card).toMatch(/PrivateFleetExitCard[\s\S]*?targets=\{\["fleet", "centrale"\]\}/);
    const entry = card.slice(card.indexOf("export async function PrivateFleetEntryCard"));
    expect(entry).toMatch(/\[&_button\]:bg-transparent[\s\S]*?targets=\{\["private_fleet"\]\}/);
    expect(PAGE).toMatch(/title="Offre de service et réseau partagé"[\s\S]*?<PrivateFleetExitCard[\s\S]*?<PrivateFleetEntryCard[\s\S]*?<OrgNetworkCard/);
  });

  it("accès : invitation par e-mail par défaut, mot de passe provisoire derrière une case, même charge envoyée", () => {
    const access = read("components/admin/organization-access.tsx");
    expect(access).toContain("const [temporary, setTemporary] = useState(false);");
    expect(access).toContain('password: temporary ? String(f.get("password") ?? "") : undefined,');
    expect(access).toContain("Mot de passe provisoire (serveur sans e-mail)");
    expect(access).toMatch(/label="Mot de passe provisoire"/);
    // Annuler une invitation ou retirer un accès : confirmation
    expect(access).toMatch(/<ConfirmDialog[\s\S]*?confirmLabel="Annuler l'invitation"/);
    expect(access).toContain("setRevoke(m)");
  });

  it("vocabulaire : ni « Option 1 / 2 », ni « rattacheur », ni « Frais plateforme » en titre ; offre à trois choix", () => {
    for (const file of FILES) {
      const src = read(file);
      expect(src, file).not.toMatch(/Option [12]\b|[Rr]attacheur/);
    }
    expect(read("components/platform-fees/admin-org-fees-card.tsx")).toContain('title="Frais Rydar"');
    const widgets = read("components/admin/admin-widgets.tsx");
    expect(widgets).toContain("Ajuster une limite pour ce client (facultatif)");
    expect(widgets).toMatch(/<option value="plan">[\s\S]*?<option value="on">\{"Forcer\\u00a0: oui"\}<\/option>[\s\S]*?<option value="off">\{"Forcer\\u00a0: non"\}/);
    // « Selon l'offre » retire la clé de l'ajustement (même structure envoyée qu'avant)
    expect(widgets).toContain('setKey(f.key, v === "plan" ? undefined : v === "on");');
    expect(widgets).toContain("await updateOrganizationPlan(orgId, plan || null, o)");
  });
});
