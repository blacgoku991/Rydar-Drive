"use client";
import { ERROR_MESSAGES, formatDate, formatPrice } from "@rydar/shared";
import { Check, CreditCard, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

function Meter({ label, used, max }: { label: string; used: number; max: number | null | undefined }) {
  const pct = max ? Math.min(100, (used / max) * 100) : 0;
  const tone = pct >= 90 ? "bg-red" : pct >= 70 ? "bg-amber" : "bg-brand";
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-[12.5px]">
        <span className="text-fg-muted">{label}</span>
        <span className="num text-fg">
          {used}
          <span className="text-fg-subtle"> / {max ?? "∞"}</span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        <div className={cn("h-full rounded-full", max ? tone : "bg-brand/40")} style={{ width: max ? `${pct}%` : "100%" }} />
      </div>
    </div>
  );
}

/** `bookingSitesEnabled` : interrupteur plateforme des mini-sites (super admin) ; coupé = mini-site et domaine personnalisé
 *  signalés indisponibles, quelle que soit l'offre. */
export function BillingPanel({ plans, currentPlanId, usage, subscription, invoices, isOwner, bookingSitesEnabled }: { plans: any[]; currentPlanId: string | null; usage: any; subscription: any; invoices: any[]; isOwner: boolean; bookingSitesEnabled: boolean }) {
  const [loading, setLoading] = useState<string | null>(null);
  const [interval, setInterval] = useState<"month" | "year">("month");
  const call = async (url: string, body?: unknown) => {
    setLoading(url + JSON.stringify(body ?? ""));
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    setLoading(null);
    if (!res.ok || !json.url) return void toast.error(json.error ?? "Action impossible");
    window.location.href = json.url;
  };
  const limits = usage?.limits ?? {};
  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardHeader
            title="Votre consommation"
            icon={<CreditCard />}
            description={subscription ? `Abonnement ${subscription.status === "active" ? "actif" : subscription.status} · renouvellement ${formatDate(subscription.current_period_end)}` : "Aucun abonnement Stripe"}
            action={isOwner ? <Button size="sm" variant="outline" onClick={() => call("/api/billing/portal")}>Gérer <ExternalLink /></Button> : undefined}
          />
          <CardBody className="space-y-4">
            <Meter label="Chauffeurs" used={usage?.drivers ?? 0} max={limits.max_drivers} />
            <Meter label="Courses ce mois-ci" used={usage?.rides_this_month ?? 0} max={limits.max_rides_per_month} />
            <Meter label="Administrateurs" used={usage?.admins ?? 0} max={limits.max_admins} />
            <div className="flex flex-wrap gap-2 pt-1">
              {(
                [
                  ["API de réservation", limits.api_access, false],
                  ["Mini-site", limits.booking_site, true],
                  ["Domaine personnalisé", limits.custom_domain, true],
                  ["Statistiques avancées", limits.advanced_stats, false],
                ] as [string, unknown, boolean][]
              ).map(([l, on, site]) =>
                on && site && !bookingSitesEnabled ? (
                  <Badge key={l} tone="amber">{l} · indisponible</Badge>
                ) : (
                  <Badge key={l} tone={on ? "green" : "neutral"}>{l}</Badge>
                ),
              )}
            </div>
            {!bookingSitesEnabled && (
              <p className="text-[12.5px] leading-relaxed text-fg-muted">
                {ERROR_MESSAGES.BOOKING_SITES_DISABLED} Vos réglages sont conservés&nbsp;; les réservations par le tableau de
                bord et par l&apos;API ne sont pas concernées.
              </p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Factures" />
          <div className="divide-y divide-line">
            {!invoices.length && <p className="px-5 py-6 text-[13px] text-fg-subtle">Aucune facture.</p>}
            {invoices.map((i) => (
              <div key={i.id} className="flex items-center justify-between px-5 py-3 text-[13px]">
                <span className="num text-fg">{i.number ?? "—"}</span>
                <span className="text-fg-muted">{formatDate(i.period_start)}</span>
                <span className="num font-semibold">{formatPrice(i.amount_due_cents, i.currency)}</span>
                <Badge tone={i.status === "paid" ? "green" : i.status === "payment_failed" ? "red" : "amber"}>{i.status === "paid" ? "Payée" : i.status === "payment_failed" ? "Échec" : i.status}</Badge>
                {i.hosted_invoice_url ? <a href={i.hosted_invoice_url} target="_blank" rel="noreferrer" className="text-fg-subtle hover:text-fg" aria-label={`Ouvrir la facture ${i.number ?? ""} (nouvel onglet)`}><ExternalLink aria-hidden className="size-4" /></a> : <span className="w-4" />}
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">Offres Rydar Drive</h2>
        <div className="flex rounded-lg border border-line bg-ink-850 p-0.5 text-[12.5px]">
          {(["month", "year"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setInterval(v)} className={cn("rounded-md px-3 py-1", interval === v ? "bg-ink-600 text-fg" : "text-fg-muted")}>
              {v === "month" ? "Mensuel" : "Annuel · 2 mois offerts"}
            </button>
          ))}
        </div>
      </div>
      {!bookingSitesEnabled && (
        <p className="-mt-2 text-[12.5px] text-fg-muted">Mini-site de réservation momentanément indisponible, quelle que soit l&apos;offre.</p>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        {plans.map((p) => {
          const current = p.id === currentPlanId;
          // Prix EXACT de l'offre, hors taxes (CGV art. 4 : « celui affiché dans l'offre au moment de la souscription » ;
          // jamais arrondi à l'euro) : mensuel, ou annuel (avec son équivalent mensuel, au centime)
          const yearly = interval === "year";
          return (
            <div key={p.id} className={cn("surface relative flex flex-col rounded-2xl p-6", p.highlighted && "border-brand/40 shadow-[0_0_0_1px_rgb(200_240_60/0.25),0_30px_80px_-40px_rgb(200_240_60/0.5)]")}>
              {p.highlighted && <span className="absolute -top-2.5 left-6 rounded-full bg-brand px-2.5 py-0.5 text-[11px] font-semibold text-brand-fg">Le plus choisi</span>}
              <p className="text-[15px] font-semibold">{p.name}</p>
              <p className="mt-1 text-[12.5px] text-fg-muted">{p.description}</p>
              <p className="mt-5">
                <span className="text-[34px] font-semibold tracking-tight">{formatPrice(yearly ? p.price_yearly_cents : p.price_monthly_cents)}</span>
                <span className="text-[13px] text-fg-subtle"> HT / {yearly ? "an" : "mois"}</span>
              </p>
              {yearly && p.price_yearly_cents > 0 && (
                <p className="mt-0.5 text-[12px] text-fg-subtle">soit {formatPrice(Math.round(p.price_yearly_cents / 12))} HT / mois, TVA en sus</p>
              )}
              {!yearly && <p className="mt-0.5 text-[12px] text-fg-subtle">TVA en sus</p>}
              <ul className="mt-5 flex-1 space-y-2">
                {(p.features ?? []).map((f: string) => (
                  <li key={f} className="flex items-start gap-2 text-[13px] text-fg-muted">
                    <Check className="mt-0.5 size-4 shrink-0 text-brand" /> {f}
                  </li>
                ))}
              </ul>
              <Button
                className="mt-6 w-full"
                variant={current ? "outline" : p.highlighted ? "primary" : "secondary"}
                disabled={current || !isOwner}
                loading={loading === "/api/billing/checkout" + JSON.stringify({ planCode: p.code, interval })}
                onClick={() => call("/api/billing/checkout", { planCode: p.code, interval })}
              >
                {current ? "Offre actuelle" : "Choisir cette offre"}
              </Button>
            </div>
          );
        })}
      </div>
      {/* Conditions présentées avant tout engagement (C. civ. 1119) : le paiement est refusé tant que les CGV en vigueur
          ne sont pas acceptées au nom de l'organisation (/api/billing/checkout) */}
      <p className="text-[12.5px] leading-relaxed text-fg-muted">
        En choisissant une offre, vous souscrivez un abonnement au nom de votre organisation, selon les{" "}
        <Link href="/cgv" prefetch={false} className="text-fg underline underline-offset-2">
          conditions générales de vente
        </Link>{" "}
        et l&apos;
        <Link href="/dpa" prefetch={false} className="text-fg underline underline-offset-2">
          accord de traitement des données
        </Link>
        , acceptés au préalable par le propriétaire ou un administrateur. Arrêt du renouvellement, résiliation et
        remboursement{"\u00a0"}:{" "}
        <Link href="/abonnement-resiliation" prefetch={false} className="text-fg underline underline-offset-2">
          Abonnement, résiliation et remboursement
        </Link>
        .
      </p>
    </div>
  );
}
