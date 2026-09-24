"use client";
import {
  estimatePrice, estimateRoute, formatDistance, formatDuration, formatPrice, VEHICLE_CATEGORY_META,
  type PricingRule, type VehicleCategory,
} from "@rydar/shared";
import { CalendarClock, Check, Minus, Plane, Plus, ShieldCheck, Zap } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { submitBooking } from "@/app/book/[slug]/actions";
import { AddressInput, type PlaceValue } from "@/components/rides/address-input";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const empty: PlaceValue = { address: "", lat: null, lng: null };

function Counter({ value, set, min, max }: { value: number; set: (v: number) => void; min: number; max: number }) {
  return (
    <div className="flex h-11 items-center justify-between rounded-lg border border-line-strong bg-ink-850 px-1.5">
      <button type="button" onClick={() => set(Math.max(min, value - 1))} className="grid size-8 place-items-center rounded-md text-fg-muted hover:bg-white/5" aria-label="Moins"><Minus className="size-4" /></button>
      <span className="num text-[16px] font-semibold">{value}</span>
      <button type="button" onClick={() => set(Math.min(max, value + 1))} className="grid size-8 place-items-center rounded-md text-fg-muted hover:bg-white/5" aria-label="Plus"><Plus className="size-4" /></button>
    </div>
  );
}

