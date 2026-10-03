"use client";
// Super admin, compte d'une centrale ou d'une flotte : paiement reçu directement, avoir / frais ajoutés, relance, conditions.
import { PLATFORM_CYCLE_META, formatPrice, formatTime, type PlatformAccount, type PlatformBillingCycle, type PlatformPaymentMethod } from "@rydar/shared";
import { BellRing, CalendarClock, Check, HandCoins, Minus, Plus, Scale } from "lucide-react";
import { useEffect, useState } from "react";
import {
  adjustPlatformFees, platformWhatsAppTarget, recordPlatformPayment, remindPlatformCentrale, updatePlatformTerms, type PlatformWhatsAppTarget,
} from "@/app/admin/frais/actions";
import { centsToInput, eurosToCents } from "@/components/admin/fees";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/misc";
import { cn, submitWith } from "@/lib/utils";
import { ago, formatDay } from "./admin-platform-format";
import { AmountInput, Chips, PlatformMethodPicker, usePlatformRunner } from "./admin-platform-dialogs";

type Errors = Record<string, string>;
type AccountLite = Pick<
  PlatformAccount,
  "balance_cents" | "due_cents" | "currency" | "reference" | "reminded_at" | "reminder_note" | "declared_cents" | "overdue_since" | "days_overdue"
  | "dispatch_model"
>;

/** « flotte » / « centrale » (textes des dialogues ; modèle inconnu : centrale, comme avant les frais des flottes). */
const who = (a: Pick<PlatformAccount, "dispatch_model">) => (a.dispatch_model === "fleet" ? "flotte" : "centrale");

