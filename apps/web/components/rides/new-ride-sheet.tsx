"use client";
import {
  estimatePrice, estimateRoute, formatDistance, formatDuration, formatPrice, PAYMENT_METHOD_LABELS, PAYMENT_METHODS,
  VEHICLE_CATEGORIES, VEHICLE_CATEGORY_META, type PricingRule, type VehicleCategory,
} from "@rydar/shared";
import { ArrowDownUp, CalendarClock, Minus, Plane, Plus, Sparkles, Zap } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { createRide } from "@/app/dashboard/rides/actions";
import { AddressInput, type PlaceValue } from "@/components/rides/address-input";
import { Button } from "@/components/ui/button";
import { Dialog, SheetContent } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const empty: PlaceValue = { address: "", lat: null, lng: null };

function Stepper({ value, onChange, min, max, label }: { value: number; onChange: (v: number) => void; min: number; max: number; label: string }) {
  return (
    <div className="flex h-10 items-center justify-between rounded-lg border border-line-strong bg-ink-850 px-1.5">
      <button type="button" aria-label={`Moins de ${label}`} onClick={() => onChange(Math.max(min, value - 1))} className="grid size-7 place-items-center rounded-md text-fg-muted hover:bg-white/5 hover:text-fg">
        <Minus className="size-3.5" />
      </button>
      <span className="num text-[15px] font-semibold">{value}</span>
      <button type="button" aria-label={`Plus de ${label}`} onClick={() => onChange(Math.min(max, value + 1))} className="grid size-7 place-items-center rounded-md text-fg-muted hover:bg-white/5 hover:text-fg">
        <Plus className="size-3.5" />
      </button>
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pricing: PricingRule[];
  onCreated?: (ride: { id: string; number: number }) => void;
  defaultPayment?: string;
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
  const [payment, setPayment] = useState(defaultPayment);
  const [flight, setFlight] = useState("");
  const [comment, setComment] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  const pickupAt = when === "now" ? new Date() : new Date(`${date}T${time}`);
  const route = useMemo(
    () =>
      pickup.lat != null && pickup.lng != null && dropoff.lat != null && dropoff.lng != null
        ? estimateRoute({ lat: pickup.lat, lng: pickup.lng }, { lat: dropoff.lat, lng: dropoff.lng })
        : null,
    [pickup.lat, pickup.lng, dropoff.lat, dropoff.lng],
  );
  const rule = pricing.find((p) => p.vehicle_category === category);
  const suggested = route && rule ? estimatePrice(rule, route.distanceM, route.durationS, pickupAt) : null;
  const isAirport = /a[ée]roport|terminal|cdg|orly|bourget|beauvais/i.test(`${pickup.address} ${dropoff.address}`);

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
    setFlight("");
    setComment("");
    setErrors({});
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const priceCents = price.trim() ? Math.round(Number(price.replace(",", ".")) * 100) : suggested;
    if (pickup.lat == null || pickup.lng == null) {
      setErrors({ "pickup.address": "Sélectionnez une adresse dans la liste" });
      return;
    }
    start(async () => {
      const res = await createRide({
        pickup: { address: pickup.address, lat: pickup.lat!, lng: pickup.lng! },
        dropoff: { address: dropoff.address, lat: dropoff.lat, lng: dropoff.lng },
        when,
        pickupAt: when === "scheduled" ? new Date(`${date}T${time}`) : undefined,
        customerName,
        customerPhone,
        customerEmail,
        passengers,
        luggage,
        vehicleCategory: category,
        priceCents: priceCents ?? null,
        paymentMethod: payment as (typeof PAYMENT_METHODS)[number],
        comment,
        flightNumber: flight,
      });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success(`Course #${res.number} créée`, { description: "Dispatch lancé vers les chauffeurs." });
      reset();
      onOpenChange(false);
      onCreated?.({ id: res.id, number: res.number });
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SheetContent title="Nouvelle course" description="Saisie rapide — le dispatch démarre dès la validation.">
        <form onSubmit={submit} className="flex min-h-full flex-col">
          <div className="flex-1 space-y-7 px-6 py-6">
            {/* Trajet */}
            <section className="space-y-3">
              <div className="relative space-y-2.5">
                <Field error={errors["pickup.address"] ?? errors["pickup.lat"]}>
                  <AddressInput marker="pickup" value={pickup} onChange={setPickup} placeholder="Adresse de départ" invalid={!!errors["pickup.address"]} autoFocus />
                </Field>
                <Field error={errors["dropoff.address"]}>
                  <AddressInput marker="dropoff" value={dropoff} onChange={setDropoff} placeholder="Destination" invalid={!!errors["dropoff.address"]} />
                </Field>
                <button
                  type="button"
                  onClick={() => {
                    setPickup(dropoff);
                    setDropoff(pickup);
                  }}
                  className="absolute right-12 top-[34px] z-10 grid size-7 place-items-center rounded-full border border-line-strong bg-ink-700 text-fg-muted hover:text-fg"
                  aria-label="Inverser départ et destination"
                >
                  <ArrowDownUp className="size-3.5" />
                </button>
              </div>
              {route && (
                <div className="flex items-center gap-4 rounded-xl border border-line bg-white/[0.02] px-4 py-2.5 text-[12.5px] text-fg-muted">
                  <span>
                    <span className="num text-fg">{formatDistance(route.distanceM)}</span> estimés
                  </span>
                  <span className="h-3 w-px bg-line-strong" />
                  <span>
                    <span className="num text-fg">{formatDuration(route.durationS)}</span> de trajet
                  </span>
                  {suggested != null && (
                    <>
                      <span className="h-3 w-px bg-line-strong" />
                      <span className="flex items-center gap-1.5">
                        <Sparkles className="size-3.5 text-brand" /> tarif suggéré <span className="num text-brand">{formatPrice(suggested)}</span>
                      </span>
                    </>
                  )}
                </div>
              )}
            </section>

            {/* Quand */}
            <section className="space-y-3">
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-ink-850 p-1">
                {(
                  [
                    { k: "now", label: "Maintenant", icon: Zap },
                    { k: "scheduled", label: "Planifiée", icon: CalendarClock },
                  ] as const
                ).map(({ k, label, icon: Icon }) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setWhen(k)}
                    className={cn(
                      "flex h-10 items-center justify-center gap-2 rounded-lg text-[13px] font-medium transition-colors",
                      when === k ? "bg-ink-600 text-fg shadow-[0_1px_0_rgb(255_255_255/0.06)_inset]" : "text-fg-muted hover:text-fg",
                    )}
                  >
                    <Icon className={cn("size-4", when === k && (k === "now" ? "text-brand" : "text-violet"))} />
                    {label}
                  </button>
                ))}
              </div>
              {when === "scheduled" && (
                <div className="grid grid-cols-2 gap-3 animate-rise">
                  <Field label="Date" error={errors.pickupAt}>
                    <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="[color-scheme:dark]" />
                  </Field>
                  <Field label="Heure">
                    <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="[color-scheme:dark]" />
                  </Field>
                </div>
              )}
            </section>

            {/* Client */}
            <section className="grid grid-cols-2 gap-3">
              <Field label="Nom du client" error={errors.customerName} className="col-span-2 sm:col-span-1">
                <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="M. Laurent Dubois" aria-invalid={!!errors.customerName} />
              </Field>
              <Field label="Téléphone" error={errors.customerPhone} className="col-span-2 sm:col-span-1">
                <Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="06 12 34 56 78" inputMode="tel" aria-invalid={!!errors.customerPhone} />
              </Field>
              <Field label="E-mail" optional className="col-span-2" error={errors.customerEmail}>
                <Input value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} placeholder="client@exemple.fr" type="email" />
              </Field>
            </section>

            {/* Véhicule */}
            <section className="space-y-3">
              <p className="text-[12.5px] font-medium text-fg-muted">Catégorie de véhicule</p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {VEHICLE_CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={cn(
                      "flex flex-col items-start rounded-xl border px-3 py-2.5 text-left transition-colors",
                      category === c ? "border-brand/50 bg-brand/[0.06]" : "border-line bg-ink-850 hover:border-line-strong",
                    )}
                  >
                    <span className={cn("text-[13px] font-semibold", category === c ? "text-brand" : "text-fg")}>{VEHICLE_CATEGORY_META[c].label}</span>
                    <span className="text-[11px] text-fg-subtle">{VEHICLE_CATEGORY_META[c].seats} places</span>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Passagers">
                  <Stepper value={passengers} onChange={setPassengers} min={1} max={20} label="passagers" />
                </Field>
                <Field label="Bagages">
                  <Stepper value={luggage} onChange={setLuggage} min={0} max={30} label="bagages" />
                </Field>
              </div>
              <Field label={<span className="flex items-center gap-1.5"><Plane className="size-3.5" /> Numéro de vol</span>} optional={!isAirport} hint={isAirport ? "Trajet aéroport détecté" : undefined} error={errors.flightNumber}>
                <Input value={flight} onChange={(e) => setFlight(e.target.value.toUpperCase())} placeholder="AF1680" />
              </Field>
            </section>

            {/* Prix */}
            <section className="grid grid-cols-2 gap-3">
              <Field label="Prix (€)" hint={suggested != null && !price ? `Suggestion appliquée : ${formatPrice(suggested)}` : undefined} error={errors.priceCents}>
                <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder={suggested != null ? String(suggested / 100) : "65"} className="num" />
              </Field>
              <Field label="Paiement">
                <NativeSelect value={payment} onChange={(e) => setPayment(e.target.value)}>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {PAYMENT_METHOD_LABELS[m]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Commentaire" optional className="col-span-2">
                <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Pancarte au nom du client, siège bébé…" />
              </Field>
            </section>
          </div>

          <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-line bg-ink-850/95 px-6 py-4 backdrop-blur">
            <div className="text-[12.5px] text-fg-muted">
              {when === "now" ? (
                <span className="flex items-center gap-1.5"><Zap className="size-3.5 text-brand" /> Dispatch immédiat · rayon 3 km</span>
              ) : (
                <span className="flex items-center gap-1.5"><CalendarClock className="size-3.5 text-violet" /> Proposée à la flotte</span>
              )}
            </div>
            <Button type="submit" variant="primary" size="lg" loading={pending}>
              Créer et dispatcher
            </Button>
          </div>
        </form>
      </SheetContent>
    </Dialog>
  );
}