export function BookingForm({ slug, categories, pricing, showPrice, phone }: { slug: string; categories: VehicleCategory[]; pricing: PricingRule[]; showPrice: boolean; phone?: string | null }) {
  const [pickup, setPickup] = useState<PlaceValue>(empty);
  const [dropoff, setDropoff] = useState<PlaceValue>(empty);
  const [when, setWhen] = useState<"now" | "scheduled">("scheduled");
  const [date, setDate] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [time, setTime] = useState("08:00");
  const [category, setCategory] = useState<VehicleCategory>(categories[0] ?? "standard");
  const [passengers, setPassengers] = useState(1);
  const [luggage, setLuggage] = useState(1);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [pending, start] = useTransition();

  const pickupAt = when === "now" ? new Date() : new Date(`${date}T${time}`);
  const route = useMemo(
    () => (pickup.lat != null && dropoff.lat != null ? estimateRoute({ lat: pickup.lat, lng: pickup.lng! }, { lat: dropoff.lat, lng: dropoff.lng! }) : null),
    [pickup.lat, pickup.lng, dropoff.lat, dropoff.lng],
  );
  const rule = pricing.find((p) => p.vehicle_category === category);
  const estimate = route && rule && showPrice ? estimatePrice(rule, route.distanceM, route.durationS, pickupAt) : null;

  if (done !== null) {
    return (
      <div className="flex flex-col items-center px-6 py-14 text-center">
        <div className="relative mb-6 grid size-16 place-items-center">
          <span className="absolute inset-0 animate-ping-ring rounded-full border border-brand/60" />
          <span className="grid size-14 place-items-center rounded-full bg-brand text-brand-fg"><Check className="size-7" strokeWidth={3} /></span>
        </div>
        <h3 className="text-[22px] font-semibold tracking-tight">Réservation reçue</h3>
        {done > 0 && <p className="num mt-2 text-[14px] text-fg-muted">Référence #{done}</p>}
        <p className="mt-4 max-w-sm text-[14px] leading-relaxed text-fg-muted">
          Votre demande est transmise en temps réel à nos chauffeurs. Nous vous recontactons au besoin{phone ? ` — ou appelez-nous au ${phone}` : ""}.
        </p>
        <Button variant="outline" className="mt-8" onClick={() => { setDone(null); setPickup(empty); setDropoff(empty); }}>Nouvelle réservation</Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-5 p-6"
      action={(f) => {
        setError(null);
        if (pickup.lat == null || dropoff.lat == null) {
          setErrors({ pickup: pickup.lat == null ? "Choisissez une adresse dans la liste" : "", dropoff: dropoff.lat == null ? "Choisissez une adresse dans la liste" : "" });
          return;
        }
        start(async () => {
          const res = await submitBooking(slug, {
            pickup: { address: pickup.address, lat: pickup.lat!, lng: pickup.lng! },
            dropoff: { address: dropoff.address, lat: dropoff.lat!, lng: dropoff.lng! },
            when,
            pickupAt: when === "scheduled" ? new Date(`${date}T${time}`) : undefined,
            customerName: String(f.get("name") ?? ""),
            customerPhone: String(f.get("phone") ?? ""),
            customerEmail: String(f.get("email") ?? ""),
            passengers,
            luggage,
            vehicleCategory: category,
            flightNumber: String(f.get("flight") ?? ""),
            comment: String(f.get("comment") ?? ""),
            consent: f.get("consent") === "on",
            website: String(f.get("website") ?? ""),
          } as never);
          if (!res.ok) {
            setErrors(res.fieldErrors ?? {});
            setError(res.error);
          } else setDone(res.number);
        });
      }}
    >
      <div className="space-y-2.5">
        <Field error={errors.pickup}><AddressInput marker="pickup" value={pickup} onChange={setPickup} placeholder="Adresse de prise en charge" /></Field>
        <Field error={errors.dropoff}><AddressInput marker="dropoff" value={dropoff} onChange={setDropoff} placeholder="Destination (aéroport, gare, adresse…)" /></Field>
      </div>

      <div className="grid grid-cols-2 gap-2 rounded-xl border border-line bg-ink-850 p-1">
        {([["now", "Dès que possible", Zap], ["scheduled", "Réserver à l'avance", CalendarClock]] as const).map(([k, label, Icon]) => (
          <button key={k} type="button" onClick={() => setWhen(k)} className={cn("flex h-10 items-center justify-center gap-2 rounded-lg text-[13px] font-medium", when === k ? "bg-ink-600 text-fg" : "text-fg-muted")}>
            <Icon className={cn("size-4", when === k && "text-brand")} /> {label}
          </button>
        ))}
      </div>
      {when === "scheduled" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" error={errors.pickupAt}><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-11 [color-scheme:dark]" /></Field>
          <Field label="Heure"><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-11 [color-scheme:dark]" /></Field>
        </div>
      )}

      <div className={cn("grid gap-2", categories.length > 2 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2")}>
        {categories.map((c) => (
          <button key={c} type="button" onClick={() => setCategory(c)} className={cn("rounded-xl border px-3 py-2.5 text-left", category === c ? "border-brand/60 bg-brand/[0.07]" : "border-line hover:border-line-strong")}>
            <span className={cn("block text-[13px] font-semibold", category === c ? "text-brand" : "text-fg")}>{VEHICLE_CATEGORY_META[c].label}</span>
            <span className="block text-[11px] text-fg-subtle">jusqu&apos;à {VEHICLE_CATEGORY_META[c].seats} pers.</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Passagers"><Counter value={passengers} set={setPassengers} min={1} max={8} /></Field>
        <Field label="Bagages"><Counter value={luggage} set={setLuggage} min={0} max={10} /></Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nom" error={errors.customerName}><Input name="name" required autoComplete="name" className="h-11" /></Field>
        <Field label="Téléphone" error={errors.customerPhone}><Input name="phone" required inputMode="tel" autoComplete="tel" className="h-11" /></Field>
        <Field label="E-mail" optional error={errors.customerEmail}><Input name="email" type="email" autoComplete="email" className="h-11" /></Field>
        <Field label={<span className="flex items-center gap-1.5"><Plane className="size-3.5" /> N° de vol</span>} optional error={errors.flightNumber}><Input name="flight" className="h-11 uppercase" /></Field>
      </div>
      <Field label="Précisions" optional><Textarea name="comment" placeholder="Siège enfant, pancarte, arrêt intermédiaire…" /></Field>
      <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden />

      {route && (
        <div className="flex items-center justify-between rounded-xl border border-line bg-white/[0.02] px-4 py-3">
          <span className="text-[12.5px] text-fg-muted">
            <span className="num text-fg">{formatDistance(route.distanceM)}</span> · <span className="num text-fg">{formatDuration(route.durationS)}</span> estimés
          </span>
          {estimate != null && (
            <span className="text-right">
              <span className="block text-[11px] text-fg-subtle">Prix estimé</span>
              <span className="num text-[20px] font-semibold text-brand">{formatPrice(estimate)}</span>
            </span>
          )}
        </div>
      )}

      <label className="flex items-start gap-2.5 text-[12px] leading-relaxed text-fg-muted">
        <input type="checkbox" name="consent" required className="mt-0.5 accent-[var(--color-brand)]" />
        J&apos;accepte que mes coordonnées soient utilisées pour organiser cette course (aucun compte n&apos;est créé).
      </label>
      {(error || errors.consent) && <p className="rounded-lg border border-red/25 bg-red/10 px-3 py-2 text-[13px] text-red">{error ?? errors.consent}</p>}
      <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">Réserver mon chauffeur</Button>
      <p className="flex items-center justify-center gap-1.5 text-[11.5px] text-fg-subtle"><ShieldCheck className="size-3.5" /> Réservation sécurisée · confirmation immédiate</p>
    </form>
  );
}
