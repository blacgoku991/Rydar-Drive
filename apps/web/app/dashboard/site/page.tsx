import { contactHref, formatRelative, formatRideDate } from "@rydar/shared";
import { ChevronRight, Globe, KeyRound, Tag, Webhook } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageBody, PageHeader, StatCard } from "@/components/layout/page-header";
import { bookingKind, bookingKindMeta, bookingPrice, bookingRoute, rideDateAt } from "@/components/private-fleet/booking-meta";
import { BOOKING_COLUMNS, OFFER_EMBED, toBooking, type BookingRow } from "@/components/private-fleet/queue";
import {
  SITE_KEY_KIND_LABELS, originsLabel, siteKeyActive, siteKeyKind, siteLink, type SiteKeyRow, type SiteWebhookRow,
} from "@/components/private-fleet/site-status";
import { Badge, toneDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/misc";
import { requireOrg } from "@/lib/auth";
import { isPrivateFleet } from "@/lib/private-fleet";
import { cn } from "@/lib/utils";
import { WEBHOOK_ENDPOINT_SELECT } from "@/lib/webhooks";

export const metadata: Metadata = { title: "Mon site" };
export const dynamic = "force-dynamic";

const NB = " ";
const KEY_COLUMNS = "id, name, prefix, last4, scopes, allowed_origins, created_at, last_used_at, expires_at, revoked_at";

/**
 * « Mon site » (Flotte Privée, docs/FLOTTE-PRIVEE.md § 7.3) : site du client relié par l'API v1, en LECTURE SEULE —
 * clés et webhooks gérés par l'équipe Rydar (D16). État (dernier contact, dernière réservation), réservations reçues sur
 * 30 jours, liens vers les tarifs et la demande de modification ; détails techniques repliés (clés, adresses, webhooks).
 * Organisation standard : « API & site web ».
 */
export default async function SitePage() {
  const ctx = await requireOrg();
  if (!isPrivateFleet(ctx.org)) redirect("/dashboard/integrations");
  const now = Date.now();
  const tz = ctx.org.timezone || "Europe/Paris";
  const since = new Date(now - 30 * 86_400_000).toISOString();
  const [keysRes, hooksRes, ridesRes] = await Promise.all([
    // RLS : owner / admin (le propriétaire) ; jamais la clé elle-même (empreinte en table *_secrets)
    ctx.supabase.from("api_keys").select(KEY_COLUMNS).eq("organization_id", ctx.org.id).order("created_at", { ascending: false }),
    ctx.supabase.from("webhook_endpoints").select(WEBHOOK_ENDPOINT_SELECT).eq("organization_id", ctx.org.id).order("created_at", { ascending: true }),
    ctx.supabase
      .from("rides")
      .select(`${BOOKING_COLUMNS}, ${OFFER_EMBED}`, { count: "exact" })
      .eq("organization_id", ctx.org.id)
      .eq("source", "api")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(10),
  ]);
  const keys = (keysRes.data ?? []) as SiteKeyRow[];
  const hooks = (hooksRes.data ?? []) as unknown as SiteWebhookRow[];
  const link = siteLink(keys, hooks, now);
  const recent = ((ridesRes.data ?? []) as unknown as BookingRow[]).map((r) => toBooking(r, ctx.driverId, now));
  const received = ridesRes.count ?? recent.length;
  const last = recent[0] ?? null;

  return (
    <>
      <PageHeader
        title="Mon site"
        description={`Votre site de réservation, relié par l'équipe Rydar${NB}: chaque réservation arrive ici et dans votre application.`}
      />
      <PageBody className="space-y-6">
        <Card>
          <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center">
            {/* Téléphone : l'icône laisse la place à l'état (pastille de couleur) */}
            <span aria-hidden className="hidden size-11 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-fg-muted sm:grid">
              <Globe className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-[15px] font-semibold text-fg [overflow-wrap:anywhere]">
                <span aria-hidden className={cn("size-2 shrink-0 rounded-full", toneDot[link.linked ? "green" : "amber"])} />
                {link.linked ? `Votre site${link.host ? ` ${link.host}` : ""} est relié` : "Votre site n'est pas encore relié"}
              </p>
              <p className="mt-0.5 text-[13px] text-fg-muted">
                {link.linked
                  ? `Dernier contact de votre site${NB}: ${link.lastUsedAt ? formatRelative(link.lastUsedAt, new Date(now)) : "jamais"} · dernière réservation${NB}: ${
                      last ? rideDateAt(last.created_at, tz, now) : "aucune sur 30 jours"
                    }`
                  : `L'équipe Rydar relie votre site à votre espace${NB}: vos réservations arriveront ici et dans l'application.`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="secondary" size="sm">
                <Link href="/dashboard/settings?tab=pricing" prefetch={false}>
                  <Tag /> Vos prix
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={contactHref("other")} prefetch={false}>
                  Demander une modification
                </Link>
              </Button>
            </div>
          </CardBody>
        </Card>

        <div className="grid max-w-xl grid-cols-2 gap-3">
          <StatCard label="Réservations reçues" value={received} sub="30 derniers jours" />
          <StatCard
            label="Dernière réservation reçue"
            value={last ? formatRelative(last.created_at, new Date(now)) : "—"}
            sub={last ? `#${last.number}, ${rideDateAt(last.created_at, tz, now)}` : "aucune sur 30 jours"}
          />
        </div>

        <Card className="overflow-hidden">
          <CardHeader
            title="Réservations du site"
            description="Les 10 dernières reçues sur 30 jours."
            action={
              <Button asChild variant="ghost" size="sm">
                <Link href="/dashboard/rides?filter=all" prefetch={false}>
                  Toutes<span className="sr-only">{`${NB}: réservations`}</span> <ChevronRight />
                </Link>
              </Button>
            }
          />
          {recent.length ? (
            <ul className="divide-y divide-line">
              {recent.map((b) => {
                const meta = bookingKindMeta(bookingKind(b, now));
                return (
                  <li key={b.id}>
                    {/* Deux lignes (lisibles sur téléphone) : numéro et trajet, puis date, réception et prix */}
                    <Link href={`/dashboard/rides/${b.id}`} prefetch={false} className="flex items-start gap-3 px-5 py-3 hover:bg-white/[0.025]">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] text-fg" title={`${b.pickup_address} → ${b.dropoff_address}`}>
                          <span className="num font-semibold">#{b.number}</span> · {bookingRoute(b)}
                        </span>
                        {/* Retour à la ligne entre les morceaux seulement (jamais « il y a » / « 11 h ») */}
                        <span className="mt-0.5 block text-[12.5px] text-fg-muted">
                          <span className="whitespace-nowrap">Pour {formatRideDate(b.pickup_at, tz, new Date(now)).toLowerCase()}</span> ·{" "}
                          <span className="whitespace-nowrap">reçue {formatRelative(b.created_at, new Date(now))}</span> ·{" "}
                          <span className={cn("whitespace-nowrap", b.price_cents == null ? "text-amber" : "num text-fg")}>{bookingPrice(b.price_cents, b.currency)}</span>
                        </span>
                      </span>
                      <Badge tone={meta.tone} className="shrink-0">
                        {meta.label}
                      </Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState size="compact" title="Aucune réservation reçue de votre site ces 30 derniers jours." />
          )}
        </Card>

        <Disclosure title="Détails techniques" hint="clés, adresses, webhooks" className="surface rounded-xl px-4 sm:px-5" contentClassName="space-y-6 pb-5 pt-1">
          <section aria-labelledby="site-keys">
            <h2 id="site-keys" className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-fg">
              <KeyRound aria-hidden className="size-4 text-fg-subtle" /> Clés du site
            </h2>
            {keys.length ? (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {keys.map((k) => {
                  const active = siteKeyActive(k, now);
                  const kind = siteKeyKind(k);
                  return (
                    <li key={k.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-[12.5px]">
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-fg">
                          {SITE_KEY_KIND_LABELS[kind]} · <span className="num">{k.prefix}…{k.last4 ?? ""}</span>
                        </span>
                        <span className="block text-fg-muted [overflow-wrap:anywhere]">
                          {kind === "browser" ? `Sites autorisés${NB}: ${originsLabel(k.allowed_origins)}` : "Utilisée par le serveur du site"} · dernière utilisation{" "}
                          {k.last_used_at ? formatRelative(k.last_used_at, new Date(now)) : "jamais"}
                        </span>
                      </span>
                      <Badge tone={active ? "green" : "neutral"}>{active ? "Active" : k.revoked_at ? "Révoquée" : "Expirée"}</Badge>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[12.5px] text-fg-muted">Aucune clé pour le moment.</p>
            )}
          </section>
          <section aria-labelledby="site-webhooks">
            <h2 id="site-webhooks" className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-fg">
              <Webhook aria-hidden className="size-4 text-fg-subtle" /> Notifications envoyées à votre site (webhooks)
            </h2>
            {hooks.length ? (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {hooks.map((w) => (
                  <li key={w.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-[12.5px]">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-fg" title={w.url}>
                        {w.url}
                      </span>
                      <span className="block text-fg-muted">
                        Dernier succès {w.last_success_at ? formatRelative(w.last_success_at, new Date(now)) : "jamais"} · dernier échec{" "}
                        {w.last_failure_at ? formatRelative(w.last_failure_at, new Date(now)) : "aucun"}
                      </span>
                    </span>
                    <Badge tone={w.enabled ? "green" : "neutral"}>{w.enabled ? "Active" : "Coupée"}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-fg-muted">Aucune adresse enregistrée.</p>
            )}
          </section>
        </Disclosure>
      </PageBody>
    </>
  );
}
