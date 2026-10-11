"use client";
// Réglages › Abonnement (docs/REFONTE-PANELS.md § 5.6, lot R10) : « Votre abonnement » en français (offre, prix, état,
// date utile), consommation (« Illimité » en texte), factures, puis les offres. Aucune action impossible n'est proposée :
// « Gérer mon abonnement » seulement avec un abonnement Stripe (stripe_subscription_id) ; abonnement Stripe en cours
// (un second serait refusé par /api/billing/checkout, 409) : comparaison repliée et renvoi vers « Gérer mon
// abonnement » ; offre sans prix en ligne ou paiement en ligne non configuré : « Abonnement géré par l'équipe Rydar ».
// Flotte Privée (docs/FLOTTE-PRIVEE.md § 7.6) : seulement l'offre attribuée, ni jauges Chauffeurs / Administrateurs
// (1 / 1 imposés), ni « Le plus choisi » ; ses points forts lus dans ses limites effectives (privateFleetPlanFeatures).
import { ERROR_MESSAGES, dateTimeFormat, formatPrice } from "@rydar/shared";
import { Check, CreditCard, ExternalLink, Minus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/misc";
import { NewTabHint } from "@/components/ui/new-tab";
import { cn } from "@/lib/utils";
import { invoiceStatus, subscriptionStatus } from "@/lib/wording";
import { annualFreeMonths, privateFleetPlanFeatures } from "./billing-offers";

const NB = " ";

/** Abonnement Stripe encore vivant (même règle que /api/billing/checkout : un second serait refusé). */
const LIVE_SUBSCRIPTION = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);

export type BillingPlan = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price_monthly_cents: number;
  price_yearly_cents: number;
  stripe_price_monthly_id: string | null;
  stripe_price_yearly_id: string | null;
  features: string[] | null;
  highlighted: boolean;
};
export type BillingSubscription = {
  status: string;
  plan_id: string | null;
  billing_interval: "month" | "year" | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  cancel_at_period_end: boolean | null;
  canceled_at: string | null;
};
export type BillingInvoice = {
  id: string;
  number: string | null;
  status: string;
  amount_due_cents: number;
  currency: string;
  hosted_invoice_url: string | null;
  period_start: string | null;
  created_at: string;
};
type Limits = {
  max_drivers?: number | null;
  max_rides_per_month?: number | null;
  max_admins?: number | null;
  api_access?: boolean;
  booking_site?: boolean;
  custom_domain?: boolean;
  advanced_stats?: boolean;
};
export type BillingUsage = { drivers?: number; rides_this_month?: number; admins?: number; limits?: Limits } | null;

/** « 1 novembre 2026 » (fuseau de l'organisation, formateur mémorisé). */
const longDate = (iso: string | null | undefined, timeZone: string) =>
  iso ? dateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone }).format(new Date(iso)) : null;

/** Phrase de l'état de l'abonnement, avec sa date utile (essai, renouvellement, fin, résiliation). */
function statusLine(sub: BillingSubscription | null, timeZone: string): string {
  if (!sub) return "Aucun abonnement en ligne pour l'instant.";
  const end = longDate(sub.current_period_end, timeZone);
  switch (sub.status) {
    case "trialing": {
      const until = longDate(sub.trial_ends_at ?? sub.current_period_end, timeZone);
      return until ? `Période d'essai jusqu'au ${until}.` : "Période d'essai en cours.";
    }
    case "active":
      if (sub.cancel_at_period_end) return end ? `Renouvellement arrêté : l'abonnement se termine le ${end}.` : "Renouvellement arrêté.";
      return end ? `Prochain renouvellement le ${end}.` : "Abonnement en cours.";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "Paiement à régulariser : mettez à jour votre moyen de paiement.";
    case "canceled":
    case "incomplete_expired": {
      const at = longDate(sub.canceled_at, timeZone);
      return at ? `Abonnement résilié le ${at}.` : "Abonnement résilié.";
    }
    case "paused":
      return "Abonnement en pause.";
    default:
      return "État de l'abonnement inconnu : contactez l'équipe Rydar.";
  }
}

