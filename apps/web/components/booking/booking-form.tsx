"use client";
import {
  decodePolyline, formatDistance, formatDuration, formatPrice, VEHICLE_CATEGORY_META, type VehicleCategory,
} from "@rydar/shared";
import { CalendarClock, Check, Minus, Plane, Plus, ShieldCheck, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { submitBooking } from "@/app/book/[slug]/actions";
import { dayInZone, foreignZoneName, zonedInstant } from "@/components/booking/zoned-time";
import { RoutePreview } from "@/components/map/route-preview";
import { AddressInput, type PlaceValue } from "@/components/rides/address-input";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { NewTabHint } from "@/components/ui/new-tab";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";

const empty: PlaceValue = { address: "", lat: null, lng: null };

/** Compteur (passagers, bagages) : groupe nommé, boutons explicites, valeur annoncée quand elle change. */
function Counter({ value, set, min, max, label, unit }: { value: number; set: (v: number) => void; min: number; max: number; label: string; unit: string }) {
  return (
    <div role="group" aria-label={label} className="flex h-11 items-center justify-between rounded-lg border border-line-strong bg-ink-850 px-1.5">
      <button type="button" onClick={() => set(Math.max(min, value - 1))} disabled={value <= min} className="grid size-8 place-items-center rounded-md text-fg-muted hover:bg-white/5 disabled:opacity-40" aria-label={`Un ${unit} de moins`}><Minus aria-hidden className="size-4" /></button>
      <span className="num text-[16px] font-semibold" aria-live="polite">{value}</span>
      <button type="button" onClick={() => set(Math.min(max, value + 1))} disabled={value >= max} className="grid size-8 place-items-center rounded-md text-fg-muted hover:bg-white/5 disabled:opacity-40" aria-label={`Un ${unit} de plus`}><Plus aria-hidden className="size-4" /></button>
    </div>
  );
}

export function BookingForm({
  slug, categories, timeZone = "Europe/Paris", showPrice, phone, near, operator, privacyUrl, conditions,
}: {
  slug: string;
  categories: VehicleCategory[];
  /** Fuseau de la centrale : l'heure saisie est l'heure locale du départ, quel que soit le pays du visiteur */
  timeZone?: string;
  showPrice: boolean;
  phone?: string | null;
  near?: { lat: number; lng: number } | null;
  /** Centrale qui organise la course (destinataire des coordonnées) */
  operator?: string;
  /** Politique de confidentialité (adresse absolue de la plateforme) */
  privacyUrl?: string;
  /** Conditions de la centrale pour ses clients (réservation, annulation, paiement, médiateur), saisies par elle */
  conditions?: string | null;
}) {
  const [pickup, setPickup] = useState<PlaceValue>(empty);
  const [dropoff, setDropoff] = useState<PlaceValue>(empty);
  const [when, setWhen] = useState<"now" | "scheduled">("scheduled");
  const [date, setDate] = useState(() => dayInZone(new Date(Date.now() + 86_400_000), timeZone));
  const [time, setTime] = useState("08:00");
  const [category, setCategory] = useState<VehicleCategory>(categories[0] ?? "standard");
  const [passengers, setPassengers] = useState(1);
  const [luggage, setLuggage] = useState(1);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ number: number; priced: boolean } | null>(null);
  const [pending, start] = useTransition();

  const pickupAt = when === "now" ? new Date() : zonedInstant(date, time, timeZone);
  const formRef = useRef<HTMLFormElement>(null);
  // Devis de la saisie EN COURS seulement (clé des paramètres) : un ancien prix n'est jamais proposé à la réservation
  const quoteKey = JSON.stringify([pickup.lat, pickup.lng, pickup.address, dropoff.lat, dropoff.lng, dropoff.address, category, when, date, time]);
  const [quote, setQuote] = useState<{ key: string; distanceM: number; durationS: number; polyline: string; priceCents: number | null; fixedFare: string | null } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  // Visiteur dans un autre fuseau (voyageur) : l'heure à saisir est celle du lieu de départ
  const [zoneHint, setZoneHint] = useState<string | null>(null);
  const ready = pickup.lat != null && pickup.lng != null && dropoff.lat != null && dropoff.lng != null;

  useEffect(() => {
    const name = foreignZoneName(timeZone);
    setZoneHint(name ? `Heure locale du départ (${name})` : null);
  }, [timeZone]);

  // Devis réel : itinéraire routier + prix indicatif (forfait / grille) calculés par le serveur
  useEffect(() => {
    setQuoteError(null);
    if (!ready) {
      setQuote(null);
      return;
    }
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      fetch(`/api/book/${slug}/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          pickup: { lat: pickup.lat, lng: pickup.lng, address: pickup.address },
          dropoff: { lat: dropoff.lat, lng: dropoff.lng, address: dropoff.address },
          category,
          pickupAt: pickupAt?.toISOString(),
        }),
      })
        .then(async (r) => {
          const q = await r.json().catch(() => null);
          if (r.status === 422 && q?.error) setQuoteError(q.error as string);
          return r.ok ? q : null;
        })
        .then((q) => setQuote(q ? { ...q, key: quoteKey } : null))
        .catch(() => undefined);
    }, 250);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [ready, pickup.lat, pickup.lng, dropoff.lat, dropoff.lng, category, when, date, time, slug]);
  const routeCoords = useMemo(() => (quote?.polyline ? decodePolyline(quote.polyline) : null), [quote?.polyline]);
  // Prix affiché pour la saisie en cours : seul un prix affiché engage le client (« Réserver avec obligation de
  // paiement », C. conso. L221-14) ; sinon la demande part sans prix et la centrale le confirme au client
  const estimate = showPrice && quote?.key === quoteKey ? (quote.priceCents ?? null) : null;
  const priced = estimate != null;
  const centrale = operator ?? "la centrale";

  if (done !== null) {
    return (
      <div className="flex flex-col items-center px-6 py-14 text-center">
        <div className="relative mb-6 grid size-16 place-items-center">
          <span className="absolute inset-0 animate-ping-ring rounded-full border border-brand/60" />
          <span className="grid size-14 place-items-center rounded-full bg-brand text-brand-fg"><Check aria-hidden className="size-7" strokeWidth={3} /></span>
        </div>
        <DoneTitle>{done.priced ? "Réservation reçue" : "Demande reçue"}</DoneTitle>
        {done.number > 0 && <p className="num mt-2 text-[14px] text-fg-muted">Référence #{done.number}</p>}
        <p className="mt-4 max-w-sm text-[14px] leading-relaxed text-fg-muted">
          Votre demande est transmise à {centrale}
          {done.priced ? "." : ", qui vous confirme le prix avant la course."}
          {phone ? ` Pour toute question, appelez le ${phone}.` : ""}
        </p>
        <Button variant="outline" className="mt-8" onClick={() => { setDone(null); setPickup(empty); setDropoff(empty); }}>Nouvelle réservation</Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-5 p-6"
      ref={formRef}
      onSubmit={submitWith((f) => {
        setError(null);
        if (pickup.lat == null || dropoff.lat == null) {
          setErrors({ pickup: pickup.lat == null ? "Choisissez une adresse dans la liste" : "", dropoff: dropoff.lat == null ? "Choisissez une adresse dans la liste" : "" });
          // Focus sur la première adresse en erreur (son message lui est relié par Field)
          formRef.current?.querySelector<HTMLInputElement>(`[data-field="${pickup.lat == null ? "pickup" : "dropoff"}"] input`)?.focus();
          return;
        }
        const expectedPriceCents = estimate;
        start(() => runAction(async () => {
          const res = await submitBooking(slug, {
            pickup: { address: pickup.address, lat: pickup.lat!, lng: pickup.lng! },
            dropoff: { address: dropoff.address, lat: dropoff.lat!, lng: dropoff.lng! },
            when,
            pickupAt: when === "scheduled" ? (zonedInstant(date, time, timeZone) ?? undefined) : undefined,
            customerName: String(f.get("name") ?? ""),
            customerPhone: String(f.get("phone") ?? ""),
            customerEmail: String(f.get("email") ?? ""),
            passengers,
            luggage,
            vehicleCategory: category,
            flightNumber: String(f.get("flight") ?? ""),
            comment: String(f.get("comment") ?? ""),
            website: String(f.get("website") ?? ""),
            expectedPriceCents,
          } as never);
          if (!res.ok) {
            if ("code" in res && res.code === "PRICE_CHANGED") {
              // Nouveau prix affiché (ou plus de prix : demande sans engagement) avant toute nouvelle confirmation
              setQuote((q) => (q && q.key === quoteKey ? { ...q, priceCents: res.priceCents } : q));
              setErrors({});
            } else setErrors(("fieldErrors" in res && res.fieldErrors) || {});
            setError(res.error);
          } else setDone({ number: res.number, priced: expectedPriceCents != null });
        }, setError));
      })}
    >
      {/* Conditions de la centrale (identité, moyens de paiement acceptés, annulation, médiateur) dès le début de la
          commande (C. conso. L221-14 : moyens de paiement « au plus tard au début du processus de commande ») */}
      {conditions && (
        <div className="space-y-1 rounded-lg border border-line px-3 py-2.5 text-[12px] leading-relaxed text-fg-muted">
          <p className="font-medium text-fg">Conditions de {centrale} (paiement, annulation)</p>
          <p className="whitespace-pre-line">{conditions}</p>
        </div>
      )}

      <div className="space-y-2.5">
        <div data-field="pickup">
          <Field label="Départ" error={errors.pickup}><AddressInput labelled marker="pickup" value={pickup} onChange={setPickup} near={near} placeholder="Adresse de prise en charge" /></Field>
        </div>
        <div data-field="dropoff">
          <Field label="Destination" error={errors.dropoff}><AddressInput labelled marker="dropoff" value={dropoff} onChange={setDropoff} near={pickup.lat != null && pickup.lng != null ? { lat: pickup.lat, lng: pickup.lng } : near} placeholder="Aéroport, gare, adresse…" /></Field>
        </div>
      </div>

      <div role="group" aria-label="Moment de la prise en charge" className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-ink-850 p-1">
        {([["now", "Dès que possible", Zap], ["scheduled", "Réserver à l'avance", CalendarClock]] as const).map(([k, label, Icon]) => (
          <button key={k} type="button" aria-pressed={when === k} onClick={() => setWhen(k)} className={cn("flex h-10 items-center justify-center gap-2 rounded-lg text-[13px] font-medium", when === k ? "bg-ink-600 text-fg" : "text-fg-muted")}>
            <Icon aria-hidden className={cn("size-4", when === k && "text-brand")} /> {label}
          </button>
        ))}
      </div>
      {when === "scheduled" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" error={errors.pickupAt}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-11 [color-scheme:dark]" /></Field>
          <Field label="Heure"><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-11 [color-scheme:dark]" /></Field>
          {zoneHint && <p className="col-span-2 -mt-1 text-[12px] text-fg-muted">{zoneHint}</p>}
        </div>
      )}

      <div role="group" aria-label="Catégorie de véhicule" className={cn("grid gap-2", categories.length > 2 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2")}>
        {categories.map((c) => (
          <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)} className={cn("rounded-xl border px-3 py-2.5 text-left", category === c ? "border-brand/60 bg-brand/[0.07]" : "border-line hover:border-line-strong")}>
            <span className={cn("block text-[13px] font-semibold", category === c ? "text-brand" : "text-fg")}>{VEHICLE_CATEGORY_META[c].label}</span>
            <span className="block text-[11px] text-fg-subtle">jusqu&apos;à {VEHICLE_CATEGORY_META[c].seats} pers.</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Passagers"><Counter value={passengers} set={setPassengers} min={1} max={8} label="Passagers" unit="passager" /></Field>
        <Field label="Bagages"><Counter value={luggage} set={setLuggage} min={0} max={10} label="Bagages" unit="bagage" /></Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nom" error={errors.customerName}><Input name="name" required autoComplete="name" className="h-11" /></Field>
        <Field label="Téléphone" error={errors.customerPhone}><Input name="phone" required inputMode="tel" autoComplete="tel" className="h-11" /></Field>
        <Field label="E-mail" optional error={errors.customerEmail}><Input name="email" type="email" autoComplete="email" className="h-11" /></Field>
        <Field label={<span className="flex items-center gap-1.5"><Plane aria-hidden className="size-3.5" /> N° de vol</span>} optional error={errors.flightNumber}><Input name="flight" className="h-11 uppercase" /></Field>
      </div>
      <Field label="Précisions" optional><Textarea name="comment" placeholder="Siège enfant, pancarte, arrêt intermédiaire…" /></Field>
      <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden />

      {ready && (
        <div className="overflow-hidden rounded-xl border border-line">
          <div className="relative h-52">
            <RoutePreview pickup={{ lat: pickup.lat!, lng: pickup.lng! }} dropoff={{ lat: dropoff.lat!, lng: dropoff.lng! }} route={routeCoords} padding={36} />
          </div>
          <div className="flex items-center justify-between bg-white/[0.02] px-4 py-3">
            <span className="text-[13px] text-fg-muted">
              {quote ? (
                <>
                  <span className="num text-fg">{formatDistance(quote.distanceM)}</span> · <span className="num text-fg">{formatDuration(quote.durationS)}</span> de trajet
                </>
              ) : quoteError ? (
                <span className="text-amber">{quoteError}</span>
              ) : (
                "Calcul de l'itinéraire…"
              )}
            </span>
            {estimate != null && (
              <span className="text-right">
                <span className="block text-[11.5px] text-fg-subtle">{quote?.fixedFare ? `Forfait ${quote.fixedFare}, TTC` : "Prix TTC"}</span>
                <span className="num text-[20px] font-semibold text-brand">{formatPrice(estimate)}</span>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Information (RGPD art. 13) plutôt qu'une case à cocher : les coordonnées servent à exécuter la course demandée */}
      <p className="text-[12px] leading-relaxed text-fg-muted">
        Vos coordonnées sont transmises à {centrale}, qui organise la course, et servent uniquement à cette
        réservation (aucun compte n&apos;est créé).
        {privacyUrl && (
          <>
            {" "}
            <a href={privacyUrl} target="_blank" rel="noopener" className="text-fg underline underline-offset-2">
              Données personnelles
              <NewTabHint />
            </a>
          </>
        )}
      </p>
      {error && (
        <p role="alert" className="rounded-lg border border-red/25 bg-red/10 px-3 py-2 text-[13px] text-red">
          {error}
        </p>
      )}
      {/* Code de la consommation L221-14 (gardé pour le transport de passagers par L221-2, 9° ; directive 2011/83 art. 8.2) :
          prix affiché → le bouton qui passe la commande dit clairement qu'elle oblige à payer CE prix, rappelé juste
          avant ; sans prix affiché (grille masquée, devis indisponible ou en cours) → simple demande, sans engagement */}
      {priced ? (
        <p className="text-[13px] text-fg-muted">
          Prix de la course{quote?.fixedFare ? ` (forfait ${quote.fixedFare})` : ""}&nbsp;:{" "}
          <span className="num font-semibold text-fg">{formatPrice(estimate)} TTC</span>, payable à {centrale}.
        </p>
      ) : (
        <p className="text-[13px] text-fg-muted">
          Sans engagement&nbsp;: {centrale} vous confirme le prix avant la course.
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" loading={pending} className="h-auto min-h-11 w-full whitespace-normal py-2.5 text-center">
        {priced ? "Réserver avec obligation de paiement" : "Envoyer ma demande de réservation"}
      </Button>
      <p className="flex items-center justify-center gap-1.5 text-[11.5px] text-fg-subtle"><ShieldCheck aria-hidden className="size-3.5" /> Demande transmise aussitôt à {centrale}</p>
    </form>
  );
}

/**
 * Titre de la confirmation : le formulaire (et son bouton, qui avait le focus) disparaît ; le titre reçoit le focus
 * pour que la confirmation soit lue (WCAG 4.1.3, 2.4.3).
 */
function DoneTitle({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <h3 ref={ref} tabIndex={-1} className="text-[22px] font-semibold tracking-tight outline-none">
      {children}
    </h3>
  );
}
