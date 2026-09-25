"use client";
import {
  decodePolyline, driverCollects, formatDistance, formatDuration, formatPrice, PAYMENT_METHOD_LABELS, PAYMENT_METHODS, VEHICLE_CATEGORIES,
  VEHICLE_CATEGORY_META, type Coord, type PricingRule, type VehicleCategory,
} from "@rydar/shared";
import { ArrowDownUp, Banknote, CalendarClock, Car, Clock3, Landmark, Minus, MousePointerClick, Plane, Plus, Route, Users, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { createRide } from "@/app/dashboard/rides/actions";
import { RoutePreview } from "@/components/map/route-preview";
import { AddressInput, type PlaceValue } from "@/components/rides/address-input";
import { useCentrale } from "@/components/settlements/centrale-context";
import { SplitPreview, centsToInput, eurosToCents, useSplitPreview } from "@/components/settlements/split-preview";
import { Button } from "@/components/ui/button";
import { Dialog, WorkspaceContent } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { FAVORITE_PLACES } from "@/lib/places";
import { cn } from "@/lib/utils";

const empty: PlaceValue = { address: "", lat: null, lng: null };

type Quote = {
  route: { distanceM: number; durationS: number; polyline: string; approximate: boolean } | null;
  priceCents: number | null;
  meteredCents: number | null;
  pricingRule: string | null;
  fixedFare: { label: string; price_cents: number } | null;
  nearby: { total: number; firstRadiusM: number; withinFirstRadius: number; drivers: { id: string; name: string; vehicle: string | null; lat: number; lng: number; distanceM: number; etaS: number }[] };
};

const QUICK_PLACES = ["Aéroport CDG — Terminal 2E", "Aéroport d'Orly — Terminal 4", "Gare de Lyon", "Gare du Nord", "La Défense — Parvis"]
  .map((l) => FAVORITE_PLACES.find((p) => p.label === l))
  .filter((p): p is (typeof FAVORITE_PLACES)[number] => !!p);

function Stepper({ value, onChange, min, max, label, icon: Icon }: { value: number; onChange: (v: number) => void; min: number; max: number; label: string; icon: typeof Users }) {
  return (
    <div className="flex h-10 min-w-0 items-center justify-between rounded-lg border border-line bg-ink-800 pl-3 pr-1">
      <span className="flex min-w-0 items-center gap-2 text-[13px] text-fg-muted" title={label}>
        <Icon className="size-4 shrink-0" /> <span className="truncate max-[419px]:sr-only">{label}</span>
      </span>
      <span className="flex shrink-0 items-center">
        <button type="button" aria-label={`Moins de ${label}`} onClick={() => onChange(Math.max(min, value - 1))} className="grid size-8 place-items-center rounded-md text-fg-muted hover:bg-white/5 hover:text-fg">
          <Minus className="size-3.5" />
        </button>
        <span className="w-5 text-center text-[14px] font-semibold tabular-nums">{value}</span>
        <button type="button" aria-label={`Plus de ${label}`} onClick={() => onChange(Math.min(max, value + 1))} className="grid size-8 place-items-center rounded-md text-fg-muted hover:bg-white/5 hover:text-fg">
          <Plus className="size-3.5" />
        </button>
      </span>
    </div>
  );
}

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

export function NewRideSheet({
  open,
  onOpenChange,
  pricing,
  onCreated,
  defaultPayment = "card",
  center,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pricing: PricingRule[];
  onCreated?: (ride: { id: string; number: number }) => void;
  defaultPayment?: string;
  /** Centre de la flotte (proximité des suggestions d'adresses) */
  center?: { lat: number; lng: number } | null;
}) {
  const tomorrow = toLocalInput(new Date(Date.now() + 24 * 3600_000));
  const [pickup, setPickup] = useState<PlaceValue>(empty);
  const [dropoff, setDropoff] = useState<PlaceValue>(empty);
  const [when, setWhen] = useState<"now" | "scheduled">("now");
  const [date, setDate] = useState(tomorrow.date);
  const [time, setTime] = useState("06:30");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [passengers, setPassengers] = useState(1);
  const [luggage, setLuggage] = useState(1);
  const [category, setCategory] = useState<VehicleCategory>("business");
  const [price, setPrice] = useState("");
  // Mode centrale : commission saisie à la course (vide = automatique selon les réglages)
  const [commission, setCommission] = useState("");
  const org = useCentrale();
  const centrale = org?.model === "centrale";
  const [payment, setPayment] = useState(defaultPayment);
  const [flight, setFlight] = useState("");
  const [comment, setComment] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [pending, start] = useTransition();
  const quoteAbort = useRef<AbortController | null>(null);

  const pickupAt = when === "now" ? null : new Date(`${date}T${time}`);
  const pickupPt = pickup.lat != null && pickup.lng != null ? { lat: pickup.lat, lng: pickup.lng } : null;
  const dropoffPt = dropoff.lat != null && dropoff.lng != null ? { lat: dropoff.lat, lng: dropoff.lng } : null;
  const near = useMemo(() => pickupPt ?? center ?? null, [pickupPt?.lat, pickupPt?.lng, center?.lat, center?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // Devis en direct : itinéraire réel, prix de la grille, chauffeurs proches
  useEffect(() => {
    if (!open || !pickupPt) {
      setQuote(null);
      return;
    }
    const t = window.setTimeout(async () => {
      quoteAbort.current?.abort();
      const ctrl = new AbortController();
      quoteAbort.current = ctrl;
      setQuoting(true);
      try {
        const res = await fetch("/api/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({ pickup: pickupPt, dropoff: dropoffPt, category, passengers, pickupAt: pickupAt?.toISOString(), pickupAddress: pickup.address, dropoffAddress: dropoff.address }),
        });
        if (res.ok) setQuote((await res.json()) as Quote);
      } catch {
        /* annulée */
      } finally {
        if (!ctrl.signal.aborted) setQuoting(false);
      }
    }, 200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pickupPt?.lat, pickupPt?.lng, dropoffPt?.lat, dropoffPt?.lng, category, passengers, when, date, time]);

  const routeCoords = useMemo<Coord[] | null>(() => (quote?.route?.polyline ? decodePolyline(quote.route.polyline) : null), [quote?.route?.polyline]);
  const suggested = quote?.priceCents ?? null;
  const nearest = quote?.nearby.drivers[0];
  const isAirport = /a[ée]roport|terminal|cdg|orly|bourget|beauvais/i.test(`${pickup.address} ${dropoff.address}`);
  const finalPrice = price.trim() ? Math.round(Number(price.replace(",", ".")) * 100) : suggested;
  const commissionCents = eurosToCents(commission);
  const commissionValid = commissionCents == null || Number.isFinite(commissionCents);
  const split = useSplitPreview(
    org?.orgId,
    centrale && finalPrice != null && Number.isFinite(finalPrice) ? finalPrice : null,
    commissionValid ? commissionCents : null,
    open && centrale,
  );
  const autoCommission = split.data && !split.data.manual && split.data.commission_cents != null ? split.data.commission_cents : null;

  async function pickOnMap(p: { lat: number; lng: number }) {
    const target = !pickupPt ? "pickup" : !dropoffPt ? "dropoff" : null;
    if (!target) return;
    const set = target === "pickup" ? setPickup : setDropoff;
    set({ address: "Point sur la carte…", lat: p.lat, lng: p.lng });
    try {
      const res = await fetch(`/api/geocode/reverse?lat=${p.lat}&lng=${p.lng}`);
      const json = (await res.json()) as { place: { address: string } | null };
      set({ address: json.place?.address ?? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`, lat: p.lat, lng: p.lng });
    } catch {
      set({ address: `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`, lat: p.lat, lng: p.lng });
    }
  }

  function reset() {
    setPickup(empty);
    setDropoff(empty);
    setWhen("now");
    setCustomerName("");
    setCustomerPhone("");
    setCustomerEmail("");
    setPassengers(1);
    setLuggage(1);
    setPrice("");
    setCommission("");
    setFlight("");
    setComment("");
    setErrors({});
    setQuote(null);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pickupPt) {
      setErrors({ "pickup.address": "Choisissez une adresse dans la liste ou cliquez sur la carte" });
      return;
    }
    if (centrale) {
      // Le chauffeur voit sa part dans l'offre : prix obligatoire, commission cohérente
      const e: Record<string, string> = {};
      if (finalPrice == null || !Number.isFinite(finalPrice)) e.priceCents = "Prix obligatoire en mode centrale";
      if (!commissionValid) e.commissionCents = "Montant en euros (ex. 14 ou 14,50)";
      else if (split.data?.error === "COMMISSION_TOO_HIGH") e.commissionCents = "Commission + frais plateforme > prix";
      if (Object.keys(e).length) {
        setErrors(e);
        toast.error(e.priceCents ? "Indiquez le prix : le chauffeur voit sa part avant d'accepter." : "Vérifiez la commission.");
        return;
      }
    }
    start(async () => {
      const res = await createRide({
        pickup: { address: pickup.address, lat: pickupPt.lat, lng: pickupPt.lng },
        dropoff: { address: dropoff.address, lat: dropoff.lat, lng: dropoff.lng },
        when,
        pickupAt: when === "scheduled" ? new Date(`${date}T${time}`) : undefined,
        customerName,
        customerPhone,
        customerEmail,
        passengers,
        luggage,
        vehicleCategory: category,
        priceCents: finalPrice ?? null,
        paymentMethod: payment as (typeof PAYMENT_METHODS)[number],
        comment,
        flightNumber: flight,
        commissionCents: centrale ? commissionCents : null,
      });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success(`Course #${res.number} créée`, { description: when === "now" ? "Les chauffeurs les plus proches sont notifiés." : "Proposée à votre flotte." });
      reset();
      onOpenChange(false);
      onCreated?.({ id: res.id, number: res.number });
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <WorkspaceContent title="Nouvelle course" description="Adresse, heure, client : le trajet, le prix et les chauffeurs disponibles sont calculés en direct.">
        <form onSubmit={submit} className="grid h-full min-h-0 lg:grid-cols-[440px_1fr]">
          {/* ---------------------------------------------------------------- formulaire */}
          <div className="flex min-h-0 flex-col border-line lg:border-r">
            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
              <section className="space-y-2">
                <div className="relative space-y-2">
                  <Field error={errors["pickup.address"] ?? errors["pickup.lat"]}>
                    <AddressInput marker="pickup" value={pickup} onChange={setPickup} placeholder="Adresse de départ" invalid={!!errors["pickup.address"]} autoFocus near={center} />
                  </Field>
                  <Field error={errors["dropoff.address"]}>
                    <AddressInput marker="dropoff" value={dropoff} onChange={setDropoff} placeholder="Destination" invalid={!!errors["dropoff.address"]} near={near} />
                  </Field>
                  <button
                    type="button"
                    onClick={() => {
                      setPickup(dropoff);
                      setDropoff(pickup);
                    }}
                    className="absolute -right-2 top-[30px] z-10 grid size-7 place-items-center rounded-full border border-line bg-ink-700 text-fg-muted hover:text-fg"
                    aria-label="Inverser départ et destination"
                  >
                    <ArrowDownUp className="size-3.5" />
                  </button>
                </div>
                {(!pickupPt || !dropoffPt) && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {QUICK_PLACES.map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => (!pickupPt ? setPickup : setDropoff)({ address: p.address, lat: p.lat, lng: p.lng })}
                        className="rounded-full border border-line px-2.5 py-1 text-[12px] text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
                      >
                        {p.label.replace("Aéroport ", "")}
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="space-y-3">
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-ink-800 p-1">
                  {(
                    [
                      { k: "now", label: "Maintenant", icon: Zap },
                      { k: "scheduled", label: "Planifier", icon: CalendarClock },
                    ] as const
                  ).map(({ k, label, icon: Icon }) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setWhen(k)}
                      className={cn(
                        "flex h-9 items-center justify-center gap-2 rounded-lg text-[13px] font-medium transition-colors",
                        when === k ? "bg-ink-600 text-fg" : "text-fg-muted hover:text-fg",
                      )}
                    >
                      <Icon className={cn("size-4", when === k && (k === "now" ? "text-brand" : "text-violet"))} />
                      {label}
                    </button>
                  ))}
                </div>
                {when === "scheduled" && (
                  <div className="grid grid-cols-2 gap-2">
                    <Field error={errors.pickupAt}>
                      <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="[color-scheme:dark]" aria-label="Date" />
                    </Field>
                    <Field>
                      <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="[color-scheme:dark]" aria-label="Heure" />
                    </Field>
                  </div>
                )}
              </section>

              <section className="space-y-2">
                <div className="grid grid-cols-5 gap-1.5">
                  {VEHICLE_CATEGORIES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCategory(c)}
                      className={cn(
                        "flex h-14 flex-col items-center justify-center rounded-lg border text-center transition-colors",
                        category === c ? "border-brand/60 bg-brand/[0.07] text-fg" : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
                      )}
                    >
                      <span className="text-[12.5px] font-semibold">{VEHICLE_CATEGORY_META[c].label}</span>
                      <span className="text-[11px] text-fg-subtle">{VEHICLE_CATEGORY_META[c].seats} pl.</span>
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Stepper value={passengers} onChange={setPassengers} min={1} max={20} label="Passagers" icon={Users} />
                  <Stepper value={luggage} onChange={setLuggage} min={0} max={30} label="Bagages" icon={Car} />
                </div>
              </section>

              <section className="grid grid-cols-2 gap-2">
                <Field error={errors.customerName} className="col-span-2 sm:col-span-1">
                  <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Nom du client" aria-label="Nom du client" aria-invalid={!!errors.customerName} />
                </Field>
                <Field error={errors.customerPhone} className="col-span-2 sm:col-span-1">
                  <Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="Téléphone" aria-label="Téléphone" inputMode="tel" aria-invalid={!!errors.customerPhone} />
                </Field>
                <Field error={errors.flightNumber} className="col-span-2 sm:col-span-1">
                  <div className="relative">
                    <Plane className={cn("pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2", isAirport ? "text-cyan" : "text-fg-subtle")} />
                    <Input value={flight} onChange={(e) => setFlight(e.target.value.toUpperCase())} placeholder={isAirport ? "N° de vol (aéroport)" : "N° de vol"} aria-label="Numéro de vol" className="pl-9" />
                  </div>
                </Field>
                <Field className="col-span-2 sm:col-span-1">
                  <NativeSelect value={payment} onChange={(e) => setPayment(e.target.value)} aria-label="Paiement">
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {PAYMENT_METHOD_LABELS[m]}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                {centrale && (
                  <div className="col-span-2 space-y-1 rounded-lg bg-white/[0.03] px-3 py-2 text-[12px] leading-[18px]" aria-live="polite">
                    <p className={cn("flex items-start gap-2", driverCollects(payment) ? "text-fg" : "text-fg-subtle")}>
                      <Banknote className={cn("mt-0.5 size-3.5 shrink-0", driverCollects(payment) ? "text-amber" : "text-fg-subtle")} />
                      <span>
                        <span className="font-medium">Espèces / carte à bord</span> : le chauffeur encaisse et vous doit la commission.
                      </span>
                    </p>
                    <p className={cn("flex items-start gap-2", !driverCollects(payment) ? "text-fg" : "text-fg-subtle")}>
                      <Landmark className={cn("mt-0.5 size-3.5 shrink-0", !driverCollects(payment) ? "text-violet" : "text-fg-subtle")} />
                      <span>
                        <span className="font-medium">En ligne / facture</span> : vous encaissez et lui versez sa part.
                      </span>
                    </p>
                  </div>
                )}
                <Field className="col-span-2" error={errors.customerEmail}>
                  <Input value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} placeholder="E-mail du client (facultatif)" type="email" aria-label="E-mail du client" />
                </Field>
                <Field className="col-span-2">
                  <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Note pour le chauffeur : pancarte, siège bébé…" aria-label="Commentaire" className="min-h-[64px]" />
                </Field>
              </section>
            </div>

            {/* Pied : prix + validation */}
            <div className="space-y-2 border-t border-line px-5 py-4">
              <p className="text-[12px] text-fg-subtle">
                {suggested != null && !price ? (
                  quote?.fixedFare ? (
                    <>
                      <span className="text-brand">Forfait {quote.fixedFare.label}</span>
                      {quote.meteredCents ? <> · au compteur ≈ {formatPrice(quote.meteredCents)}</> : null}
                    </>
                  ) : (
                    <>Tarif {quote?.pricingRule ?? "de la grille"} · modifiable</>
                  )
                ) : price ? (
                  <>Prix saisi manuellement</>
                ) : (
                  <>Le prix se calcule dès le départ et la destination choisis</>
                )}
              </p>
              {centrale ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Prix client" error={errors.priceCents}>
                      <div className="relative">
                        <Input
                          value={price}
                          onChange={(e) => {
                            setPrice(e.target.value);
                            if (errors.priceCents) setErrors(({ priceCents: _p, ...rest }) => rest);
                          }}
                          inputMode="decimal"
                          placeholder={suggested != null ? centsToInput(suggested) : "Obligatoire"}
                          aria-label="Prix en euros"
                          aria-invalid={!!errors.priceCents}
                          className="mono h-11 pr-7 text-[16px] font-semibold"
                        />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle">€</span>
                      </div>
                    </Field>
                    <Field
                      label={
                        <span className="flex items-center gap-1.5">
                          Commission
                          {!commission.trim() && <span className="rounded bg-white/[0.06] px-1 text-[10.5px] font-medium text-fg-subtle">auto</span>}
                        </span>
                      }
                      error={errors.commissionCents}
                    >
                      <div className="relative">
                        <Input
                          value={commission}
                          onChange={(e) => {
                            setCommission(e.target.value);
                            if (errors.commissionCents) setErrors(({ commissionCents: _c, ...rest }) => rest);
                          }}
                          inputMode="decimal"
                          placeholder={autoCommission != null ? centsToInput(autoCommission) : "Auto"}
                          aria-label="Commission de la centrale en euros (vide : automatique)"
                          aria-invalid={!!errors.commissionCents || split.data?.error === "COMMISSION_TOO_HIGH"}
                          className="mono h-11 pr-7 text-[16px] font-semibold"
                        />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle">€</span>
                      </div>
                    </Field>
                  </div>
                  <SplitPreview state={split} priceCents={finalPrice != null && Number.isFinite(finalPrice) ? finalPrice : null} />
                  <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
                    {when === "now" ? "Créer et dispatcher" : "Planifier la course"}
                  </Button>
                </>
              ) : (
                <div className="flex items-center gap-3">
                  <Field error={errors.priceCents} className="w-32">
                    <div className="relative">
                      <Input
                        value={price}
                        onChange={(e) => setPrice(e.target.value)}
                        inputMode="decimal"
                        placeholder={suggested != null ? String(suggested / 100) : "Prix"}
                        aria-label="Prix en euros"
                        className="h-11 pr-7 text-[16px] font-semibold"
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle">€</span>
                    </div>
                  </Field>
                  <Button type="submit" variant="primary" size="lg" loading={pending} className="flex-1">
                    {when === "now" ? "Créer et dispatcher" : "Planifier la course"}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* ---------------------------------------------------------------- carte + calcul */}
          <div className="relative hidden min-h-0 lg:block">
            <RoutePreview
              pickup={pickupPt}
              dropoff={dropoffPt}
              route={routeCoords}
              drivers={(quote?.nearby.drivers ?? []).slice(0, 4).map((d) => ({ id: d.id, name: d.name, lat: d.lat, lng: d.lng, etaS: d.etaS }))}
              onPick={!pickupPt || !dropoffPt ? pickOnMap : undefined}
              padding={{ top: 60, bottom: 170, left: 60, right: 60 }}
            />
            {(!pickupPt || !dropoffPt) && (
              <div className="glass pointer-events-none absolute left-1/2 top-4 flex -translate-x-1/2 items-center gap-2 rounded-full px-3.5 py-1.5 text-[12.5px] text-fg-muted">
                <MousePointerClick className="size-4 text-brand" />
                {!pickupPt ? "Cliquez sur la carte pour placer le départ" : "Cliquez sur la carte pour placer la destination"}
              </div>
            )}
            <div className="absolute inset-x-4 bottom-4">
              <div className="glass grid grid-cols-2 gap-px overflow-hidden rounded-2xl sm:grid-cols-4">
                <Metric icon={Route} label="Distance" value={quote?.route ? formatDistance(quote.route.distanceM) : "—"} loading={quoting && !!dropoffPt} />
                <Metric icon={Clock3} label="Durée" value={quote?.route ? formatDuration(quote.route.durationS) : "—"} loading={quoting && !!dropoffPt} />
                <Metric
                  icon={Zap}
                  label={quote?.fixedFare && !price ? "Forfait" : "Prix estimé"}
                  value={finalPrice != null ? formatPrice(finalPrice) : "—"}
                  hint={centrale && split.data?.driver_payout_cents != null ? `${formatPrice(split.data.driver_payout_cents)} pour le chauffeur` : undefined}
                  accent
                  loading={quoting && !!dropoffPt && !price}
                />
                <Metric
                  icon={Car}
                  label={quote ? `${quote.nearby.total} chauffeur${quote.nearby.total > 1 ? "s" : ""} dispo.` : "Chauffeurs"}
                  value={nearest ? `${formatDuration(nearest.etaS)}` : quote ? "Aucun" : "—"}
                  hint={nearest ? `${nearest.name} le plus proche` : undefined}
                  loading={quoting}
                />
              </div>
              {quote?.route?.approximate && (
                <p className="mt-2 text-center text-[11.5px] text-fg-subtle">Itinéraire estimé (service de routage indisponible)</p>
              )}
            </div>
          </div>
        </form>
      </WorkspaceContent>
    </Dialog>
  );
}

function Metric({ icon: Icon, label, value, hint, accent, loading }: { icon: typeof Route; label: string; value: string; hint?: string; accent?: boolean; loading?: boolean }) {
  return (
    <div className="bg-ink-850/40 px-4 py-3">
      <p className="flex items-center gap-1.5 text-[12px] text-fg-subtle">
        <Icon className="size-3.5" /> {label}
      </p>
      <p className={cn("mt-1 text-[20px] font-semibold tracking-tight", accent ? "text-brand" : "text-fg", loading && "opacity-50")}>{value}</p>
      {hint && <p className="truncate text-[11.5px] text-fg-muted">{hint}</p>}
    </div>
  );
}
