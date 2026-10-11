"use client";
// Éléments communs des encaissements (mode centrale) : statut, répartition, échéances, WhatsApp prérempli,
// et les décisions de la centrale — Reçu / Versé, Pas reçu, Annuler la commission (ou le versement), Rouvrir, Relancer.
// Utilisés par la page Encaissements, la fiche course, le panneau du command center et les alertes.
import {
  SETTLEMENT_METHOD_META, SETTLEMENT_STATUS_META, dateTimeFormat, formatPrice, settlementPaymentLink, settlementRequestMessage, settlementStatusLabel,
  whatsappLink, type Settlement, type SettlementMethod, type Tone,
} from "@rydar/shared";
import {
  ArrowLeftRight, Banknote, BellRing, Check, CircleSlash, Ellipsis, EllipsisVertical, Link2, MessageCircle, RotateCcw, Undo2, type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  confirmSettlements, disputeSettlement, remindDriverSettlements, reopenSettlement, waiveSettlement, type SettlementActionResult,
} from "@/app/dashboard/settlements/actions";
import { type SettlementBankInfo, useCentrale } from "@/components/settlements/centrale-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/misc";
import { runAction } from "@/lib/run-action";
import { getBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { NewTabHint } from "@/components/ui/new-tab";

// ---------------------------------------------------------------------------- libellés
const NB = "\u00a0";
export type ConfirmMethod = SettlementMethod | "other";

export const METHOD_ICON: Record<ConfirmMethod, LucideIcon> = { link: Link2, cash: Banknote, transfer: ArrowLeftRight, other: Ellipsis };
/**
 * Moyens de paiement : un ordre et des libellés uniques sur le web (Virement, Lien de paiement, Espèces, Autre moyen),
 * comme les paiements à Rydar (org-platform-format) — surcharge web, SETTLEMENT_METHOD_META (lu par l'app) ne change pas.
 */
export const METHOD_ORDER: readonly ConfirmMethod[] = ["transfer", "link", "cash", "other"];
export const methodLabel = (m: string | null | undefined) => (m ? (SETTLEMENT_METHOD_META[m as ConfirmMethod]?.label ?? "Autre moyen") : "—");

/** Couleur d'un statut : « à régler » passé l'échéance = rouge. */
export function settlementTone(s: Pick<Settlement, "status" | "overdue">): Tone {
  if (s.status === "due" && s.overdue) return "red";
  return SETTLEMENT_STATUS_META[s.status]?.tone ?? "neutral";
}

export function SettlementBadge({ settlement: s, className }: { settlement: Pick<Settlement, "status" | "direction" | "overdue">; className?: string }) {
  return (
    <Badge tone={settlementTone(s)} className={className}>
      {settlementStatusLabel(s.status, s.direction, s.overdue)}
    </Badge>
  );
}

/** Numéro de course d'un règlement (référence « C1783 » à défaut). */
export function rideNumberOf(s: { reference: string; ride?: { number: number } | null }): number | null {
  if (s.ride?.number) return s.ride.number;
  const m = /^C(\d+)$/.exec(s.reference);
  return m ? Number(m[1]) : null;
}

/** « Karim Test (#12) » → { firstName: « Karim », number: 12 } */
export function parseDriverLabel(label: string | null | undefined) {
  const m = /^(.*?)\s*\(#(\d+)\)\s*$/.exec(label ?? "");
  const name = (m?.[1] ?? label ?? "").trim();
  return { name, firstName: name.split(/\s+/)[0] || "Chauffeur", number: m ? Number(m[2]) : null };
}

/** Référence d'un règlement groupé, identique à l'app chauffeur (driver_settlements) : « CH12-2509 ». */
export function batchReference(driverNumber: number, timeZone: string, now = new Date()) {
  const parts = dateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", timeZone }).formatToParts(now);
  const v = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `CH${driverNumber}-${v("day")}${v("month")}`;
}

// ---------------------------------------------------------------------------- durées
function span(ms: number) {
  const min = Math.round(Math.abs(ms) / 60_000);
  if (min < 1) return "moins d'1 min";
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  return `${d} j`;
}

/** « il y a 2 h », « dans 5 h », « à l'instant » */
export function fromNow(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "";
  const diff = Date.parse(iso) - now;
  if (Math.abs(diff) < 60_000) return "à l'instant";
  return diff < 0 ? `il y a ${span(diff)}` : `dans ${span(diff)}`;
}

/** Échéance lisible : « échéance dans 5 h », « 2 j de retard · chauffeur bloqué », « encaissé il y a 3 h »… */
export function dueInfo(
  s: Pick<Settlement, "status" | "direction" | "due_at" | "overdue" | "settled_at" | "declared_at">,
  now = Date.now(),
  opts: { blockUnpaid?: boolean } = {},
): { text: string; tone: Tone } {
  const blocked = opts.blockUnpaid !== false && s.direction === "driver_owes" ? " · chauffeur bloqué" : "";
  if (s.status === "paid") return { text: `${s.direction === "driver_owes" ? "encaissé" : "versé"} ${fromNow(s.settled_at, now)}`, tone: "green" };
  if (s.status === "waived") return { text: `annulé ${fromNow(s.settled_at, now)}`, tone: "neutral" };
  if (s.status === "declared") return { text: `signalé ${fromNow(s.declared_at, now)}`, tone: "blue" };
  if (s.status === "disputed") return { text: `contesté${blocked}`, tone: "red" };
  const due = Date.parse(s.due_at);
  if (due <= now) {
    return s.direction === "driver_owes"
      ? { text: `${span(now - due)} de retard${blocked}`, tone: "red" }
      : { text: `à verser depuis ${span(now - due)}`, tone: "amber" };
  }
  return { text: `${s.direction === "driver_owes" ? "échéance" : "à verser"} dans ${span(due - now)}`, tone: due - now < 3 * 3600_000 ? "amber" : "neutral" };
}

// ---------------------------------------------------------------------------- répartition
export type SplitValues = { price: number; driver: number; commission: number; platform: number };

const SPLIT_PARTS = [
  { key: "driver", label: "chauffeur", bar: "bg-brand", dot: "bg-brand" },
  { key: "commission", label: "commission", bar: "bg-blue", dot: "bg-blue" },
  { key: "platform", label: "plateforme", bar: "bg-violet", dot: "bg-violet" },
] as const;

/** Barre segmentée : part chauffeur (lime), commission (bleu), frais plateforme (violet). */
export function SplitBar({ split, className }: { split: SplitValues; className?: string }) {
  const total = Math.max(1, split.driver + split.commission + split.platform);
  return (
    <div className={cn("flex h-2 gap-[2px] overflow-hidden rounded-full bg-white/[0.06]", className)} aria-hidden>
      {SPLIT_PARTS.filter((p) => split[p.key] > 0).map((p) => (
        <span key={p.key} className={cn("h-full first:rounded-l-full last:rounded-r-full", p.bar)} style={{ width: `${(split[p.key] / total) * 100}%` }} />
      ))}
    </div>
  );
}

/** « 40 € chauffeur · 14 € commission · 5 € plateforme » (plateforme masquée si nulle). */
export function SplitLegend({ split, currency = "EUR", className }: { split: SplitValues; currency?: string; className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-muted", className)}>
      {SPLIT_PARTS.filter((p) => p.key !== "platform" || split.platform > 0).map((p) => (
        <span key={p.key} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span className={cn("size-1.5 rounded-full", p.dot)} />
          <span className={cn("mono text-fg", p.key === "driver" && "font-semibold text-brand")}>{formatPrice(split[p.key], currency)}</span> {p.label}
        </span>
      ))}
    </p>
  );
}

// ---------------------------------------------------------------------------- chauffeur (téléphone, prénom)
export type DriverContact = { id: string; phone: string | null; first_name: string; last_name: string; number: number };
const contacts = new Map<string, Promise<DriverContact | null>>();

/** Coordonnées d'un chauffeur de l'organisation (lecture RLS, mise en cache ; un échec sera retenté). */
export function useDriverContact(driverId: string | null | undefined): DriverContact | null {
  const [value, setValue] = useState<DriverContact | null>(null);
  useEffect(() => {
    if (!driverId) return;
    let p = contacts.get(driverId);
    if (!p) {
      const id = driverId;
      p = Promise.resolve(
        getBrowserClient()
          .from("drivers")
          .select("id, phone, first_name, last_name, number")
          .eq("id", id)
          .maybeSingle()
          .then(({ data }: { data: DriverContact | null }) => data ?? null),
      )
        .catch(() => null)
        .then((v) => {
          if (!v) contacts.delete(id);
          return v;
        });
      contacts.set(id, p);
    }
    let alive = true;
    void p.then((v) => alive && setValue(v));
    return () => {
      alive = false;
    };
  }, [driverId]);
  return driverId && value?.id === driverId ? value : null;
}

// ---------------------------------------------------------------------------- WhatsApp
export type WhatsAppRequest = {
  phone: string | null | undefined;
  firstName: string;
  amountCents: number;
  currency?: string;
  rideNumbers: (number | string)[];
  reference: string | null;
};

/** Lien wa.me avec la réclamation préremplie (lien de paiement avec montant et référence si accepté). */
export function useSettlementWhatsApp(req: WhatsAppRequest | null): string | null {
  const org = useCentrale();
  if (!req || !org || !(req.amountCents > 0)) return null;
  return buildSettlementWhatsApp(req, org);
}

export function buildSettlementWhatsApp(
  req: WhatsAppRequest,
  org: { orgName: string; link: string | null; instructions: string | null; methods: SettlementMethod[]; bank?: SettlementBankInfo | null },
): string | null {
  if (!(req.amountCents > 0)) return null;
  const link = org.methods.includes("link") ? settlementPaymentLink(org.link, req.amountCents, req.reference) : null;
  const text = settlementRequestMessage({
    firstName: req.firstName,
    organizationName: org.orgName,
    amountCents: req.amountCents,
    currency: req.currency,
    rideNumbers: req.rideNumbers,
    link,
    reference: req.reference,
    instructions: org.instructions,
    bank: org.methods.includes("transfer") ? (org.bank ?? null) : null,
  });
  return whatsappLink(req.phone, text);
}

export function WhatsAppButton({ href, size = "sm", label = "WhatsApp", iconOnly, className }: { href: string | null; size?: "xs" | "sm" | "md"; label?: string; iconOnly?: boolean; className?: string }) {
  if (!href) return null;
  return (
    <Button asChild variant="outline" size={iconOnly ? (size === "md" ? "icon" : "icon-sm") : size} className={cn("text-green hover:text-green", className)}>
      <a href={href} target="_blank" rel="noopener noreferrer" title="Réclamer par WhatsApp (message prérempli)" aria-label={iconOnly ? `${label} : réclamer le paiement (nouvel onglet)` : undefined}>
        <MessageCircle />
        {!iconOnly && label}
        {!iconOnly && <NewTabHint />}
      </a>
    </Button>
  );
}

// ---------------------------------------------------------------------------- exécution des actions
export function useSettlementRunner(onChanged?: () => void) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<SettlementActionResult>, success: (r: Extract<SettlementActionResult, { ok: true }>) => string, after?: () => void) =>
    start(() => runAction(async () => {
      const res = await fn();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(success(res));
      after?.();
      if (onChanged) onChanged();
      else router.refresh();
    }));
  return { pending, run };
}

