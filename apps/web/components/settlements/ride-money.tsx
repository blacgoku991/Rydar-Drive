"use client";
// Répartition du prix et règlement d'une course (mode centrale) : fiche course et panneau du command center.
// Prix / Chauffeur / Commission / Plateforme, qui encaisse le client, statut du règlement et actions rapides
// (Reçu, Pas reçu, Versé, Relancer, WhatsApp), correction du prix tant que le règlement n'est pas verrouillé.
// Course du réseau partagé (tenue ou faite par un chauffeur partenaire) : montants acceptés par le partenaire (figés),
// libellés « chauffeur partenaire », correction verrouillée (« retirez-la au partenaire ») ; son règlement se gère dans
// le bloc « Réseau partagé » de la fiche (mêmes actions que « Courses confiées »).
import {
  PAYMENT_METHOD_LABELS, PAYMENT_METHODS, SETTLEMENT_STATUS_META, driverCollects, formatPrice,
  type NetworkTerms, type PaymentMethod, type Settlement,
} from "@rydar/shared";
import { ArrowLeftRight, Banknote, HandCoins, Landmark, Lock, PencilLine } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { updateRidePricing } from "@/app/dashboard/rides/actions";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { canManageSettlements, useCentrale } from "@/components/settlements/centrale-context";
import { withFlags, type SettlementRow } from "@/components/settlements/settlement-flags";
import {
  DeclarationLine, SettlementActions, SettlementBadge, SplitBar, dueInfo, parseDriverLabel,
} from "@/components/settlements/settlement-ui";
import { SplitPreview, centsToInput, eurosToCents, useSplitPreview } from "@/components/settlements/split-preview";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { toneText } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, NativeSelect } from "@/components/ui/input";
import { useNow } from "@/hooks/use-now";
import { runAction } from "@/lib/run-action";
import { getBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

export type RideMoneyRide = {
  id: string;
  number: number;
  status: string;
  price_cents: number | null;
  commission_cents: number | null;
  platform_fee_cents: number | null;
  driver_payout_cents: number | null;
  commission_manual: boolean | null;
  payment_method: string;
  currency?: string | null;
  driver_id: string | null;
};

export type { SettlementRow } from "@/components/settlements/settlement-flags";

/**
 * Course du réseau partagé : `lock` = message de verrouillage (NETWORK_LOCK_MESSAGE…) ou null ; `terms` = montants
 * acceptés par le chauffeur partenaire (ride_network_executions.terms), prioritaires sur ceux de la course.
 */
export type RideMoneyNetwork = { lock: string | null; terms?: NetworkTerms | null };

/** Bandeau de verrouillage (course confiée à un partenaire). */
function LockNotice({ message, className }: { message: string; className?: string }) {
  return (
    <p className={cn("flex items-start gap-2 rounded-lg border border-violet/25 bg-violet/[0.06] px-3 py-2.5 text-[12.5px] leading-[18px] text-fg-muted", className)}>
      <Lock className="mt-px size-4 shrink-0 text-violet" />
      <span>{message}</span>
    </p>
  );
}

/** Montants affichés : ceux acceptés par le partenaire (figés) quand ils sont connus, sinon ceux de la course. */
function figures(ride: RideMoneyRide, terms: NetworkTerms | null | undefined) {
  return terms
    ? { price: terms.price_cents, driver: terms.driver_payout_cents, commission: terms.commission_cents, platform: terms.platform_fee_cents, payment: terms.payment_method }
    : { price: ride.price_cents, driver: ride.driver_payout_cents, commission: ride.commission_cents, platform: ride.platform_fee_cents, payment: ride.payment_method };
}

const SETTLEMENT_COLUMNS =
  "id, ride_id, driver_id, driver_label, direction, amount_cents, price_cents, commission_cents, platform_fee_cents, driver_payout_cents, currency, payment_method, reference, status, due_at, declared_at, declared_method, declared_note, disputed_at, settled_at, settled_method, note, reminders_sent, last_reminded_at, created_at, updated_at";
const RIDE_MONEY_COLUMNS = "id, number, status, price_cents, commission_cents, platform_fee_cents, driver_payout_cents, commission_manual, payment_method, currency, driver_id";

// ---------------------------------------------------------------------------- lecture (panneau du command center)
/** Répartition + règlement d'une course, relus quand la course change ou qu'un règlement la concerne. */
export function useRideMoney(rideId: string, version: string) {
  const [data, setData] = useState<{ ride: RideMoneyRide; settlement: SettlementRow | null } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const sb = getBrowserClient();
    Promise.all([
      sb.from("rides").select(RIDE_MONEY_COLUMNS).eq("id", rideId).maybeSingle(),
      sb.from("ride_settlements").select(SETTLEMENT_COLUMNS).eq("ride_id", rideId).maybeSingle(),
    ])
      .then(([r, s]: [{ data: RideMoneyRide | null }, { data: SettlementRow | null }]) => {
        if (alive && r.data) setData({ ride: r.data, settlement: s.data ?? null });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [rideId, version, tick]);
  useRealtimeEvent("settlement.updated", (e: { settlement?: { ride_id?: string } }) => {
    if (e?.settlement?.ride_id === rideId) setTick((t) => t + 1);
  });
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data: data?.ride.id === rideId ? data : null, reload };
}

// ---------------------------------------------------------------------------- éléments
function Figure({ label, cents, currency, tone, hint }: { label: string; cents: number | null; currency: string; tone?: "brand" | "blue" | "violet"; hint?: string }) {
  return (
    <div className="min-w-0 bg-ink-800 px-3 py-2.5">
      <p className="flex items-center gap-1.5 truncate text-[11.5px] text-fg-subtle">
        {tone && <span className={cn("size-1.5 shrink-0 rounded-full", tone === "brand" ? "bg-brand" : tone === "blue" ? "bg-blue" : "bg-violet")} />}
        {label}
      </p>
      <p className="mt-0.5 flex min-w-0 items-baseline gap-1.5">
        <span className={cn("mono truncate text-[15px] font-semibold tracking-tight", tone === "brand" ? "text-brand" : "text-fg")}>
          {cents == null ? "—" : formatPrice(cents, currency)}
        </span>
        {hint && <span className="shrink-0 rounded bg-white/[0.06] px-1 text-[10px] font-medium text-fg-subtle">{hint}</span>}
      </p>
    </div>
  );
}

/**
 * « Espèces : le chauffeur encaisse le client et vous doit 19 € » / « Payé en ligne : vous lui versez 40 € ».
 * Course du réseau partagé : « le chauffeur partenaire … vous reverse » (montants acceptés, figés).
 */
function Collects({ ride, currency, className, network }: { ride: RideMoneyRide; currency: string; className?: string; network?: RideMoneyNetwork | null }) {
  const f = figures(ride, network?.terms);
  const collects = driverCollects(f.payment);
  const Icon = collects ? Banknote : Landmark;
  const method = PAYMENT_METHOD_LABELS[f.payment as PaymentMethod] ?? f.payment;
  const owed = (f.commission ?? 0) + (f.platform ?? 0);
  const who = network ? "le chauffeur partenaire" : "le chauffeur";
  return (
    <p className={cn("flex items-start gap-2 text-[12.5px] leading-[18px] text-fg-muted", className)}>
      <Icon className={cn("mt-px size-4 shrink-0", collects ? "text-amber" : "text-violet")} />
      <span>
        <span className="font-medium text-fg">{method}</span> :{" "}
        {f.driver == null
          ? collects
            ? `${who} encaisse le client et vous doit la commission.`
            : "vous encaissez le client et lui versez sa part."
          : collects
            ? network
              ? <>{who} encaisse le client et vous reverse <span className="mono text-fg">{formatPrice(owed, currency)}</span>.</>
              : <>{who} encaisse le client et vous doit <span className="mono text-fg">{formatPrice(owed, currency)}</span> (commission + frais).</>
            : <>vous encaissez le client et {network ? "versez" : "lui versez"} <span className="mono text-fg">{formatPrice(f.driver, currency)}</span>{network ? " au chauffeur partenaire" : ""}.</>}
      </span>
    </p>
  );
}

function SettlementBlock({ settlement: s, canManage, now, compact, onChanged }: { settlement: Settlement; canManage: boolean; now: number; compact?: boolean; onChanged?: () => void }) {
  const org = useCentrale();
  const due = dueInfo(s, now, { blockUnpaid: org?.blockUnpaid });
  const owes = s.direction === "driver_owes";
  return (
    <div className={cn("space-y-2.5 rounded-xl border px-3.5 py-3", s.blocking ? "border-red/25 bg-red/[0.05]" : s.status === "declared" ? "border-blue/25 bg-blue/[0.05]" : "border-line bg-white/[0.02]")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <SettlementBadge settlement={s} />
          <span className="truncate text-[12px] text-fg-subtle">
            réf. <span className="mono text-fg-muted">{s.reference}</span>
          </span>
        </div>
        <p className="mono text-[16px] font-semibold tracking-tight">
          {formatPrice(s.amount_cents, s.currency)}
          <span className="ml-1.5 font-sans text-[11.5px] font-normal text-fg-subtle">{owes ? "à encaisser" : "à verser"}</span>
        </p>
      </div>
      {s.status === "declared" ? (
        <DeclarationLine settlement={s} now={now} />
      ) : (
        <p className={cn("text-[12px]", toneText[due.tone])}>{due.text}</p>
      )}
      {s.note && (s.status === "disputed" || s.status === "waived" || s.status === "paid") && <p className="text-[12px] text-fg-subtle">« {s.note} »</p>}
      <SettlementActions settlement={s} canManage={canManage} size={compact ? "xs" : "sm"} onChanged={onChanged} />
    </div>
  );
}

// ---------------------------------------------------------------------------- correction du prix
export function EditPricingDialog({
  ride,
  settlement,
  open,
  onOpenChange,
  onSaved,
  lock,
}: {
  ride: RideMoneyRide;
  settlement: Settlement | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
  /** Course confiée à un chauffeur partenaire : rien de modifiable (garde NETWORK_RIDE_LOCKED en base) */
  lock?: string | null;
}) {
  const org = useCentrale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [price, setPrice] = useState("");
  const [commission, setCommission] = useState("");
  const [payment, setPayment] = useState(ride.payment_method);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    setPrice(centsToInput(ride.price_cents));
    setCommission(ride.commission_manual ? centsToInput(ride.commission_cents) : "");
    setPayment(ride.payment_method);
    setErrors({});
  }, [open, ride.price_cents, ride.commission_cents, ride.commission_manual, ride.payment_method]);
  const priceCents = eurosToCents(price);
  const commissionCents = eurosToCents(commission);
  const valid = (v: number | null) => v == null || Number.isFinite(v);
  const split = useSplitPreview(org?.orgId, valid(priceCents) ? priceCents : null, valid(commissionCents) ? commissionCents : null, open);
  const locked = !!lock || (!!settlement && settlement.status !== "due");
  const currency = ride.currency ?? "EUR";
  const lockLabel = settlement ? SETTLEMENT_STATUS_META[settlement.status].label.toLowerCase() : "";

  const save = () => {
    const e: Record<string, string> = {};
    if (priceCents == null) e.priceCents = "Prix obligatoire en mode centrale";
    else if (!valid(priceCents)) e.priceCents = "Montant en euros (ex. 59 ou 59,50)";
    if (!valid(commissionCents)) e.commissionCents = "Montant en euros (ex. 14 ou 14,50)";
    else if (split.data?.error === "COMMISSION_TOO_HIGH") e.commissionCents = "Commission + frais plateforme > prix";
    setErrors(e);
    if (Object.keys(e).length) return;
    start(() => runAction(async () => {
      const res = await updateRidePricing(ride.id, { priceCents, commissionCents, paymentMethod: payment as PaymentMethod });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success(res.changed ? `Course #${ride.number} mise à jour` : "Aucune modification", {
        description: res.changed && settlement?.status === "due" ? "Le règlement à régler a été recalculé ; le chauffeur voit le nouveau montant." : undefined,
      });
      onOpenChange(false);
      onSaved?.();
      router.refresh();
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" title={`Prix de la course #${ride.number}`} description="La répartition et le règlement « à régler » sont recalculés automatiquement ; le chauffeur voit sa nouvelle part.">
        {lock ? (
          <LockNotice message={lock} className="mb-4" />
        ) : locked && (
          <p className="mb-4 flex items-start gap-2 rounded-lg border border-amber/25 bg-amber/[0.07] px-3 py-2.5 text-[12.5px] leading-[18px] text-fg-muted">
            <Lock className="mt-px size-4 shrink-0 text-amber" />
            <span>
              Règlement <span className="font-medium text-fg">{lockLabel}</span> : le prix, la commission et le paiement sont verrouillés.
              {settlement && (settlement.status === "paid" || settlement.status === "waived")
                ? " Rouvrez le règlement pour corriger."
                : " Pour corriger : marquez-le reçu (ou annulez la dette), puis rouvrez-le."}
            </span>
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Prix client" error={errors.priceCents}>
            <div className="relative">
              <Input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
                disabled={locked}
                aria-label="Prix client en euros"
                aria-invalid={!!errors.priceCents}
                className="mono pr-7"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle">€</span>
            </div>
          </Field>
          <Field label="Commission" hint={commission.trim() ? "saisie à la course" : "vide : automatique"} error={errors.commissionCents}>
            <div className="relative">
              <Input
                value={commission}
                onChange={(e) => setCommission(e.target.value)}
                inputMode="decimal"
                placeholder="Auto"
                disabled={locked}
                aria-label="Commission en euros (vide : automatique)"
                aria-invalid={!!errors.commissionCents}
                className="mono pr-7"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle">€</span>
            </div>
          </Field>
          <Field label="Paiement du client" className="col-span-2">
            <NativeSelect value={payment} onChange={(e) => setPayment(e.target.value)} disabled={locked} aria-label="Paiement du client">
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <SplitPreview className="mt-4" state={split} priceCents={valid(priceCents) ? priceCents : null} currency={currency} />
        <p className="mt-2 text-[12px] text-fg-subtle">
          {driverCollects(payment) ? "Espèces / carte à bord : le chauffeur encaisse et vous doit la commission." : "En ligne / facture : vous encaissez et lui versez sa part."}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Annuler</Button>
          <Button variant="primary" loading={pending} disabled={locked} onClick={save}>Enregistrer</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- fiche course
export function RideMoneyCard({
  ride,
  settlement: row,
  driverName,
  serverNow,
  network,
}: {
  ride: RideMoneyRide;
  settlement: SettlementRow | null;
  driverName?: string | null;
  /** Horloge du rendu serveur (même statut « en retard » à l'hydratation) */
  serverNow: number;
  /** Course tenue ou faite par un chauffeur partenaire (réseau partagé) */
  network?: RideMoneyNetwork | null;
}) {
  const org = useCentrale();
  const now = useNow(30_000) ?? serverNow;
  const settlement = useMemo(() => (row ? withFlags(row, now) : null), [row, now]);
  const [editing, setEditing] = useState(false);
  const currency = ride.currency ?? "EUR";
  const canManage = canManageSettlements(org?.role);
  const who = driverName ?? (settlement ? parseDriverLabel(settlement.driver_label).firstName : null);
  const f = figures(ride, network?.terms);
  const priced = f.price != null && f.driver != null;
  const collects = driverCollects(f.payment);
  const terminal = ride.status === "COMPLETED" || ride.status === "CANCELLED" || ride.status === "NO_DRIVER_FOUND";
  const lock = network?.lock ?? null;

  return (
    <Card>
      <CardHeader
        title="Répartition & règlement"
        icon={<HandCoins />}
        description={
          network
            ? "Montants acceptés par le chauffeur partenaire ; règlement dans le bloc « Réseau partagé »."
            : priced
              ? "Part chauffeur affichée dans son offre ; règlement créé à la fin de la course."
              : "Prix à fixer : la répartition se calcule dès que le prix est connu."
        }
        action={
          ride.status !== "CANCELLED" ? (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={!!lock} title={lock ?? undefined}>
              <PencilLine /> {ride.price_cents == null ? "Fixer le prix" : "Modifier"}
            </Button>
          ) : undefined
        }
      />
      <CardBody className="space-y-4 pt-4">
        {lock && <LockNotice message={lock} />}
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-line sm:grid-cols-4">
          <Figure label="Prix" cents={f.price} currency={currency} />
          <Figure label={network ? "Chauffeur partenaire" : "Chauffeur"} cents={f.driver} currency={currency} tone="brand" />
          <Figure
            label="Commission"
            cents={f.commission}
            currency={currency}
            tone="blue"
            hint={network || f.commission == null ? undefined : ride.commission_manual ? "saisie" : "auto"}
          />
          <Figure label="Plateforme" cents={f.platform} currency={currency} tone="violet" />
        </div>
        {priced && <SplitBar split={{ price: f.price!, driver: f.driver!, commission: f.commission ?? 0, platform: f.platform ?? 0 }} />}
        <Collects ride={ride} currency={currency} network={network} />
        {network ? (
          <p className="flex items-start gap-2 rounded-xl border border-dashed border-line px-3.5 py-3 text-[12.5px] text-fg-subtle">
            <ArrowLeftRight className="mt-px size-4 shrink-0 text-violet" />
            <span>Règlement avec le chauffeur partenaire : bloc « Réseau partagé » de cette fiche.</span>
          </p>
        ) : settlement ? (
          <SettlementBlock settlement={settlement} canManage={canManage} now={now} />
        ) : (
          <p className="rounded-xl border border-dashed border-line px-3.5 py-3 text-[12.5px] text-fg-subtle">
            {ride.status === "COMPLETED"
              ? "Aucun règlement pour cette course (montant nul ou course terminée avant le mode centrale)."
              : terminal
                ? "Course non réalisée : aucun règlement."
                : priced
                  ? `Règlement créé à la fin de la course : ${collects ? `${who ?? "le chauffeur"} vous devra ${formatPrice((ride.commission_cents ?? 0) + (ride.platform_fee_cents ?? 0), currency)}` : `vous verserez ${formatPrice(ride.driver_payout_cents, currency)} à ${who ?? "son chauffeur"}`}.`
                  : "Fixez le prix pour que le chauffeur voie sa part avant d'accepter."}
          </p>
        )}
        {settlement && !network && (
          <Link href={`/dashboard/settlements?filter=all${settlement.driver_id ? `&driver=${settlement.driver_id}` : ""}#reglements`} prefetch={false} className="inline-block text-[12px] text-fg-subtle underline-offset-2 hover:text-fg hover:underline">
            Tous les règlements de {parseDriverLabel(settlement.driver_label).firstName} →
          </Link>
        )}
      </CardBody>
      <EditPricingDialog ride={ride} settlement={network ? null : settlement} open={editing && !lock} onOpenChange={setEditing} lock={lock} />
    </Card>
  );
}

// ---------------------------------------------------------------------------- panneau du command center
export function RideMoneyPanel({ rideId, version, now, network }: { rideId: string; version: string; now: number; network?: RideMoneyNetwork | null }) {
  const org = useCentrale();
  const { data, reload } = useRideMoney(rideId, version);
  const [editing, setEditing] = useState(false);
  const settlement = useMemo(() => (data?.settlement ? withFlags(data.settlement, now) : null), [data?.settlement, now]);
  if (!data) return <div className="skeleton h-[86px] rounded-xl" aria-hidden />;
  const ride = data.ride;
  const currency = ride.currency ?? "EUR";
  const priced = ride.price_cents != null && ride.driver_payout_cents != null;
  const lock = network?.lock ?? null;
  return (
    <div className="space-y-2.5">
      <div className="rounded-xl bg-white/[0.04] px-3.5 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-[12px] font-medium text-fg-subtle">Répartition</p>
          {ride.status !== "CANCELLED" && !lock && (
            <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-fg-muted hover:bg-white/5 hover:text-fg">
              <PencilLine className="size-3.5" /> {ride.price_cents == null ? "Fixer le prix" : "Modifier"}
            </button>
          )}
        </div>
        {lock && <LockNotice message={lock} className="mb-2.5" />}
        {priced ? (
          <>
            <SplitBar split={{ price: ride.price_cents!, driver: ride.driver_payout_cents!, commission: ride.commission_cents ?? 0, platform: ride.platform_fee_cents ?? 0 }} />
            <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-fg-muted">
              <span className="inline-flex items-baseline gap-1"><span className="mono font-semibold text-brand">{formatPrice(ride.driver_payout_cents, currency)}</span> chauffeur</span>
              <span className="inline-flex items-baseline gap-1">
                <span className="mono text-blue">{formatPrice(ride.commission_cents, currency)}</span> commission{ride.commission_manual ? "" : " (auto)"}
              </span>
              {!!ride.platform_fee_cents && (
                <span className="inline-flex items-baseline gap-1"><span className="mono text-violet">{formatPrice(ride.platform_fee_cents, currency)}</span> plateforme</span>
              )}
            </p>
          </>
        ) : (
          <p className="text-[12.5px] text-amber">Prix à fixer : le chauffeur doit voir sa part.</p>
        )}
        <Collects ride={ride} currency={currency} className="mt-2 text-[12px]" network={network} />
      </div>
      {network ? (
        settlement && (
          <Link
            href={`/dashboard/rides/${ride.id}`}
            prefetch={false}
            className="flex items-center gap-2 rounded-xl border border-line px-3.5 py-2.5 text-[12px] text-fg-muted hover:border-line-strong hover:text-fg"
          >
            <ArrowLeftRight className="size-3.5 shrink-0 text-violet" /> Règlement avec le chauffeur partenaire : fiche de la course →
          </Link>
        )
      ) : (
        settlement && <SettlementBlock settlement={settlement} canManage={canManageSettlements(org?.role)} now={now} compact onChanged={reload} />
      )}
      <EditPricingDialog ride={ride} settlement={network ? null : settlement} open={editing && !lock} onOpenChange={setEditing} onSaved={reload} lock={lock} />
    </div>
  );
}
