"use client";
import { DOCUMENT_STATE_META, DOCUMENT_TYPE_LABELS, documentStateLabel, formatDate, type DocumentType, type DriverDocumentEvent } from "@rydar/shared";
import { Check, FileText, FileWarning, Smartphone, Building2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { reviewDriverDocument } from "@/app/dashboard/drivers/actions";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { DocumentView } from "./documents";

const REJECT_REASONS = ["Photo illisible", "Document expiré", "Mauvais document", "Nom incorrect"];

function Preview({ doc }: { doc: DocumentView }) {
  const base = "grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-line-strong bg-ink-700 text-fg-subtle [&_svg]:size-5";
  if (doc.url && doc.kind === "image") {
    return (
      <a href={doc.url} target="_blank" rel="noreferrer" className={cn(base, "hover:border-brand/40")} aria-label={`Ouvrir ${doc.label}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={doc.url} alt="" className="size-full object-cover" />
      </a>
    );
  }
  if (doc.url) {
    return (
      <a href={doc.url} target="_blank" rel="noreferrer" className={cn(base, "flex-col gap-0.5 text-[9.5px] font-semibold text-fg-muted hover:border-brand/40")} aria-label={`Ouvrir ${doc.label}`}>
        <FileText className="!size-4" />
        PDF
      </a>
    );
  }
  return (
    <span className={base} title={doc.file_path ? "Aperçu indisponible" : "Aucun fichier joint"}>
      <FileText />
    </span>
  );
}

/** Documents du chauffeur : statut calculé, échéance, source, aperçu, validation / refus (temps réel). */
export function DriverDocuments({
  driverId,
  firstName,
  items,
  missing,
  canReview,
}: {
  driverId: string;
  firstName: string;
  items: DocumentView[];
  missing: DocumentType[];
  canReview: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [reject, setReject] = useState<DocumentView | null>(null);
  const [note, setNote] = useState("");
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
    start(async () => {
      const res = await reviewDriverDocument({ documentId: doc.id, approve, note: opts.note, expiresAt: opts.expiresAt });
      setBusy(null);
      if (!res.ok) {
        if (res.code === "DOCUMENT_EXPIRED" || res.code === "EXPIRY_REQUIRED") {
          setFixDate({ doc, date: "", reason: res.code === "EXPIRY_REQUIRED" ? "missing" : "expired" });
          return;
        }
        toast.error(res.error);
        if (res.code === "DOCUMENT_NOT_PENDING" || res.code === "DOCUMENT_NOT_FOUND") router.refresh();
        return;
      }
      toast.success(approve ? `Document validé : ${doc.label}` : `Document refusé : ${doc.label} — ${firstName} est prévenu`);
      setReject(null);
      setFixDate(null);
      setNote("");
      router.refresh();
    });
  };

  const counts = items.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.status]: (acc[d.status] ?? 0) + 1 }), {});
  const toReview = items.filter((d) => d.status === "pending");
  const summary = [
    counts.valid && `${counts.valid} valide${counts.valid > 1 ? "s" : ""}`,
    counts.pending && `${counts.pending} à valider`,
    counts.expiring && `${counts.expiring} bientôt échu${counts.expiring > 1 ? "s" : ""}`,
    counts.expired && `${counts.expired} expiré${counts.expired > 1 ? "s" : ""}`,
    counts.rejected && `${counts.rejected} refusé${counts.rejected > 1 ? "s" : ""}`,
    missing.length && `${missing.length} manquant${missing.length > 1 ? "s" : ""}`,
  ].filter(Boolean);

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Documents"
        icon={<FileText />}
        description={summary.length ? summary.join(" · ") : "Aucun document enregistré."}
        action={
          toReview.length > 0 ? (
            <Badge tone="blue" pulse>
              {toReview.length} à valider
            </Badge>
          ) : undefined
        }
      />
      <ul className="divide-y divide-line">
        {items.map((doc) => {
          const meta = DOCUMENT_STATE_META[doc.status];
          const isPending = doc.status === "pending";
          return (
            <li key={doc.id} className={cn("flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center", isPending && "bg-blue/[0.04]")}>
              <div className="flex min-w-0 flex-1 items-center gap-3.5">
                <Preview doc={doc} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-[13.5px] font-medium">
                    {doc.label}
                    {doc.number && <span className="num text-[12px] font-normal text-fg-subtle">N° {doc.number}</span>}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-fg-subtle">
                    <span>{doc.expires_at ? <>Échéance <span className="num text-fg-muted">{formatDate(doc.expires_at)}</span></> : "Sans échéance"}</span>
                    <span aria-hidden>·</span>
                    <span className="inline-flex items-center gap-1">
                      {doc.source === "driver" ? <Smartphone className="size-3" /> : <Building2 className="size-3" />}
                      {doc.source === "driver" ? `Déposé par ${firstName}` : "Ajouté par la centrale"}
                      {isPending && <> le {formatDate(doc.created_at)}</>}
                    </span>
                  </p>
                  {doc.status === "rejected" && doc.review_note && <p className="mt-1 text-[12px] text-red/90">Motif : {doc.review_note}</p>}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 pl-[62px] sm:pl-0">
                <Badge tone={meta.tone} pulse={isPending}>
                  {documentStateLabel(doc.status, doc.days_left)}
                </Badge>
                {isPending && canReview && (
                  <>
                    <Button size="sm" variant="primary" loading={pending && busy === doc.id && !reject} onClick={() => review(doc, true)}>
                      <Check /> Valider
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
                      <X /> Refuser
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
        {missing.map((type) => (
          <li key={`missing-${type}`} className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3.5">
              <span className="grid size-12 shrink-0 place-items-center rounded-lg border border-dashed border-line-strong text-fg-subtle">
                <FileWarning className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="text-[13.5px] font-medium text-fg-muted">{DOCUMENT_TYPE_LABELS[type]}</p>
                <p className="mt-0.5 text-[12px] text-fg-subtle">Exigé — {firstName} peut le déposer depuis l&apos;application.</p>
              </div>
            </div>
            <div className="shrink-0 pl-[62px] sm:pl-0">
              <Badge tone={DOCUMENT_STATE_META.missing.tone}>{DOCUMENT_STATE_META.missing.label}</Badge>
            </div>
          </li>
        ))}
        {!items.length && !missing.length && <li className="px-5 py-5 text-[13px] text-fg-subtle">Aucun document enregistré.</li>}
      </ul>

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
                onClick={() => setNote(r)}
                className={cn(
                  "h-7 rounded-full border px-3 text-[12.5px] transition-colors",
                  note === r ? "border-brand/40 bg-brand/[0.08] text-fg" : "border-line-strong text-fg-muted hover:text-fg",
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <Field label="Motif" hint="Visible par le chauffeur." optional>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Ex. : photo floue, recadrez le document entier." />
          </Field>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setReject(null)}>
              Annuler
            </Button>
            <Button variant="danger" loading={pending} onClick={() => reject && review(reject, false, { note: note.trim() || undefined })}>
              Refuser le document
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!fixDate} onOpenChange={(o) => !o && setFixDate(null)}>
        <DialogContent
          title={fixDate?.reason === "missing" ? "Date d'échéance requise" : "Document expiré"}
          description={
            fixDate
              ? fixDate.reason === "missing"
                ? `Indiquez la date d'expiration de ${fixDate.doc.label} (lisible sur la photo) : elle déclenche les rappels et remplace l'ancien document.`
                : `L'échéance saisie pour ${fixDate.doc.label} est déjà passée. Corrigez-la d'après la photo, ou refusez le document.`
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
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setFixDate(null)}>
              Annuler
            </Button>
            <Button variant="primary" disabled={!fixDate?.date} loading={pending} onClick={() => fixDate && review(fixDate.doc, true, { expiresAt: fixDate.date })}>
              Valider avec cette date
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
