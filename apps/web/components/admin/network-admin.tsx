"use client";
// Super admin — /admin/reseau : interrupteur du réseau partagé (avec confirmation), décisions « À valider »
// (Valider, avec dérogation « frais à 0 » éventuelle ; Refuser + motif), Suspendre / Rétablir + motif.
// Rydar fait une vérification administrative de l'inscription au registre VTC, jamais une sélection (§7.1).
import { DISPATCH_MODEL_META, type AdminNetworkOrgRow } from "@rydar/shared";
import { ArrowLeftRight, Ban, Check, ShieldCheck, Undo2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { reviewNetworkOrg, setSharedNetworkEnabled, suspendNetworkOrg, type AdminNetworkResult } from "@/app/admin/reseau/actions";
import { IDENTITY_LABELS, feeLabel, missingIdentity, needsFeeWaiver } from "@/components/network-share/admin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { submitWith } from "@/lib/utils";

/** Action serveur hors formulaire / dans un formulaire : transition + runAction, toast, relecture de la page. */
function useAdminRunner() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = <T extends object>(fn: () => Promise<AdminNetworkResult<T>>, after?: () => void, onFail?: (r: Extract<AdminNetworkResult<T>, { ok: false }>) => void) =>
    start(() => runAction(async () => {
      const res = await fn();
      if (!res.ok) {
        onFail?.(res);
        return void toast.error(res.error);
      }
      toast.success(res.message);
      after?.();
      router.refresh();
    }));
  return { pending, run };
}

// ---------------------------------------------------------------------------------------------------------------
// Interrupteur de toute la plateforme
// ---------------------------------------------------------------------------------------------------------------

