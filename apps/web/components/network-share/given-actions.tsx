"use client";
// « Courses confiées » : décisions sur une course partagée (owner / admin) — Reçu, Pas reçu, Annuler (payée à bord),
// Versé (RIB du chauffeur en feuille latérale), Valider, Contester la course, Rouvrir, Exclure ce chauffeur,
// Ne plus travailler avec {organisation} ; « Relancer » (application) pour tout membre, dispatcher compris.
// Chaque bouton appelle une action serveur (app/dashboard/reseau-partage/actions.ts) puis relit la page.
import { formatIban, formatPrice, type NetworkGivenItem, type OrgNetworkPayoutInfo } from "@rydar/shared";
import {
  Ban, BellRing, Check, CircleSlash, Copy, EllipsisVertical, Landmark, RotateCcw, ShieldAlert, ShieldCheck, Undo2, UserX,
} from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  confirmNetworkSettlement, contestNetworkRide, disputeNetworkSettlement, excludeNetworkDriver, getNetworkPayoutInfo,
  remindNetworkDriver, reopenNetworkSettlement, setNetworkPartnerExcluded, validateNetworkRide, waiveNetworkSettlement,
} from "@/app/dashboard/reseau-partage/actions";
import type { GivenRowActions } from "@/components/network-share/given";
import { useNetworkRunner } from "@/components/network-share/use-network-runner";
import { useCentrale } from "@/components/settlements/centrale-context";
import { Chips, MethodPicker, fromNow, methodLabel, type ConfirmMethod } from "@/components/settlements/settlement-ui";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, SheetContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from "@/components/ui/misc";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";

type Mode = "confirm" | "dispute" | "waive" | "reopen" | "contest" | "excludeDriver" | "excludePartner" | "payout" | null;

const DISPUTE_REASONS = ["Rien reçu sur le compte", "Montant incomplet", "Référence introuvable", "Espèces non remises"];
const WAIVE_REASONS = ["Geste commercial", "Course litigieuse", "Client parti sans payer", "Erreur de prix"];
const CONTEST_REASONS = ["Course non effectuée", "Client jamais pris en charge", "Trajet très différent", "Course terminée trop tôt"];

/** Bandeau récapitulatif des fenêtres : chauffeur · organisation, course, montant. */
function Summary({ item }: { item: NetworkGivenItem }) {
  const s = item.settlement;
  const amount = s?.amount_cents ?? item.execution.terms.amount_cents;
  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-white/[0.035] px-3.5 py-3">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-fg">
          {item.execution.driver_label} <span className="text-violet">· {item.execution.partner.name}</span>
        </p>
        <p className="text-[12px] text-fg-subtle">
          Course #{item.ride.number} · réf. <span className="mono text-fg-muted">{s?.reference ?? `R${item.ride.number}`}</span>
        </p>
      </div>
      <p className="mono shrink-0 text-[20px] font-semibold tracking-tight text-fg">{formatPrice(amount, item.ride.currency)}</p>
    </div>
  );
}