/** Relance push d'un chauffeur (une toutes les 30 min). */
export function useRemindDriver(onChanged?: () => void) {
  const { pending, run } = useSettlementRunner(onChanged);
  return {
    pending,
    remind: (driverId: string, firstName: string) =>
      run(
        () => remindDriverSettlements(driverId),
        // « Rappel envoyé à Karim par WhatsApp et l'application · 19 € » (canal choisi dans les réglages)
        (r) =>
          `${(r.message || "Rappel envoyé.").replace(/^Rappel envoyé/, `Rappel envoyé à ${firstName}`).replace(/\.$/, "")}${r.amount_cents ? ` · ${formatPrice(r.amount_cents)}` : ""}`,
      ),
  };
}

// ---------------------------------------------------------------------------- dialogues
const DISPUTE_REASONS = ["Rien reçu sur le compte", "Montant incomplet", "Référence introuvable", "Espèces non remises"];
const WAIVE_REASONS = ["Geste commercial", "Course litigieuse", "Client parti sans payer", "Erreur de prix"];

export function Chips({ options, onPick }: { options: string[]; onPick: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button key={o} type="button" onClick={() => onPick(o)} className="rounded-full border border-line px-2.5 py-1 text-[12px] text-fg-muted transition-colors hover:border-line-strong hover:text-fg">
          {o}
        </button>
      ))}
    </div>
  );
}