/** Aujourd'hui (AAAA-MM-JJ) dans le fuseau donné. */
function today(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// ---------------------------------------------------------------------------- paiement reçu directement
function RecordPaymentDialog({
  open,
  onOpenChange,
  orgId,
  orgName,
  account,
  timeZone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  orgId: string;
  orgName: string;
  account: AccountLite;
  timeZone: string;
}) {
  const { pending, run } = usePlatformRunner();
  const suggested = account.due_cents > 0 ? account.due_cents : Math.max(0, account.balance_cents);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PlatformPaymentMethod>("transfer");
  const [errors, setErrors] = useState<Errors>({});
  useEffect(() => {
    if (!open) return;
    setAmount(suggested ? centsToInput(suggested) : "");
    setMethod("transfer");
    setErrors({});
  }, [open, suggested]);
  const cents = eurosToCents(amount);
  const after = Number.isFinite(cents) ? account.balance_cents - cents : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        title="Enregistrer un paiement reçu"
        description={`Paiement de ${orgName} arrivé sans déclaration (virement, espèces…) : il est compté tout de suite.`}
      >
        <form
          noValidate
          onSubmit={submitWith((fd) => {
            const amountCents = eurosToCents(String(fd.get("amount") ?? ""));
            // Montant illisible (« 12,345 », « abc ») : message clair plutôt que l'erreur de type de zod
            if (!Number.isFinite(amountCents)) return setErrors({ amountCents: "Montant invalide" });
            run(
              () =>
                recordPlatformPayment(orgId, {
                  amountCents,
                  method,
                  reference: String(fd.get("reference") ?? ""),
                  note: String(fd.get("note") ?? ""),
                  paidOn: String(fd.get("paidOn") ?? ""),
                }),
              { onDone: () => onOpenChange(false), onError: (res) => setErrors(res.fieldErrors ?? {}) },
            );
          })}
          className="space-y-4"
        >
          <Field
            label="Montant reçu"
            htmlFor="rp-amount"
            error={errors.amountCents}
            hint={
              after != null && cents > 0 ? (
                <>
                  Solde après ce paiement&nbsp;: <span className={cn("mono", after > 0 ? "text-amber" : "text-green")}>{formatPrice(after, account.currency)}</span>
                </>
              ) : suggested ? (
                `Dû actuellement : ${formatPrice(suggested, account.currency)}`
              ) : undefined
            }
          >
            <AmountInput id="rp-amount" name="amount" value={amount} onChange={(e) => setAmount(e.target.value)} invalid={!!errors.amountCents} autoFocus />
          </Field>
          <Field label="Moyen de paiement" error={errors.method}>
            <PlatformMethodPicker value={method} onChange={setMethod} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Référence" optional htmlFor="rp-ref" error={errors.reference}>
              <Input id="rp-ref" name="reference" maxLength={80} placeholder={account.reference} className="mono" />
            </Field>
            <Field label="Date du paiement" htmlFor="rp-date" error={errors.paidOn}>
              <Input id="rp-date" name="paidOn" type="date" defaultValue={today(timeZone)} max={today(timeZone)} className="num" />
            </Field>
          </div>
          <Field label="Note" optional htmlFor="rp-note" error={errors.note}>
            <Input id="rp-note" name="note" maxLength={500} placeholder="Ex. espèces remises au bureau" />
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              <Check /> Enregistrer
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- avoir / frais ajoutés
// CGV art. 5 : l'éditeur inscrit au relevé, avec son motif, un avoir ou la correction d'une erreur de calcul des frais ;
// aucun autre montant sans l'accord écrit de l'organisation (le code ne le contrôle pas : motif à préciser).
const CREDIT_REASONS = ["Geste commercial", "Erreur de calcul des frais", "Course litigieuse remboursée"] as const;
const CHARGE_REASONS = ["Erreur de calcul des frais", "Accord écrit de l'organisation du"] as const;

function AdjustDialog({
  open,
  onOpenChange,
  orgId,
  orgName,
  account,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  orgId: string;
  orgName: string;
  account: AccountLite;
}) {
  const { pending, run } = usePlatformRunner();
  const [kind, setKind] = useState<"credit" | "charge">("credit");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  useEffect(() => {
    if (!open) return;
    setKind("credit");
    setAmount("");
    setReason("");
    setErrors({});
  }, [open]);
  const cents = eurosToCents(amount);
  const signed = Number.isFinite(cents) && cents > 0 ? (kind === "credit" ? -cents : cents) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        title="Avoir ou frais ajoutés"
        description={`Écriture manuelle sur le compte de ${orgName}, visible par la ${who(account)} avec son motif.`}
      >
        <form
          noValidate
          onSubmit={submitWith(() =>
            run(() => adjustPlatformFees(orgId, { amountCents: signed ?? Number.NaN, reason }), {
              onDone: () => onOpenChange(false),
              onError: (res) => setErrors(res.fieldErrors ?? {}),
            }),
          )}
          className="space-y-4"
        >
          <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Type d'écriture">
            {(
              [
                { v: "credit", label: "Avoir", hint: `en faveur de la ${who(account)}`, icon: Minus },
                { v: "charge", label: "Frais ajoutés", hint: "dus à Rydar", icon: Plus },
              ] as const
            ).map((o) => {
              const on = kind === o.v;
              return (
                <button
                  key={o.v}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setKind(o.v)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                    on ? "border-brand/60 bg-brand/[0.08]" : "border-line hover:border-line-strong",
                  )}
                >
                  <o.icon className={cn("size-4 shrink-0", on ? "text-brand" : "text-fg-subtle")} />
                  <span className="min-w-0">
                    <span className={cn("block text-[13px] font-medium", on ? "text-fg" : "text-fg-muted")}>{o.label}</span>
                    <span className="block text-[11.5px] text-fg-subtle">{o.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <Field
            label="Montant"
            htmlFor="adj-amount"
            error={errors.amountCents}
            hint={
              signed != null ? (
                <>
                  Solde après&nbsp;: <span className="mono text-fg-muted">{formatPrice(account.balance_cents + signed, account.currency)}</span>
                </>
              ) : undefined
            }
          >
            <AmountInput id="adj-amount" value={amount} onChange={(e) => setAmount(e.target.value)} invalid={!!errors.amountCents} autoFocus />
          </Field>
          <Field label="Motif" htmlFor="adj-reason" error={errors.reason}>
            <Textarea
              id="adj-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              className="min-h-[72px]"
              placeholder={kind === "credit" ? "Ex. geste commercial pour septembre" : "Ex. erreur de calcul des frais de la course 1692"}
              aria-invalid={!!errors.reason || undefined}
            />
          </Field>
          <Chips options={kind === "credit" ? CREDIT_REASONS : CHARGE_REASONS} onPick={setReason} />
          {kind === "charge" && (
            <p className="text-[12px] leading-relaxed text-fg-muted">
              CGV, article 5{"\u00a0"}: des frais ajoutés corrigent une erreur de calcul des frais{"\u00a0"}; tout autre montant
              demande l&apos;accord écrit de l&apos;organisation (date et forme dans le motif).
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="primary" loading={pending} disabled={signed == null || reason.trim().length < 3}>
              <Check /> {kind === "credit" ? "Accorder l'avoir" : "Ajouter les frais"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- relance
function RemindDialog({
  open,
  onOpenChange,
  orgId,
  orgName,
  account,
  timeZone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  orgId: string;
  orgName: string;
  account: AccountLite;
  timeZone: string;
}) {
  const { pending, run } = usePlatformRunner();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [openedAt, setOpenedAt] = useState(0);
  const [wa, setWa] = useState<PlatformWhatsAppTarget | null>(null);
  const [viaWhatsApp, setViaWhatsApp] = useState(false);
  useEffect(() => {
    if (!open) return;
    setNote("");
    setError(null);
    setOpenedAt(Date.now());
    setWa(null);
    setViaWhatsApp(false);
    let live = true;
    // Relance WhatsApp possible ? (numéro de Rydar relié, téléphone du propriétaire ou de l'organisation)
    void platformWhatsAppTarget(orgId).then((t) => {
      if (!live) return;
      setWa(t);
      setViaWhatsApp(!!t?.ready && !!t.to_display);
    });
    return () => {
      live = false;
    };
  }, [open, orgId]);
  const waOk = !!wa?.ready && !!wa.to_display;
  const amount = account.due_cents > 0 ? account.due_cents : account.balance_cents;
  // Une relance par heure au plus (vérifié aussi en base) : on prévient avant l'envoi
  const nextAt = account.reminded_at ? Date.parse(account.reminded_at) + 3_600_000 : 0;
  const tooSoon = openedAt > 0 && nextAt > openedAt;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        title={`Relancer la ${who(account)}`}
        description={`Un rappel s'affiche dans le tableau de bord de ${orgName} (une relance par heure au plus).`}
      >
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-white/[0.035] px-3.5 py-3">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-fg">{orgName}</p>
            <p className="text-[12px] text-fg-subtle" suppressHydrationWarning>
              {account.due_cents > 0 ? "Échu" : "Solde"}
              {account.reminded_at ? ` · dernière relance ${ago(account.reminded_at)}` : " · jamais relancée"}
            </p>
          </div>
          <p className={cn("mono shrink-0 text-[20px] font-semibold tracking-tight", account.overdue_since ? "text-red" : "text-amber")}>
            {formatPrice(Math.max(0, amount), account.currency)}
          </p>
        </div>
        {account.reminder_note && (
          <p className="mb-4 text-[12.5px] text-fg-muted">
            Précédent message ({formatDay(account.reminded_at, timeZone, false)})&nbsp;: «&nbsp;{account.reminder_note}&nbsp;»
          </p>
        )}
        <form
          onSubmit={submitWith(() =>
            run(() => remindPlatformCentrale(orgId, note, viaWhatsApp && waOk), { onDone: () => onOpenChange(false), onError: (res) => setError(res.error) }),
          )}
        >
          <Field
            label="Message"
            optional
            htmlFor="remind-note"
            error={error ?? undefined}
            hint={
              tooSoon ? (
                <span className="text-amber">Relance déjà envoyée&nbsp;: prochaine possible à {formatTime(new Date(nextAt), timeZone)}.</span>
              ) : (
                `${note.length}/300`
              )
            }
          >
            <Textarea
              id="remind-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              className="min-h-[72px]"
              placeholder="Ex. merci de régler les frais de septembre avant vendredi"
              autoFocus
            />
          </Field>
          <label className={cn("mt-4 flex items-center justify-between gap-4 rounded-xl border border-line bg-white/[0.02] px-4 py-3", !waOk && "opacity-70")}>
            <span className="min-w-0">
              <span className="block text-[13.5px] font-medium">Envoyer aussi par WhatsApp</span>
              <span className="block text-[12px] text-fg-subtle">
                {wa == null
                  ? "Vérification…"
                  : waOk
                    ? `Au ${wa.source === "owner" ? "propriétaire" : `numéro de la ${who(account)}`}${wa.name ? ` (${wa.name})` : ""} : ${wa.to_display}. Modèle validé par Meta, sans votre message.`
                    : wa.reason === "FLEET_UNSUPPORTED"
                      ? "Indisponible pour une flotte : le modèle approuvé par Meta renvoie à l'onglet « Encaissements », absent d'une flotte. La relance reste affichée dans son tableau de bord."
                      : wa.reason === "NOT_CONFIGURED"
                        ? "Reliez le numéro WhatsApp de Rydar (Frais plateforme › WhatsApp)."
                        : `Aucun numéro valide pour le propriétaire ni pour la ${who(account)}.`}
              </span>
            </span>
            <Switch checked={viaWhatsApp && waOk} onCheckedChange={setViaWhatsApp} disabled={!waOk} aria-label="Envoyer aussi par WhatsApp" />
          </label>
          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="primary" loading={pending} disabled={tooSoon}>
              <BellRing /> Relancer
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Boutons d'en-tête du compte : paiement reçu, avoir / frais, relance. */
export function AccountActions({ orgId, orgName, account, timeZone }: { orgId: string; orgName: string; account: AccountLite; timeZone: string }) {
  const [open, setOpen] = useState<"record" | "adjust" | "remind" | null>(null);
  const set = (k: typeof open) => (o: boolean) => setOpen(o ? k : null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" size="sm" onClick={() => setOpen("record")}>
        <HandCoins /> Enregistrer un paiement reçu
      </Button>
      <Button variant="outline" size="sm" onClick={() => setOpen("adjust")}>
        <Scale /> Avoir / frais ajoutés
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen("remind")}
        disabled={account.balance_cents <= 0}
        title={account.balance_cents <= 0 ? "Rien à régler" : undefined}
      >
        <BellRing /> Relancer
      </Button>
      <RecordPaymentDialog open={open === "record"} onOpenChange={set("record")} orgId={orgId} orgName={orgName} account={account} timeZone={timeZone} />
      <AdjustDialog open={open === "adjust"} onOpenChange={set("adjust")} orgId={orgId} orgName={orgName} account={account} />
      <RemindDialog open={open === "remind"} onOpenChange={set("remind")} orgId={orgId} orgName={orgName} account={account} timeZone={timeZone} />
    </div>
  );
}

// ---------------------------------------------------------------------------- conditions
/** Cycle de facturation, délai de paiement et blocage après N jours de retard (ou jamais). */
export function TermsForm({
  orgId,
  cycle,
  paymentDays,
  blockAfterDays,
}: {
  orgId: string;
  cycle: PlatformBillingCycle;
  paymentDays: number;
  blockAfterDays: number | null;
}) {
  const { pending, run } = usePlatformRunner();
  const [value, setValue] = useState<PlatformBillingCycle>(cycle);
  const [days, setDays] = useState(String(paymentDays));
  const [block, setBlock] = useState(blockAfterDays != null);
  const [blockDays, setBlockDays] = useState(String(blockAfterDays ?? 15));
  const [consent, setConsent] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  useEffect(() => {
    setValue(cycle);
    setDays(String(paymentDays));
    setBlock(blockAfterDays != null);
    setBlockDays(String(blockAfterDays ?? 15));
    setConsent("");
  }, [cycle, paymentDays, blockAfterDays]);
  // Même règle que svc_platform_terms : délai raccourci, mensuel → hebdomadaire, blocage ajouté ou plus tôt
  const unfavorable =
    (days.trim() !== "" && Number(days) < paymentDays) ||
    (cycle === "monthly" && value === "weekly") ||
    (block && blockDays.trim() !== "" && (blockAfterDays == null || Number(blockDays) < blockAfterDays));
  const dirty =
    value !== cycle ||
    days.trim() !== String(paymentDays) ||
    block !== (blockAfterDays != null) ||
    (block && blockDays.trim() !== String(blockAfterDays ?? ""));

  return (
    <form
      noValidate
      onSubmit={submitWith(() => {
        // Champs vides : erreur sur le champ (un blocage activé sans nombre de jours ne doit pas être enregistré « désactivé »)
        const missing: Errors = {};
        if (!days.trim()) missing.paymentDays = "Entre 0 et 45 jours";
        if (block && !blockDays.trim()) missing.blockAfterDays = "Entre 1 et 90 jours";
        if (unfavorable && consent.trim().length < 3) missing.consentNote = "Notez l'accord écrit de l'organisation";
        if (Object.keys(missing).length) return setErrors(missing);
        const consentNote = unfavorable ? consent : null;
        run(() => updatePlatformTerms(orgId, { cycle: value, paymentDays: days, blockAfterDays: block ? blockDays : null, consentNote }), {
          onDone: () => setErrors({}),
          onError: (res) => setErrors(res.fieldErrors ?? {}),
        });
      })}
      className="space-y-5"
    >
      <Field label="Cycle de facturation" error={errors.cycle}>
        <div className="grid gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label="Cycle de facturation">
          {(["monthly", "weekly"] as const).map((c) => {
            const on = value === c;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setValue(c)}
                className={cn(
                  "rounded-lg border px-3 py-2.5 text-left transition-colors",
                  on ? "border-brand/60 bg-brand/[0.08]" : "border-line hover:border-line-strong",
                )}
              >
                <span className={cn("flex items-center gap-2 text-[13px] font-medium", on ? "text-fg" : "text-fg-muted")}>
                  <CalendarClock className={cn("size-4", on ? "text-brand" : "text-fg-subtle")} /> {PLATFORM_CYCLE_META[c].label}
                </span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-fg-subtle">{PLATFORM_CYCLE_META[c].hint}</span>
              </button>
            );
          })}
        </div>
      </Field>
      <Field
        label="Délai de paiement"
        htmlFor="terms-days"
        error={errors.paymentDays}
        hint={"Jours accordés après la fin du cycle (0 à 45\u00a0: la facture récapitulative de chaque cycle est une facture périodique, article L441-10 du Code de commerce)."}
      >
        <div className="relative max-w-[180px]">
          <Input
            id="terms-days"
            inputMode="numeric"
            value={days}
            onChange={(e) => setDays(e.target.value.replace(/\D/g, "").slice(0, 2))}
            className="num pr-14"
            aria-invalid={!!errors.paymentDays || undefined}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-fg-subtle">jours</span>
        </div>
      </Field>
      <div className="rounded-xl border border-line p-3.5">
        <label className="flex cursor-pointer items-start justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-fg">Bloquer la création de courses en cas de retard</span>
            <span className="mt-0.5 block text-[12px] leading-snug text-fg-muted">
              Suspendu 7&nbsp;jours au plus par un paiement déclaré qui couvre la somme échue (comptés depuis la première
              déclaration des 30 derniers jours)&nbsp;; aucune suspension dans les 7&nbsp;jours qui suivent un «&nbsp;Pas reçu&nbsp;».
            </span>
            <span className="mt-1 block text-[12px] leading-snug text-amber">
              À activer seulement si la facture récapitulative de chaque cycle est envoyée à l&apos;organisation dès la fin du
              cycle (export «&nbsp;Frais à facturer&nbsp;» ci-dessous) et si elle a accepté les CGV en vigueur&nbsp;: un blocage pour une
              somme non facturée, ou sur des conditions qu&apos;elle n&apos;a pas acceptées, est contestable.
            </span>
          </span>
          <Switch checked={block} onCheckedChange={setBlock} aria-label="Blocage en cas de retard" />
        </label>
        {block && (
          <Field label="Après" htmlFor="terms-block" error={errors.blockAfterDays} hint="Jours de retard sur un montant échu (1 à 90)." className="mt-3">
            <div className="relative max-w-[180px]">
              <Input
                id="terms-block"
                inputMode="numeric"
                value={blockDays}
                onChange={(e) => setBlockDays(e.target.value.replace(/\D/g, "").slice(0, 2))}
                className="num pr-14"
                aria-invalid={!!errors.blockAfterDays || undefined}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-fg-subtle">jours</span>
            </div>
          </Field>
        )}
      </div>
      {unfavorable && (
        <Field
          label="Accord écrit de l'organisation"
          htmlFor="terms-consent"
          error={errors.consentNote}
          hint="Changement en sa défaveur (délai raccourci, cycle hebdomadaire, blocage ajouté ou plus tôt) : date et forme de son accord (CGV, article 5). Journalisé."
        >
          <Textarea
            id="terms-consent"
            value={consent}
            onChange={(e) => setConsent(e.target.value.slice(0, 500))}
            rows={2}
            aria-invalid={!!errors.consentNote || undefined}
          />
        </Field>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] text-fg-subtle">
          Les frais déjà enregistrés gardent leur échéance. Changement en défaveur de l&apos;organisation (délai raccourci,
          blocage)&nbsp;: seulement avec son accord écrit (CGV, article 5).
        </p>
        <Button type="submit" variant="primary" size="sm" loading={pending} disabled={!dirty}>
          <Check /> Enregistrer
        </Button>
      </div>
    </form>
  );
}