export function NetworkSwitchCard({
  enabled,
  totals,
  updatedLabel,
}: {
  enabled: boolean;
  totals: { members: number; sharing: number; receiving: number; suspended: number } | null;
  updatedLabel: string | null;
}) {
  const [confirm, setConfirm] = useState(false);
  const { pending, run } = useAdminRunner();
  const apply = () => run(() => setSharedNetworkEnabled(!enabled), () => setConfirm(false));
  return (
    <Card>
      <CardHeader
        icon={<ArrowLeftRight className="text-violet" />}
        title="Interrupteur du réseau partagé"
        description={"Pour toute la plateforme. Fermé\u00a0: aucun écran réseau n'apparaît, pour personne."}
        action={<Badge tone={enabled ? "green" : "amber"}>{enabled ? "Ouvert" : "Fermé"}</Badge>}
      />
      <CardBody className="flex flex-wrap items-center justify-between gap-4">
        <div className="max-w-2xl space-y-1 text-[13px] text-fg-muted">
          {enabled ? (
            <p>
              Les organisations voient l&apos;onglet «{"\u00a0"}Réseau partagé{"\u00a0"}» et peuvent demander à participer
              {totals ? (
                <>
                  {"\u00a0"}: <span className="num text-fg">{totals.sharing}</span> partagent, <span className="num text-fg">{totals.receiving}</span> reçoivent
                  {totals.suspended ? <>, <span className="num text-fg">{totals.suspended}</span> suspendue{totals.suspended > 1 ? "s" : ""}</> : null}.
                </>
              ) : (
                "."
              )}
            </p>
          ) : (
            <p>Aucun menu, aucun bandeau, rien dans l&apos;application chauffeur{"\u00a0"}: rien ne change pour personne. Les réglages déjà faits sont conservés.</p>
          )}
          {updatedLabel && <p className="text-[12px] text-fg-muted">Dernier changement {updatedLabel}</p>}
        </div>
        {/* Décision rare : jamais en avant (bouton plein réservé à la confirmation) */}
        <Button variant={enabled ? "danger" : "outline"} onClick={() => setConfirm(true)} disabled={pending}>
          {enabled ? "Fermer le réseau partagé" : "Ouvrir le réseau partagé"}
        </Button>
      </CardBody>

      <Dialog open={confirm} onOpenChange={(open) => !pending && setConfirm(open)}>
        <DialogContent
          size="sm"
          title={enabled ? "Fermer le réseau partagé\u00a0?" : "Ouvrir le réseau partagé\u00a0?"}
          description={enabled ? "Toutes les organisations sont concernées, immédiatement." : "Les textes doivent avoir été relus par le juriste avant l'ouverture."}
        >
          <ul className="space-y-2 text-[13px] text-fg-muted">
            {enabled ? (
              <>
                <li className="flex gap-2"><span aria-hidden className="text-amber">•</span> Plus aucune course n&apos;est proposée au réseau{"\u00a0"}; les offres en attente sont retirées.</li>
                <li className="flex gap-2"><span aria-hidden className="text-amber">•</span> Les courses déjà acceptées par un partenaire vont à leur terme.</li>
                <li className="flex gap-2"><span aria-hidden className="text-amber">•</span> Réglages, validations et règlements conservés.</li>
              </>
            ) : (
              <>
                <li className="flex gap-2"><span aria-hidden className="text-brand">•</span> Onglet «{"\u00a0"}Réseau partagé{"\u00a0"}» visible dans les tableaux de bord (deux interrupteurs, désactivés par défaut).</li>
                <li className="flex gap-2"><span aria-hidden className="text-brand">•</span> Chaque organisation accepte la convention, puis attend votre validation.</li>
                <li className="flex gap-2"><span aria-hidden className="text-brand">•</span> Aucune course n&apos;est partagée tant qu&apos;une organisation n&apos;a rien activé.</li>
              </>
            )}
          </ul>
          <DialogFooter backDisabled={pending}>
            <Button variant={enabled ? "danger" : "primary"} loading={pending} onClick={apply}>
              {enabled ? "Fermer le réseau partagé" : "Ouvrir le réseau partagé"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// « À valider » : Valider (dérogation « frais à 0 » éventuelle) / Refuser + motif
// ---------------------------------------------------------------------------------------------------------------

export function NetworkReviewActions({ row, currency = "EUR" }: { row: AdminNetworkOrgRow; currency?: string }) {
  const [mode, setMode] = useState<"approve" | "refuse" | null>(null);
  const missing = missingIdentity(row);
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        size="sm"
        className="max-md:h-11"
        onClick={() => setMode("approve")}
        disabled={missing.length > 0}
        title={missing.length ? "Fiche incomplète" : undefined}
        aria-label={`Valider ${row.name}`}
      >
        <ShieldCheck /> Valider
      </Button>
      <Button variant="outline" size="sm" className="max-md:h-11" onClick={() => setMode("refuse")} aria-label={`Refuser ${row.name}`}>
        <X /> Refuser
      </Button>
      {mode === "approve" && <ApproveDialog row={row} currency={currency} onClose={() => setMode(null)} />}
      {mode === "refuse" && <RefuseDialog row={row} onClose={() => setMode(null)} />}
    </div>
  );
}

function ApproveDialog({ row, currency, onClose }: { row: AdminNetworkOrgRow; currency: string; onClose: () => void }) {
  const { pending, run } = useAdminRunner();
  const zeroFees = needsFeeWaiver(row);
  const [waiver, setWaiver] = useState(row.fee_waiver);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        size="sm"
        title={`Valider ${row.name}`}
        description={"Vérification administrative de l'inscription au registre des exploitants VTC. Ces informations sont montrées aux partenaires\u00a0; un changement de nom ou de n° fera perdre la validation."}
      >
        <dl className="space-y-2 rounded-xl border border-line px-3.5 py-3 text-[13px]">
          <div className="flex justify-between gap-3"><dt className="text-fg-muted">Raison sociale</dt><dd className="text-right [overflow-wrap:anywhere]">{row.legal_name}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-fg-muted">SIRET</dt><dd className="mono">{row.siret}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-fg-muted">N° d&apos;inscription VTC</dt><dd className="mono">{row.vtc_registration}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-fg-muted">Modèle</dt><dd className="text-right">{DISPATCH_MODEL_META[row.dispatch_model].label}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-fg-muted">Frais Rydar</dt><dd className="text-right">{feeLabel({ ...row, fee_waiver: false }, currency)}</dd></div>
        </dl>
        {zeroFees && (
          <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-amber/25 bg-amber/[0.06] px-3 py-2.5 text-[13px]">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-brand)]" checked={waiver} onChange={(e) => setWaiver(e.target.checked)} />
            <span>
              <span className="font-medium text-fg">Dérogation «{"\u00a0"}frais à 0{"\u00a0"}»</span>
              <span className="block text-[12px] text-fg-muted">Sans frais Rydar, cette organisation ne peut partager ses courses qu&apos;avec cette dérogation. Elle peut toujours recevoir.</span>
            </span>
          </label>
        )}
        <DialogFooter backDisabled={pending}>
          <Button variant="primary" loading={pending} onClick={() => run(() => reviewNetworkOrg({ orgId: row.id, approved: true, feeWaiver: zeroFees && waiver }), onClose)}>
            <Check /> Valider la participation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RefuseDialog({ row, onClose }: { row: AdminNetworkOrgRow; onClose: () => void }) {
  const { pending, run } = useAdminRunner();
  const [error, setError] = useState<string | undefined>();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm" title={`Refuser ${row.name}`} description="Le motif est affiché à l'organisation, qui peut corriger sa fiche et redemander.">
        <form
          onSubmit={submitWith((data) =>
            run(
              () => reviewNetworkOrg({ orgId: row.id, approved: false, reason: String(data.get("reason") ?? "") }),
              onClose,
              (r) => setError(r.fieldErrors?.reason ?? r.error),
            ),
          )}
        >
          <Field label="Motif" error={error}>
            <Textarea name="reason" maxLength={300} placeholder={"ex.\u00a0: n° d'inscription VTC introuvable au registre"} className="min-h-[72px]" aria-invalid={!!error} autoFocus />
          </Field>
          <DialogFooter backDisabled={pending}>
            <Button type="submit" variant="danger" loading={pending}>
              <X /> Refuser la demande
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Champs à compléter par l'organisation avant validation (« raison sociale, SIRET »). */
export function MissingIdentity({ row }: { row: AdminNetworkOrgRow }) {
  const missing = missingIdentity(row);
  if (!missing.length) return null;
  return <p className="text-[12px] text-amber">À compléter par l&apos;organisation{"\u00a0"}: {missing.map((m) => IDENTITY_LABELS[m]).join(", ")}.</p>;
}

// ---------------------------------------------------------------------------------------------------------------
// Suspendre / Rétablir (manquement à la convention ou aux CGV)
// ---------------------------------------------------------------------------------------------------------------

export function NetworkSuspendButton({ row }: { row: Pick<AdminNetworkOrgRow, "id" | "name" | "suspended_at"> }) {
  const [open, setOpen] = useState(false);
  const { pending, run } = useAdminRunner();
  const [error, setError] = useState<string | undefined>();
  const suspended = !!row.suspended_at;
  return (
    <>
      <Button
        variant={suspended ? "outline" : "ghost"}
        size="sm"
        className="max-md:h-11"
        onClick={() => setOpen(true)}
        aria-label={`${suspended ? "Rétablir" : "Suspendre"} ${row.name}`}
      >
        {suspended ? <Undo2 /> : <Ban />} {suspended ? "Rétablir" : "Suspendre"}
      </Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent
          size="sm"
          title={suspended ? `Rétablir ${row.name}` : `Suspendre ${row.name}`}
          description={
            suspended
              ? "L'organisation retrouve le réseau partagé selon ses réglages."
              : "Pour un manquement à la convention ou aux CGV, jamais pour la qualité d'un service. Ses courses non commencées confiées à des partenaires sont remises en recherche\u00a0; les règlements restent dus."
          }
        >
          <form
            onSubmit={submitWith((data) =>
              run(
                () => suspendNetworkOrg({ orgId: row.id, suspended: !suspended, reason: String(data.get("reason") ?? "") }),
                () => setOpen(false),
                (r) => setError(r.fieldErrors?.reason ?? r.error),
              ),
            )}
          >
            <Field label={suspended ? "Note" : "Manquement constaté"} optional={suspended} error={error}>
              <Textarea
                name="reason"
                maxLength={300}
                placeholder={suspended ? "ex.\u00a0: versements régularisés" : "ex.\u00a0: versements aux chauffeurs partenaires en retard depuis 3 semaines"}
                className="min-h-[72px]"
                aria-invalid={!!error}
              />
            </Field>
            <DialogFooter backDisabled={pending}>
              <Button type="submit" variant={suspended ? "primary" : "danger"} loading={pending}>
                {suspended ? <Undo2 /> : <Ban />} {suspended ? "Rétablir dans le réseau" : "Suspendre du réseau"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
