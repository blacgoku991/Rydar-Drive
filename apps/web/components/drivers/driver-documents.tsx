"use client";
import { DOCUMENT_STATE_META, DOCUMENT_TYPE_LABELS, documentStateLabel, formatDate, type DocumentType, type DriverDocumentEvent } from "@rydar/shared";
import { Building2, Check, FileText, FileWarning, Plus, Smartphone, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { reviewDriverDocument } from "@/app/dashboard/drivers/actions";
import { AddDocumentDialog, isAddableDocumentType, type AddableDocumentType } from "@/components/drivers/add-document-dialog";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/wording";
import type { DocumentView } from "./documents";

const NB = " ";
const REJECT_REASONS = ["Photo illisible", "Document expiré", "Mauvais document", "Nom incorrect"];

function Preview({ doc }: { doc: DocumentView }) {
  const base = "grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-line-strong bg-ink-700 text-fg-subtle [&_svg]:size-5";
  if (doc.url && doc.kind === "image") {
    return (
      <a href={doc.url} target="_blank" rel="noreferrer" className={cn(base, "hover:border-brand/40")} aria-label={`Ouvrir ${doc.label} (nouvel onglet)`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={doc.url} alt="" className="size-full object-cover" />
      </a>
    );
  }
  if (doc.url) {
    return (
      <a href={doc.url} target="_blank" rel="noreferrer" className={cn(base, "flex-col gap-0.5 text-[12px] font-semibold text-fg-muted hover:border-brand/40")} aria-label={`Ouvrir ${doc.label} (nouvel onglet)`}>
        <FileText aria-hidden className="!size-4" />
        PDF
      </a>
    );
  }
  return (
    <span className={base} title={doc.file_path ? "Aperçu indisponible" : "Aucun fichier joint"}>
      <FileText aria-hidden />
    </span>
  );
}

/** Pièce à remplacer : expirée ou refusée (« Ajouter » ouvre la fenêtre avec son type). */
const toReplace = (doc: DocumentView) => doc.status === "expired" || doc.status === "rejected";

/**
 * Documents du chauffeur : statut calculé, échéance, source, aperçu, validation / refus (temps réel). `self` (Flotte
 * Privée, « Mon profil chauffeur ») : ses propres pièces, textes à la deuxième personne, « Confirmer » / « Retirer » sur
 * ses dépôts. `canAdd` : bouton « Ajouter » sur chaque pièce manquante, expirée ou refusée (fenêtre d'ajout avec le type
 * choisi) ; sans lui, la liste reste en lecture (fenêtre des candidatures).
 */
export function DriverDocuments({
  driverId,
  firstName,
  items,
  missing,
  canReview,
  self = false,
  canAdd = false,
}: {
  driverId: string;
  firstName: string;
  items: DocumentView[];
  missing: DocumentType[];
  canReview: boolean;
  self?: boolean;
  canAdd?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [reject, setReject] = useState<DocumentView | null>(null);
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState<AddableDocumentType | null>(null);
  // Date à saisir avant validation : échéance passée (DOCUMENT_EXPIRED) ou manquante sur une pièce à échéance (EXPIRY_REQUIRED)
  const [fixDate, setFixDate] = useState<{ doc: DocumentView; date: string; reason: "expired" | "missing" } | null>(null);
  const timer = useRef<number | null>(null);

  useRealtimeEvent("driver.document", (e: DriverDocumentEvent) => {
    if (e?.document?.driver_id !== driverId) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => router.refresh(), 300);
  });

  const review = (doc: DocumentView, approve: boolean, opts: { note?: string; expiresAt?: string } = {}) => {
    setBusy(doc.id);
    start(() => runAction(async () => {
      const res = await reviewDriverDocument({ documentId: doc.id, approve, note: opts.note, expiresAt: opts.expiresAt });
      setBusy(null);
      if (!res.ok) {
        if (res.code === "DOCUMENT_EXPIRED" || res.code === "EXPIRY_REQUIRED") {
          setReject(null);
          setFixDate({ doc, date: "", reason: res.code === "EXPIRY_REQUIRED" ? "missing" : "expired" });
          return;
        }
        toast.error(res.error);
        if (res.code === "DOCUMENT_NOT_PENDING" || res.code === "DOCUMENT_NOT_FOUND") router.refresh();
        return;
      }
      toast.success(
        approve
          ? `${self ? "Document confirmé" : "Document validé"}${NB}: ${doc.label}`
          : self
            ? `Document retiré${NB}: ${doc.label}`
            : `Document refusé${NB}: ${doc.label} — ${firstName} est prévenu`,
      );
      setReject(null);
      setFixDate(null);
      setNote("");
      router.refresh();
    }));
  };

  // Pièce exigée sans document : une ligne « Manquant », sauf si une pièce expirée ou refusée du même type est déjà
  // affichée (son « Ajouter » la remplace : plus de ligne en double)
  const missingRows = missing.filter((t) => !items.some((d) => d.type === t && toReplace(d)));
  const counts = items.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.status]: (acc[d.status] ?? 0) + 1 }), {});
  const toReview = items.filter((d) => d.status === "pending");
  const summary = [
    counts.valid && plural(counts.valid, "valide"),
    counts.pending && `${counts.pending} à ${self ? "confirmer" : "valider"}`,
    counts.expiring && plural(counts.expiring, "bientôt échu", "bientôt échus"),
    counts.expired && plural(counts.expired, "expiré"),
    counts.rejected && plural(counts.rejected, "refusé"),
    missingRows.length && plural(missingRows.length, "manquant"),
  ].filter(Boolean);
  const anyToProvide = missingRows.length > 0 || items.some(toReplace);
  const addButton = (type: string, label: string) =>
    canAdd && isAddableDocumentType(type) ? (
      <Button size="sm" variant="secondary" onClick={() => setAdding(type)}>
        <Plus /> Ajouter<span className="sr-only">{`${NB}: ${label}`}</span>
      </Button>
    ) : null;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Documents"
        icon={<FileText />}
        description={summary.length ? summary.join(" · ") : "Aucun document enregistré."}
        action={toReview.length > 0 ? <Badge tone="blue">{`${toReview.length} à ${self ? "confirmer" : "valider"}`}</Badge> : undefined}
      />
      {/* Une phrase pour toutes les pièces à fournir (au lieu de « Exigé — … » répété sur chaque ligne) */}
      {anyToProvide && (
        <p className="border-b border-line px-5 py-3 text-[13px] text-fg-muted">
          {self
            ? `Déposez la photo de vos documents depuis l'application${NB}; ici, vous enregistrez leur numéro et leur date d'expiration.`
            : `${firstName} peut déposer les pièces à fournir depuis l'application${canAdd ? `${NB}; vous pouvez aussi les ajouter ici` : ""}.`}
        </p>
      )}
      <ul className="divide-y divide-line">
        {items.map((doc) => {
          const meta = DOCUMENT_STATE_META[doc.status];
          const isPending = doc.status === "pending";
          const reviewable = isPending && canReview;
          const replace = toReplace(doc) ? addButton(doc.type, doc.label) : null;
          return (
            // Compacte (téléphone) : statut à côté du libellé, actions sous le texte ; à droite dès sm
            <li key={doc.id} className={cn("flex items-start gap-3.5 px-5 py-3.5", isPending && "bg-blue/[0.04]")}>
              <Preview doc={doc} />
              <div className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  {/* Libellé et statut sur la même ligne ; numéro et échéance, puis provenance (jamais de « · » orphelin) */}
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 text-[13.5px] font-medium">{doc.label}</p>
                    <Badge tone={meta.tone} className="shrink-0">
                      {documentStateLabel(doc.status, doc.days_left)}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-[12px] text-fg-muted">
                    {doc.number && (
                      <>
                        <span className="num">N° {doc.number}</span> ·{" "}
                      </>
                    )}
                    {doc.expires_at ? (
                      <>
                        Échéance <span className="num text-fg">{formatDate(doc.expires_at)}</span>
                      </>
                    ) : (
                      "Sans échéance"
                    )}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 text-[12px] text-fg-muted">
                    {doc.source === "driver" ? <Smartphone aria-hidden className="size-3 shrink-0" /> : <Building2 aria-hidden className="size-3 shrink-0" />}
                    <span>
                      {doc.source === "driver" ? (self ? "Déposé depuis l'application" : `Déposé par ${firstName}`) : "Ajouté depuis le tableau de bord"}
                      {isPending && <> le {formatDate(doc.created_at)}</>}
                    </span>
                  </p>
                  {doc.status === "rejected" && doc.review_note && <p className="mt-1 text-[12px] text-red">Motif{NB}: {doc.review_note}</p>}
                </div>
                {(reviewable || replace) && (
                  <div className="mt-2.5 flex shrink-0 flex-wrap items-center gap-2 sm:mt-0">
                    {reviewable && (
                      <>
                        <Button size="sm" variant="primary" loading={pending && busy === doc.id && !reject} onClick={() => review(doc, true)}>
                          <Check /> {self ? "Confirmer" : "Valider"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending && busy === doc.id}
                          onClick={() => {
                            setNote("");
                            setReject(doc);
                          }}
                        >
                          <X /> {self ? "Retirer" : "Refuser"}
                        </Button>
                      </>
                    )}
                    {replace}
                  </div>
                )}
              </div>
            </li>
          );
        })}
        {missingRows.map((type) => (
          <li key={`missing-${type}`} className="flex items-center gap-3.5 px-5 py-3.5">
            <span aria-hidden className="grid size-12 shrink-0 place-items-center rounded-lg border border-dashed border-line-strong text-fg-subtle">
              <FileWarning className="size-5" />
            </span>
            <div className="min-w-0 flex-1 sm:flex sm:items-center sm:justify-between sm:gap-3">
              <p className="text-[13.5px] font-medium text-fg-muted">{DOCUMENT_TYPE_LABELS[type]}</p>
              <Badge tone={DOCUMENT_STATE_META.missing.tone} className="mt-1 sm:mt-0">
                {DOCUMENT_STATE_META.missing.label}
              </Badge>
            </div>
            <div className="shrink-0">{addButton(type, DOCUMENT_TYPE_LABELS[type] ?? type)}</div>
          </li>
        ))}
        {!items.length && !missingRows.length && <li className="px-5 py-5 text-[13px] text-fg-muted">Aucun document enregistré.</li>}
      </ul>

      {canAdd && (
        <AddDocumentDialog driverId={driverId} self={self} open={adding !== null} onOpenChange={(o) => !o && setAdding(null)} defaultType={adding ?? "vtc_card"} />
      )}

      {/* Ses propres dépôts (Flotte Privée) : « Retirer » confirmé, sans motif (facultatif côté serveur, même charge) */}
      {self ? (
        <ConfirmDialog
          open={!!reject}
          onOpenChange={(o) => !o && setReject(null)}
          title={reject ? `Retirer «${NB}${reject.label}${NB}»${NB}?` : "Retirer le document"}
          consequence={`Le document passe «${NB}Refusé${NB}»${NB}; vous pourrez en déposer un nouveau depuis l'application.`}
          confirmLabel="Retirer le document"
          loading={pending}
          onConfirm={() => reject && review(reject, false, { note: undefined })}
        />
      ) : (
        <Dialog open={!!reject} onOpenChange={(o) => !o && setReject(null)}>
          <DialogContent
            title="Refuser le document"
            description={reject ? `${reject.label} — ${firstName} reçoit une notification avec votre motif et pourra en déposer un nouveau.` : undefined}
          >
            <div className="mb-3 flex flex-wrap gap-1.5">
              {REJECT_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={note === r}
                  onClick={() => setNote(r)}
                  className={cn(
                    "h-9 rounded-full border px-3 text-[13px] transition-colors sm:h-8",
                    note === r ? "border-brand/40 bg-brand/[0.08] text-fg" : "border-line-strong text-fg-muted hover:text-fg",
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
            <Field label="Motif" hint="Visible par le chauffeur." optional>
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={`ex.${NB}: photo floue, recadrez le document entier.`} />
            </Field>
            <DialogFooter backDisabled={pending}>
              <Button variant="danger" loading={pending} onClick={() => reject && review(reject, false, { note: note.trim() || undefined })}>
                Refuser le document
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <Dialog open={!!fixDate} onOpenChange={(o) => !o && setFixDate(null)}>
        <DialogContent
          title={fixDate?.reason === "missing" ? "Date d'échéance requise" : "Document expiré"}
          description={
            fixDate
              ? fixDate.reason === "missing"
                ? `Indiquez la date d'expiration de ${fixDate.doc.label} (lisible sur la photo)${NB}: elle déclenche les rappels et remplace l'ancien document.`
                : `L'échéance saisie pour ${fixDate.doc.label} est déjà passée. Corrigez-la d'après la photo, ou ${self ? "retirez" : "refusez"} le document.`
              : undefined
          }
          size="sm"
        >
          <Field label={fixDate?.reason === "missing" ? "Date d'échéance" : "Nouvelle échéance"}>
            <Input
              type="date"
              className="[color-scheme:dark]"
              value={fixDate?.date ?? ""}
              onChange={(e) => setFixDate((f) => (f ? { ...f, date: e.target.value } : f))}
            />
          </Field>
          <DialogFooter backDisabled={pending}>
            <Button variant="primary" disabled={!fixDate?.date} loading={pending} onClick={() => fixDate && review(fixDate.doc, true, { expiresAt: fixDate.date })}>
              {self ? "Confirmer avec cette date" : "Valider avec cette date"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