export function GivenActions({
  item,
  can,
  className,
}: {
  item: NetworkGivenItem;
  can: GivenRowActions;
  className?: string;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const { pending, run } = useNetworkRunner();
  const s = item.settlement;
  const driver = item.execution.driver_label;
  const partner = item.execution.partner.name;
  const menu = [can.remind && can.confirm, can.waive, can.contest, can.reopen, can.excludeDriver, can.excludePartner].some(Boolean);
  const remind = () => s && run(() => remindNetworkDriver(s.id));
  const close = () => setMode(null);

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {can.confirm && (
        <Button variant="primary" size="xs" onClick={() => setMode("confirm")}>
          <Check /> Reçu
        </Button>
      )}
      {can.dispute && (
        <Button variant="outline" size="xs" onClick={() => setMode("dispute")}>
          Pas reçu
        </Button>
      )}
      {can.payout && (
        <Button variant="primary" size="xs" onClick={() => setMode("payout")}>
          <Landmark /> Versé
        </Button>
      )}
      {can.validate && (
        <Tooltip content="Course contrôlée : le versement retenu devient payable">
          <Button variant="outline" size="xs" loading={pending} onClick={() => run(() => validateNetworkRide(item.ride.id))}>
            <ShieldCheck /> Valider
          </Button>
        </Tooltip>
      )}
      {/* Dispatcher : seule action permise, en bouton ; owner / admin : dans le menu */}
      {can.remind && !can.confirm && (
        <Tooltip content="Notification dans l'application (1 rappel / 30 min)">
          <Button variant="secondary" size="xs" loading={pending} onClick={remind}>
            <BellRing /> Relancer
          </Button>
        </Tooltip>
      )}
      {menu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Plus d'actions" disabled={pending}>
              <EllipsisVertical />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[250px]">
            {can.remind && can.confirm && (
              <DropdownMenuItem onSelect={remind}>
                <BellRing /> Relancer {driver} (application)
              </DropdownMenuItem>
            )}
            {can.reopen && (
              <DropdownMenuItem onSelect={() => setMode("reopen")}>
                <Undo2 /> Rouvrir le règlement
              </DropdownMenuItem>
            )}
            {can.waive && (
              <DropdownMenuItem destructive onSelect={() => setMode("waive")}>
                <CircleSlash /> Annuler le reversement
              </DropdownMenuItem>
            )}
            {can.contest && (
              <DropdownMenuItem destructive onSelect={() => setMode("contest")}>
                <ShieldAlert /> Contester la course
              </DropdownMenuItem>
            )}
            {(can.excludeDriver || can.excludePartner) && <DropdownMenuSeparator />}
            {can.excludeDriver && (
              <DropdownMenuItem destructive onSelect={() => setMode("excludeDriver")}>
                <UserX /> Exclure ce chauffeur
              </DropdownMenuItem>
            )}
            {can.excludePartner && (
              <DropdownMenuItem destructive onSelect={() => setMode("excludePartner")}>
                <Ban /> Ne plus travailler avec {partner}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Fenêtres montées seulement quand elles s'ouvrent (une liste peut compter 500 lignes) */}
      {s && mode === "confirm" && <ConfirmDialog item={item} open onClose={close} />}
      {s && (mode === "dispute" || mode === "waive") && <ReasonDialog kind={mode} item={item} open onClose={close} />}
      {s && mode === "reopen" && <ReopenDialog item={item} open onClose={close} />}
      {s && mode === "payout" && <PayoutSheet item={item} open onClose={close} />}
      {(mode === "contest" || mode === "excludeDriver") && <ReasonDialog kind={mode} item={item} open onClose={close} />}
      {mode === "excludePartner" && <ExcludePartnerDialog item={item} open onClose={close} />}
    </div>
  );
}

// ---------------------------------------------------------------------------- « Reçu »
function ConfirmDialog({ item, open, onClose }: { item: NetworkGivenItem; open: boolean; onClose: () => void }) {
  const s = item.settlement!;
  const { pending, run } = useNetworkRunner();
  const [method, setMethod] = useState<ConfirmMethod | null>(null);
  useEffect(() => {
    if (open) setMethod((s.declared_method as ConfirmMethod | null) ?? "cash");
  }, [open, s.declared_method]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm" title="Paiement reçu" description={`Le règlement est soldé et ${item.execution.driver_label} est prévenu.`}>
        <Summary item={item} />
        {s.status === "declared" && (
          <p className="mb-4 rounded-lg border border-blue/25 bg-blue/[0.07] px-3 py-2 text-[12.5px] text-fg-muted">
            Le chauffeur signale avoir payé par <span className="font-medium text-fg">{methodLabel(s.declared_method).toLowerCase()}</span> {fromNow(s.declared_at)}
            {s.declared_note ? <> · « {s.declared_note} »</> : null}
          </p>
        )}
        <form onSubmit={submitWith((data) => run(() => confirmNetworkSettlement(s.id, method, String(data.get("note") ?? "")), onClose))}>
          <Field label="Reçu par">
            <MethodPicker value={method} onChange={setMethod} />
          </Field>
          <Field label="Note" optional className="mt-4">
            <Input name="note" maxLength={500} placeholder="Ex. virement reçu le 25/09" />
          </Field>
          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Annuler</Button>
            <Button type="submit" variant="primary" loading={pending}>
              <Check /> Marquer reçu
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- Pas reçu / Annuler / Contester / Exclure
const REASON_COPY = {
  dispute: {
    title: "Paiement non reçu",
    label: "Ce qui ne va pas",
    placeholder: "Ex. rien reçu sur le compte",
    button: "Pas reçu",
    chips: DISPUTE_REASONS,
    min: 3,
    optional: false,
  },
  waive: {
    title: "Annuler le reversement",
    label: "Motif",
    placeholder: "Ex. geste commercial",
    button: "Annuler le reversement",
    chips: WAIVE_REASONS,
    min: 3,
    optional: false,
  },
  contest: {
    title: "Contester la course",
    label: "Ce qui ne va pas",
    placeholder: "Ex. le client n'a jamais été pris en charge",
    button: "Contester la course",
    chips: CONTEST_REASONS,
    min: 5,
    optional: false,
  },
  excludeDriver: {
    title: "Exclure ce chauffeur",
    label: "Motif (pour vous)",
    placeholder: "Ex. retard important",
    button: "Exclure",
    chips: [] as string[],
    min: 0,
    optional: true,
  },
} as const;

function ReasonDialog({ kind, item, open, onClose }: { kind: keyof typeof REASON_COPY; item: NetworkGivenItem; open: boolean; onClose: () => void }) {
  const copy = REASON_COPY[kind];
  const { pending, run } = useNetworkRunner();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const centrale = useCentrale();
  useEffect(() => {
    if (open) {
      setReason("");
      setError(null);
    }
  }, [open]);
  const driver = item.execution.driver_label;
  const owes = (item.settlement?.direction ?? item.execution.terms.direction) === "driver_owes";
  const description = {
    dispute:
      centrale?.blockUnpaid === false
        ? `${driver} est prévenu immédiatement ; le règlement reste à encaisser.`
        : `${driver} est prévenu immédiatement. Tant que ce paiement n'est pas réglé, il ne reçoit plus vos courses (rien ne change pour ses autres courses).`,
    waive: `Le règlement est clos sans paiement : ${driver} ne vous doit plus rien pour cette course. Vous pourrez le rouvrir en cas d'erreur.`,
    contest: `À utiliser si la course n'a pas été faite comme prévu. ${
      owes ? "Le reversement reste dû." : "Le versement au chauffeur est annulé."
    } Rydar examine la baisse de ses frais pour cette course. ${driver} est prévenu et peut répondre.`,
    excludeDriver: `${driver} ne recevra plus vos courses, quelle que soit son organisation. Les courses en cours vont à leur terme ; vous pourrez lever l'exclusion dans Réglages › Options avancées.`,
  }[kind];
  const submit = () => {
    const v = reason.trim();
    if (!copy.optional && v.length < copy.min) return setError(copy.min > 3 ? `${copy.min} caractères au minimum.` : "Précisez le motif.");
    setError(null);
    const s = item.settlement;
    if (kind === "dispute" && s) run(() => disputeNetworkSettlement(s.id, v), onClose);
    else if (kind === "waive" && s) run(() => waiveNetworkSettlement(s.id, v), onClose);
    else if (kind === "contest") run(() => contestNetworkRide(item.ride.id, v), onClose);
    else if (kind === "excludeDriver") run(() => excludeNetworkDriver(item.execution.id, v || null), onClose);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm" title={copy.title} description={description}>
        <Summary item={item} />
        <form onSubmit={submitWith(submit)}>
          <Field label={copy.label} optional={copy.optional} error={error ?? undefined}>
            <Textarea
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={kind === "contest" || kind === "excludeDriver" ? 300 : 500}
              placeholder={copy.placeholder}
              className="min-h-[72px]"
              aria-invalid={!!error}
              autoFocus
            />
          </Field>
          {copy.chips.length > 0 && (
            <div className="mt-2.5">
              <Chips options={[...copy.chips]} onPick={setReason} />
            </div>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Retour</Button>
            <Button type="submit" variant="danger" loading={pending}>
              {kind === "excludeDriver" ? <UserX /> : kind === "contest" ? <ShieldAlert /> : <CircleSlash />} {copy.button}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- Rouvrir
function ReopenDialog({ item, open, onClose }: { item: NetworkGivenItem; open: boolean; onClose: () => void }) {
  const { pending, run } = useNetworkRunner();
  const s = item.settlement!;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        size="sm"
        title="Rouvrir le règlement"
        description={`Il redevient à régler, avec une nouvelle échéance d'au moins 48 h ; ${item.execution.driver_label} est prévenu.`}
      >
        <Summary item={item} />
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Retour</Button>
          <Button variant="primary" loading={pending} onClick={() => run(() => reopenNetworkSettlement(s.id), onClose)}>
            <RotateCcw /> Rouvrir
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- Ne plus travailler avec {B}
function ExcludePartnerDialog({ item, open, onClose }: { item: NetworkGivenItem; open: boolean; onClose: () => void }) {
  const { pending, run } = useNetworkRunner();
  const partner = item.execution.partner;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        size="sm"
        title={`Ne plus travailler avec ${partner.name}`}
        description={`Vos courses ne seront plus proposées aux chauffeurs de ${partner.name}, et vous ne recevrez plus les siennes. ${partner.name} n'en est pas informée. Les courses déjà acceptées vont à leur terme ; réversible dans Réglages › Options avancées.`}
      >
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Retour</Button>
          <Button variant="danger" loading={pending} onClick={() => run(() => setNetworkPartnerExcluded(partner.id, true), onClose)}>
            <Ban /> Ne plus travailler avec {partner.name}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- « Versé » : RIB en feuille latérale
const WARNING_TEXT = {
  iban_changed: "Le RIB a changé depuis la fin de la course : vérifiez-le auprès du chauffeur avant de verser.",
  recent_change: "RIB modifié il y a moins de 72 h : vérifiez-le auprès du chauffeur avant de verser.",
} as const;

function PayoutSheet({ item, open, onClose }: { item: NetworkGivenItem; open: boolean; onClose: () => void }) {
  const s = item.settlement!;
  const { pending, run } = useNetworkRunner();
  const [loading, startLoading] = useTransition();
  const [info, setInfo] = useState<OrgNetworkPayoutInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<ConfirmMethod | null>("transfer");
  useEffect(() => {
    if (!open) return;
    setInfo(null);
    setError(null);
    setMethod("transfer");
  }, [open]);
  const reveal = () =>
    startLoading(() => runAction(async () => {
      const res = await getNetworkPayoutInfo(s.id);
      if (!res.ok) return void setError(res.error);
      setInfo(res.info);
    }, setError));
  const copy = (text: string, what: string) =>
    navigator.clipboard?.writeText(text).then(() => toast.success(`${what} copié`), () => toast.error("Copie impossible"));
  const amount = formatPrice(s.amount_cents, s.currency);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent title={`Verser ${amount} à ${item.execution.driver_label}`} description={`Course #${item.ride.number} · ${item.execution.partner.name}`}>
        <div className="space-y-5 px-6 py-5">
          <section aria-labelledby="rib-title" className="rounded-xl border border-line bg-white/[0.02] p-4">
            <h3 id="rib-title" className="flex items-center gap-2 text-[13px] font-medium">
              <Landmark className="size-4 text-fg-subtle" /> Coordonnées bancaires du chauffeur
            </h3>
            {!info ? (
              <div className="mt-3 space-y-3">
                <p className="text-[12.5px] text-fg-muted">Le chauffeur est prévenu de chaque consultation de son RIB.</p>
                {error && <p className="text-[12.5px] text-red">{error}</p>}
                <Button variant="secondary" size="sm" loading={loading} onClick={reveal}>
                  Afficher le RIB
                </Button>
              </div>
            ) : (
              <div className="mt-3 space-y-2.5">
                {info.warnings.map((w) => (
                  <p key={w} role="alert" className="rounded-lg border border-amber/30 bg-amber/[0.08] px-3 py-2 text-[12.5px] text-amber">
                    {WARNING_TEXT[w]}
                  </p>
                ))}
                <dl className="space-y-2.5 text-[13px]">
                  <div>
                    <dt className="text-[11.5px] text-fg-subtle">Titulaire</dt>
                    <dd className="font-medium">{info.payee_name}</dd>
                  </div>
                  <div>
                    <dt className="text-[11.5px] text-fg-subtle">IBAN</dt>
                    <dd className="flex items-center gap-2">
                      <span className="mono">{formatIban(info.iban)}</span>
                      <Button variant="ghost" size="icon-sm" aria-label="Copier l'IBAN" onClick={() => copy(info.iban, "IBAN")}>
                        <Copy />
                      </Button>
                    </dd>
                  </div>
                  {info.bic && (
                    <div>
                      <dt className="text-[11.5px] text-fg-subtle">BIC</dt>
                      <dd className="mono">{info.bic}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-[11.5px] text-fg-subtle">Libellé du virement</dt>
                    <dd className="flex items-center gap-2">
                      <span className="mono">{info.reference}</span>
                      <Button variant="ghost" size="icon-sm" aria-label="Copier le libellé" onClick={() => copy(info.reference, "Libellé")}>
                        <Copy />
                      </Button>
                    </dd>
                  </div>
                </dl>
                <p className="text-[11.5px] text-fg-subtle">RIB mis à jour par le chauffeur {fromNow(info.updated_at)}.</p>
              </div>
            )}
          </section>
          <form className="space-y-4" onSubmit={submitWith((data) => run(() => confirmNetworkSettlement(s.id, method, String(data.get("note") ?? "")), onClose))}>
            <Field label="Versé par">
              <MethodPicker value={method} onChange={setMethod} />
            </Field>
            <Field label="Note" optional>
              <Input name="note" maxLength={500} placeholder="Ex. virement du 25/09" />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={onClose}>Fermer</Button>
              <Button type="submit" variant="primary" loading={pending}>
                <Check /> Marquer versé
              </Button>
            </div>
          </form>
        </div>
      </SheetContent>
    </Dialog>
  );
}