export function MethodPicker({
  value,
  onChange,
  options = METHOD_ORDER,
  labelledBy,
}: {
  value: ConfirmMethod | null;
  onChange: (m: ConfirmMethod) => void;
  options?: readonly ConfirmMethod[];
  /** Identifiant du libellé visible du champ (sinon : « Moyen de paiement ») */
  labelledBy?: string;
}) {
  return (
    <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label={labelledBy ? undefined : "Moyen de paiement"} aria-labelledby={labelledBy}>
      {options.map((m) => {
        const Icon = METHOD_ICON[m];
        const on = value === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(m)}
            className={cn(
              "flex min-h-11 items-center justify-center gap-2 rounded-lg border px-2 text-[13px] font-medium transition-colors sm:min-h-10",
              on ? "border-brand/60 bg-brand/[0.08] text-fg" : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
            )}
          >
            <Icon aria-hidden className={cn("size-4 shrink-0", on ? "text-brand" : "text-fg-subtle")} />
            {methodLabel(m)}
          </button>
        );
      })}
    </div>
  );
}

type ActionSettlement = Settlement & { ride?: { number: number } | null };
type DialogMode = "confirm" | "dispute" | "waive" | "reopen" | null;

function Summary({ s }: { s: ActionSettlement }) {
  const n = rideNumberOf(s);
  const who = parseDriverLabel(s.driver_label);
  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-white/[0.035] px-3.5 py-3">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-fg">{who.name}{who.number ? <span className="text-fg-muted"> #{who.number}</span> : null}</p>
        <p className="text-[12px] text-fg-muted">
          {n ? `Course #${n} · ` : ""}réf. <span className="mono">{s.reference}</span>
        </p>
      </div>
      <p className="mono shrink-0 text-[20px] font-semibold tracking-tight text-fg">{formatPrice(s.amount_cents, s.currency)}</p>
    </div>
  );
}