/** Consommation : barre pour une limite chiffrée, « Illimité » en texte sinon. */
function Meter({ label, used, max }: { label: string; used: number; max: number | null | undefined }) {
  const limited = typeof max === "number" && max > 0;
  const pct = limited ? Math.min(100, (used / max) * 100) : 0;
  const tone = pct >= 90 ? "bg-red" : pct >= 70 ? "bg-amber" : "bg-brand";
  return (
    <div>
      <div className="mb-1.5 flex justify-between gap-3 text-[13px]">
        <span className="text-fg-muted">{label}</span>
        <span className="num text-fg">
          {used}
          <span className="text-fg-muted">{limited ? ` / ${max}` : ` · illimité`}</span>
        </span>
      </div>
      {limited && (
        <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden>
          <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * `bookingSitesEnabled` : interrupteur plateforme des mini-sites (super admin) ; coupé = mini-site et domaine personnalisé
 * signalés indisponibles, quelle que soit l'offre. `onlinePayment` : paiement en ligne configuré sur le serveur
 * (sinon /api/billing/checkout répond 503). `checkoutSuccess` : retour de Stripe après un paiement (?checkout=success).
 * `privateFleet` (docs/FLOTTE-PRIVEE.md § 7.6) : seulement l'offre attribuée par l'équipe Rydar (même non publique,
 * `plans` ne contient qu'elle), factures et portail ; sans offre : « Abonnement géré par l'équipe Rydar ».
 */
export function BillingPanel({
  plans,
  currentPlanId,
  usage,
  subscription,
  invoices,
  isOwner,
  bookingSitesEnabled,
  privateFleet = false,
  onlinePayment = true,
  checkoutSuccess = false,
  timezone = "Europe/Paris",
}: {
  plans: BillingPlan[];
  currentPlanId: string | null;
  usage: BillingUsage;
  subscription: BillingSubscription | null;
  invoices: BillingInvoice[];
  isOwner: boolean;
  bookingSitesEnabled: boolean;
  privateFleet?: boolean;
  onlinePayment?: boolean;
  checkoutSuccess?: boolean;
  timezone?: string;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [interval, setInterval] = useState<"month" | "year">(subscription?.billing_interval === "year" ? "year" : "month");
  const call = async (url: string, body?: unknown) => {
    setLoading(url + JSON.stringify(body ?? ""));
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    setLoading(null);
    if (!res.ok || !json.url) return void toast.error(json.error ?? "Action impossible");
    window.location.href = json.url;
  };
  const limits: Limits = usage?.limits ?? {};
  const freeMonths = annualFreeMonths(plans);
  const subscribed = !!subscription?.stripe_subscription_id && LIVE_SUBSCRIPTION.has(subscription.status);
  const canManage = isOwner && !!subscription?.stripe_subscription_id;
  const current = plans.find((p) => p.id === currentPlanId) ?? null;
  const subInterval = subscription?.billing_interval === "year" ? "year" : "month";
  const status = subscription ? subscriptionStatus(subscription.status) : null;
  /** Offre payable en ligne pour cette périodicité (prix Stripe et paiement configuré) */
  const payableFor = (p: BillingPlan, i: "month" | "year") => onlinePayment && !!(i === "year" ? p.stripe_price_yearly_id : p.stripe_price_monthly_id);
  const anyPayable = plans.some((p) => payableFor(p, "month") || payableFor(p, "year"));
  // Flotte Privée : bascule Mensuel / Annuel seulement si son offre est payable en ligne
  const showInterval = plans.length > 0 && (!privateFleet || anyPayable);

  // Flotte Privée : les points forts de l'offre attribuée sont ceux que la base lui donne (limites effectives), jamais
  // ceux des offres publiques (mini-site, nombre de chauffeurs, « Tout Starter »…)
  const privateFleetFeatures = privateFleetPlanFeatures(usage?.limits ?? null);
  const options = (
    [
      ["API de réservation", limits.api_access, false],
      ["Mini-site", limits.booking_site, true],
      ["Domaine personnalisé", limits.custom_domain, true],
      ["Statistiques avancées", limits.advanced_stats, false],
    ] as [string, unknown, boolean][]
  )
    // Flotte Privée : son site est relié par l'API (aucun mini-site)
    .filter(([, , site]) => !privateFleet || !site);

  const planCards = (
    <div className="grid gap-4 lg:grid-cols-3">
      {plans.map((p) => {
        // Flotte Privée : l'offre attribuée est payable tant qu'aucun abonnement n'est en cours (Checkout verrouillé sur elle)
        const isCurrent = privateFleet ? subscribed && p.id === currentPlanId : p.id === currentPlanId;
        const payable = payableFor(p, interval);
        const highlighted = p.highlighted && !privateFleet;
        // Prix EXACT de l'offre, hors taxes (CGV art. 4 : « celui affiché dans l'offre au moment de la souscription » ;
        // jamais arrondi à l'euro) : mensuel, ou annuel (avec son équivalent mensuel, au centime)
        const yearly = interval === "year";
        const key = "/api/billing/checkout" + JSON.stringify({ planCode: p.code, interval });
        return (
          <div key={p.id} className={cn("surface relative flex flex-col rounded-2xl p-6", highlighted && "border-brand/40 shadow-glow")}>
            {highlighted && <span className="absolute -top-2.5 left-6 rounded-full bg-brand px-2.5 py-0.5 text-[12px] font-semibold text-brand-fg">Le plus choisi</span>}
            <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
              {p.name}
              {isCurrent && <Badge tone="brand">Votre offre</Badge>}
            </p>
            {p.description && <p className="mt-1 text-[13px] text-fg-muted">{p.description}</p>}
            <p className="mt-5">
              <span className="text-[34px] font-semibold tracking-tight">{formatPrice(yearly ? p.price_yearly_cents : p.price_monthly_cents)}</span>
              <span className="text-[13px] text-fg-muted"> HT / {yearly ? "an" : "mois"}</span>
            </p>
            {yearly && p.price_yearly_cents > 0 && (
              <p className="mt-0.5 text-[12.5px] text-fg-muted">soit {formatPrice(Math.round(p.price_yearly_cents / 12))} HT / mois, TVA en sus</p>
            )}
            {!yearly && <p className="mt-0.5 text-[12.5px] text-fg-muted">TVA en sus</p>}
            <ul className="mt-5 flex-1 space-y-2">
              {(privateFleet ? privateFleetFeatures : (p.features ?? [])).map((f) => (
                <li key={f} className="flex items-start gap-2 text-[13px] text-fg-muted">
                  <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-brand" /> {f}
                </li>
              ))}
            </ul>
            <div className="mt-6">
              {isCurrent ? (
                <Button className="w-full" variant="outline" disabled>
                  Offre actuelle
                </Button>
              ) : subscribed ? (
                <p className="text-center text-[13px] text-fg-muted">
                  Pour changer d&apos;offre, utilisez «{NB}Gérer mon abonnement{NB}».
                </p>
              ) : payable && isOwner ? (
                <Button
                  className="w-full"
                  variant={highlighted || privateFleet ? "primary" : "secondary"}
                  loading={loading === key}
                  onClick={() => call("/api/billing/checkout", { planCode: p.code, interval })}
                >
                  {privateFleet ? "S'abonner à cette offre" : "Choisir cette offre"}
                </Button>
              ) : payable ? (
                <p className="text-center text-[13px] text-fg-muted">Souscription réservée au propriétaire du compte.</p>
              ) : (
                <p className="text-center text-[13px] text-fg-muted">Abonnement géré par l&apos;équipe Rydar.</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-6">
      {checkoutSuccess && (
        <Callout tone="success" title={`Paiement reçu${NB}: votre abonnement s'active dans quelques instants.`}>
          La page se met à jour d&apos;elle-même au prochain chargement.
        </Callout>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <CardHeader
            title="Votre abonnement"
            icon={<CreditCard />}
            description={statusLine(subscription, timezone)}
            action={status ? <Badge tone={status.tone}>{status.label}</Badge> : <Badge tone="neutral">Sans abonnement en ligne</Badge>}
          />
          <CardBody className="space-y-5">
            <div>
              <p className="text-[16px] font-semibold text-fg">{current?.name ?? (currentPlanId ? "Offre personnalisée" : "Aucune offre attribuée")}</p>
              {current && (
                <p className="mt-0.5 text-[13px] text-fg-muted">
                  <span className="num text-fg">{formatPrice(subInterval === "year" ? current.price_yearly_cents : current.price_monthly_cents)}</span> HT /{" "}
                  {subInterval === "year" ? "an" : "mois"}, TVA en sus
                </p>
              )}
              {!current && currentPlanId && <p className="mt-0.5 text-[13px] text-fg-muted">Offre attribuée par l&apos;équipe Rydar.</p>}
            </div>

            {canManage && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <Button size="sm" variant="outline" loading={loading === "/api/billing/portal\"\""} onClick={() => call("/api/billing/portal")} className="max-sm:min-h-11">
                  Gérer mon abonnement <ExternalLink aria-hidden />
                </Button>
                <span className="text-[12.5px] text-fg-muted">Paiement, factures, résiliation</span>
              </div>
            )}
            {!isOwner && (
              <p className="text-[13px] text-fg-muted">Seul le propriétaire du compte peut souscrire, changer d&apos;offre ou résilier.</p>
            )}

            <div className="space-y-4 border-t border-line pt-4">
              {!privateFleet && <Meter label="Chauffeurs" used={usage?.drivers ?? 0} max={limits.max_drivers} />}
              <Meter label={privateFleet ? "Réservations ce mois-ci" : "Courses ce mois-ci"} used={usage?.rides_this_month ?? 0} max={limits.max_rides_per_month} />
              {!privateFleet && <Meter label="Administrateurs" used={usage?.admins ?? 0} max={limits.max_admins} />}
            </div>
            <ul className="flex flex-wrap gap-2" aria-label="Options de votre offre">
              {options.map(([label, on, site]) =>
                on && site && !bookingSitesEnabled ? (
                  <li key={label}>
                    <Badge tone="amber">{label} · indisponible</Badge>
                  </li>
                ) : (
                  <li key={label}>
                    <span
                      className={cn(
                        "inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[12px] font-medium",
                        on ? "bg-green/[0.1] text-green" : "bg-white/[0.05] text-fg-muted",
                      )}
                    >
                      {on ? <Check aria-hidden className="size-3.5" /> : <Minus aria-hidden className="size-3.5" />}
                      {label}
                      <span className="-m-px inline-block size-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]">{on ? " : inclus" : " : non inclus"}</span>
                    </span>
                  </li>
                ),
              )}
            </ul>
            {!bookingSitesEnabled && !privateFleet && (
              <p className="text-[13px] leading-relaxed text-fg-muted">
                {ERROR_MESSAGES.BOOKING_SITES_DISABLED} Vos réglages sont conservés&nbsp;; les réservations par le tableau de bord et par
                l&apos;API ne sont pas concernées.
                {!!subscription && (limits.booking_site || limits.custom_domain) && (
                  <>
                    {" "}
                    Cette fonction étant comprise dans votre offre, vous pouvez, pendant la suspension, changer d&apos;offre ou résilier sans
                    frais, avec remboursement au prorata de l&apos;abonnement payé d&apos;avance (CGV, article 9&nbsp;bis).
                  </>
                )}
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Factures" />
          {!invoices.length ? (
            <EmptyState size="compact" title="Aucune facture pour l'instant." />
          ) : (
            <ul className="divide-y divide-line">
              {invoices.map((i) => {
                const st = invoiceStatus(i.status);
                const date = longDate(i.period_start ?? i.created_at, timezone);
                return (
                  <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-[13px]">
                    <div className="flex min-w-0 flex-1 basis-[12rem] flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="num font-medium text-fg">{i.number ?? "Facture"}</span>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-fg-muted">{date}</span>
                      <span className="num font-semibold text-fg">{formatPrice(i.amount_due_cents, i.currency)}</span>
                      {i.hosted_invoice_url ? (
                        <a
                          href={i.hosted_invoice_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex min-h-11 items-center gap-1 text-fg-muted hover:text-fg sm:min-h-0"
                        >
                          Voir
                          <ExternalLink aria-hidden className="size-3.5" />
                          <span className="-m-px inline-block size-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]"> la facture {i.number ?? ""}</span>
                          <NewTabHint />
                        </a>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <section aria-labelledby="offres-titre" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="offres-titre" className="text-[15px] font-semibold">
            {privateFleet ? "Votre offre" : "Offres Rydar Drive"}
          </h2>
          {showInterval && (
            // Choix exposé (aria-pressed) et visible autrement que par une nuance de fond : contour lime (WCAG 1.4.11)
            <div role="group" aria-label="Périodicité des prix" className="flex rounded-lg border border-line bg-ink-850 p-0.5 text-[13px]">
              {(["month", "year"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={interval === v}
                  onClick={() => setInterval(v)}
                  className={cn("min-h-9 rounded-md px-3", interval === v ? "bg-ink-600 text-fg ring-1 ring-brand/60" : "text-fg-muted hover:text-fg")}
                >
                  {v === "month" ? "Mensuel" : freeMonths ? `Annuel · ${freeMonths} mois offert${freeMonths > 1 ? "s" : ""}` : "Annuel"}
                </button>
              ))}
            </div>
          )}
        </div>
        {!bookingSitesEnabled && !privateFleet && (
          <p className="text-[13px] text-fg-muted">Mini-site de réservation momentanément indisponible, quelle que soit l&apos;offre.</p>
        )}
        {privateFleet && !plans.length && <Callout tone="neutral">Abonnement géré par l&apos;équipe Rydar.</Callout>}
        {subscribed && plans.length > 0 ? (
          <Disclosure title="Comparer les offres" hint={<span className="text-[12.5px] font-normal text-fg-muted">changement par «{NB}Gérer mon abonnement{NB}»</span>} contentClassName="pt-2">
            {planCards}
          </Disclosure>
        ) : (
          planCards
        )}
        {/* Conditions présentées avant tout engagement (C. civ. 1119) : le paiement est refusé tant que les CGV en vigueur
            ne sont pas acceptées au nom de l'organisation (/api/billing/checkout) */}
        <p className="text-[13px] leading-relaxed text-fg-muted">
          En choisissant une offre, vous souscrivez un abonnement au nom de votre organisation, selon les{" "}
          <Link href="/cgv" prefetch={false} className="text-fg underline underline-offset-2">
            conditions générales de vente
          </Link>{" "}
          et l&apos;
          <Link href="/dpa" prefetch={false} className="text-fg underline underline-offset-2">
            accord de traitement des données
          </Link>
          , acceptés au préalable par le propriétaire ou un administrateur. Arrêt du renouvellement, résiliation et remboursement{NB}:{" "}
          <Link href="/abonnement-resiliation" prefetch={false} className="text-fg underline underline-offset-2">
            Abonnement, résiliation et remboursement
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