export function SettlementDialogs({
  settlement: s,
  mode,
  onOpenChange,
  onChanged,
}: {
  settlement: ActionSettlement;
  mode: DialogMode;
  onOpenChange: (mode: DialogMode) => void;
  onChanged?: () => void;
}) {
  const org = useCentrale();
  const { pending, run } = useSettlementRunner(onChanged);
  const owes = s.direction === "driver_owes";
  const [method, setMethod] = useState<ConfirmMethod | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (!mode) return;
    setMethod((s.declared_method as ConfirmMethod | null) ?? (owes ? "cash" : "transfer"));
    setNote("");
    setReason("");
  }, [mode, s.id, s.declared_method, owes]);
  const close = () => onOpenChange(null);
  const amount = formatPrice(s.amount_cents, s.currency);
  const who = parseDriverLabel(s.driver_label).firstName;

  return (
    <>
      <Dialog open={mode === "confirm"} onOpenChange={(o) => !o && close()}>
        <DialogContent
          size="sm"
          title={owes ? "Paiement reçu" : "Part chauffeur versée"}
          description={owes ? "Le règlement est soldé et le chauffeur est prévenu (il est débloqué s'il était en retard)." : `${who} est prévenu que sa part a été versée.`}
        >
          <Summary s={s} />
          {s.status === "declared" && (
            <p className="mb-4 rounded-lg border border-blue/25 bg-blue/[0.07] px-3 py-2 text-[13px] text-fg-muted">
              {who} signale avoir payé par <span className="font-medium text-fg">{methodLabel(s.declared_method).toLowerCase()}</span> {fromNow(s.declared_at)}
              {s.declared_note ? <> · «{NB}{s.declared_note}{NB}»</> : null}
            </p>
          )}
          <Field label={owes ? "Reçu par" : "Versé par"}>
            <MethodPicker value={method} onChange={setMethod} />
          </Field>
          <Field label="Note" optional className="mt-4">
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={owes ? `ex.${NB}: espèces remises à Mehdi` : `ex.${NB}: virement du 25/09`} />
          </Field>
          <DialogFooter backDisabled={pending}>
            <Button
              variant="primary"
              loading={pending}
              onClick={() => run(() => confirmSettlements([s.id], method, note), () => (owes ? `${amount} reçus de ${who}` : `${amount} versés à ${who}`), close)}
            >
              <Check /> {owes ? "Marquer reçu" : "Marquer versé"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mode === "dispute"} onOpenChange={(o) => !o && close()}>
        <DialogContent
          size="sm"
          title="Paiement non reçu"
          description={
            org?.blockUnpaid === false
              ? `${who} est prévenu immédiatement ; le règlement reste à encaisser.`
              : `${who} est prévenu immédiatement et ne reçoit plus de courses tant que ce paiement n'est pas réglé.`
          }
        >
          <Summary s={s} />
          <Field label="Ce qui ne va pas">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={`ex.${NB}: rien reçu sur le compte Revolut`} className="min-h-[72px]" autoFocus />
          </Field>
          <div className="mt-2.5">
            <Chips options={DISPUTE_REASONS} onPick={setReason} />
          </div>
          <DialogFooter backDisabled={pending}>
            <Button
              variant="danger"
              loading={pending}
              disabled={reason.trim().length < 3}
              onClick={() => run(() => disputeSettlement(s.id, reason), () => `Paiement contesté : ${who} est prévenu`, close)}
            >
              <CircleSlash /> Pas reçu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mode === "waive"} onOpenChange={(o) => !o && close()}>
        <DialogContent
          size="sm"
          title={owes ? "Annuler la commission" : "Annuler le versement"}
          description="Le règlement est clos sans paiement. Vous pourrez le rouvrir en cas d'erreur."
        >
          <Summary s={s} />
          <Field label="Motif">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={`ex.${NB}: geste commercial`} className="min-h-[72px]" autoFocus />
          </Field>
          <div className="mt-2.5">
            <Chips options={WAIVE_REASONS} onPick={setReason} />
          </div>
          <DialogFooter backDisabled={pending}>
            <Button
              variant="danger"
              loading={pending}
              disabled={reason.trim().length < 3}
              onClick={() => run(() => waiveSettlement(s.id, reason), () => `Règlement ${s.reference} annulé`, close)}
            >
              {owes ? "Annuler la commission" : "Annuler le versement"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mode === "reopen"} onOpenChange={(o) => !o && close()}>
        <DialogContent size="sm" title="Rouvrir le règlement" description={`Il redevient «${NB}à régler${NB}»${owes ? ` et ${who} est prévenu qu'il reste ${amount} à payer` : ""}.`}>
          <Summary s={s} />
          <DialogFooter backDisabled={pending}>
            <Button variant="primary" loading={pending} onClick={() => run(() => reopenSettlement(s.id), () => `Règlement ${s.reference} rouvert`, close)}>
              <Undo2 /> Rouvrir le règlement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------- barre d'actions
/**
 * Actions d'un règlement selon son état :
 *  commission à régler, échue ou signalée payée → Reçu · Pas reçu · WhatsApp · ⋮ (Relancer, Annuler la commission)
 *  commission à régler, pas encore échue      → Reçu · WhatsApp · ⋮ (Relancer, Pas reçu, Annuler la commission)
 *  commission contestée                        → Reçu · WhatsApp · ⋮ (Relancer, Annuler la commission)
 *  part chauffeur à verser                     → Versé · ⋮ (Annuler le versement)
 *  réglé / annulé                              → ⋮ (Rouvrir, owner / admin)
 * « Pas reçu » bloque le chauffeur : bouton direct seulement s'il a déclaré avoir payé ou si l'échéance est passée
 * (`overdue`), sinon dans le menu — même fenêtre, motif obligatoire.
 * Actions de LIGNE : jamais en bouton plein (principe 2 de docs/REFONTE-PANELS.md, un seul bouton lime par écran,
 * celui de la page) ; « Reçu » / « Versé » se distinguent par leur icône lime. 44 px au toucher sous 640 px.
 */
export function SettlementActions({
  settlement: s,
  canManage,
  whatsapp,
  size = "sm",
  showRemind = true,
  onChanged,
  className,
}: {
  settlement: ActionSettlement;
  canManage: boolean;
  /** Lien WhatsApp déjà calculé (sinon : réclamation de ce seul règlement) */
  whatsapp?: string | null;
  size?: "xs" | "sm";
  showRemind?: boolean;
  onChanged?: () => void;
  className?: string;
}) {
  const [mode, setMode] = useState<DialogMode>(null);
  const open = s.status === "due" || s.status === "declared" || s.status === "disputed";
  const owes = s.direction === "driver_owes";
  const who = parseDriverLabel(s.driver_label);
  const contact = useDriverContact(whatsapp === undefined && owes && (s.status === "due" || s.status === "disputed") ? s.driver_id : null);
  const n = rideNumberOf(s);
  const computed = useSettlementWhatsApp(
    whatsapp === undefined && owes && (s.status === "due" || s.status === "disputed") && contact
      ? { phone: contact.phone, firstName: contact.first_name, amountCents: s.amount_cents, currency: s.currency, rideNumbers: [n ?? s.reference], reference: s.reference }
      : null,
  );
  const wa = whatsapp === undefined ? computed : whatsapp;
  const { pending: reminding, remind } = useRemindDriver(onChanged);
  // « Pas reçu » : bouton direct si le chauffeur a déclaré avoir payé ou si l'échéance est passée ; sinon dans le menu
  const canDispute = open && owes && s.status !== "disputed";
  const disputeDirect = canDispute && (s.status === "declared" || (s.status === "due" && !!s.overdue));
  const menuRemind = showRemind && owes && (s.status === "due" || s.status === "disputed") && !!s.driver_id;
  const menuDispute = canDispute && !disputeDirect;
  const menuWaive = canManage && open;
  const menuReopen = canManage && !open;
  const btn = size === "xs" ? "xs" : "sm";
  const ref = n ? `course #${n}` : `règlement ${s.reference}`;
  // Cible tactile : 44 px de haut (boutons) ou de côté (icônes) sous 640 px
  const touch = "max-sm:h-11 max-sm:px-3.5";
  const touchIcon = "max-sm:size-11";

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {open && owes && (
        <>
          <Button variant="secondary" size={btn} className={cn(touch, "[&_svg]:text-brand")} onClick={() => setMode("confirm")}>
            <Check /> Reçu
          </Button>
          {disputeDirect && (
            <Button variant="outline" size={btn} className={touch} onClick={() => setMode("dispute")}>
              Pas reçu
            </Button>
          )}
          {wa && <WhatsAppButton href={wa} size={btn} iconOnly={size === "xs"} className={size === "xs" ? touchIcon : touch} />}
        </>
      )}
      {open && !owes && (
        <Button variant="secondary" size={btn} className={cn(touch, "[&_svg]:text-brand")} onClick={() => setMode("confirm")}>
          <Check /> Versé
        </Button>
      )}
      {(menuRemind || menuDispute || menuWaive || menuReopen) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className={touchIcon} aria-label={`Plus d'actions : ${ref}`} disabled={reminding}>
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[240px]">
            {menuRemind && (
              <DropdownMenuItem onSelect={() => remind(s.driver_id!, who.firstName)}>
                <BellRing /> Relancer {who.firstName}
              </DropdownMenuItem>
            )}
            {menuReopen && (
              <DropdownMenuItem onSelect={() => setMode("reopen")}>
                <RotateCcw /> Rouvrir le règlement
              </DropdownMenuItem>
            )}
            {(menuRemind || menuReopen) && (menuDispute || menuWaive) && <DropdownMenuSeparator />}
            {menuDispute && (
              <DropdownMenuItem destructive onSelect={() => setMode("dispute")}>
                <CircleSlash /> Pas reçu
              </DropdownMenuItem>
            )}
            {menuWaive && (
              <DropdownMenuItem destructive onSelect={() => setMode("waive")}>
                <CircleSlash /> {owes ? "Annuler la commission" : "Annuler le versement"}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <SettlementDialogs settlement={s} mode={mode} onOpenChange={setMode} onChanged={onChanged} />
    </div>
  );
}

/** « Espèces · il y a 2 h · « Donné à Mehdi » » (déclaration « J'ai payé » du chauffeur). */
export function DeclarationLine({ settlement: s, now, className }: { settlement: Pick<Settlement, "declared_at" | "declared_method" | "declared_note">; now?: number; className?: string }) {
  if (!s.declared_at) return null;
  const Icon = s.declared_method ? METHOD_ICON[s.declared_method] : Ellipsis;
  const title = [`Payé par ${methodLabel(s.declared_method).toLowerCase()}`, fromNow(s.declared_at, now), s.declared_note ? `«${NB}${s.declared_note}${NB}»` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <p className={cn("flex min-w-0 items-center gap-1.5 text-[12px] text-blue", className)} title={title}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">
        {methodLabel(s.declared_method ?? "other")} · {fromNow(s.declared_at, now)}
        {s.declared_note ? <span className="text-fg-muted"> · «{NB}{s.declared_note}{NB}»</span> : null}
      </span>
    </p>
  );
}
