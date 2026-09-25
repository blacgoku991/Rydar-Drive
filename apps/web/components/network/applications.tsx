"use client";
// Page Réseau : candidatures reçues par le lien d'inscription (validation / refus, documents déposés).
import {
  DOCUMENT_TYPE_LABELS, TRUST_LEVEL_META, VEHICLE_CATEGORY_META, formatDate, formatPhone, formatPrice, formatRelative,
  type DocumentType, type TrustLevel, type VehicleCategory,
} from "@rydar/shared";
import { CarFront, Check, FileText, IdCard, Inbox, UserRound, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { approveApplication, rejectApplication } from "@/app/dashboard/network/actions";
import { DriverDocuments } from "@/components/drivers/driver-documents";
import type { DocumentView } from "@/components/drivers/documents";
import { fullName } from "@/components/network/labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { Avatar, EmptyState } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

export type Candidate = {
  id: string;
  number: number;
  first_name: string;
  last_name: string;
  phone: string;
  email: string | null;
  vtc_card_number: string | null;
  photo_url: string | null;
  applied_at: string | null;
  application_message: string | null;
  vehicle: { brand: string | null; model: string; color: string | null; plate: string; category: VehicleCategory; seats: number } | null;
  documents: DocumentView[];
  missing: DocumentType[];
};

const REJECT_REASONS = ["Carte VTC manquante", "Documents incomplets", "Véhicule non conforme", "Zone non couverte", "Réseau complet"];
const REQUIRED: DocumentType[] = ["vtc_card", "driving_license", "identity", "insurance", "vehicle_registration"];

function DocDots({ c }: { c: Candidate }) {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {REQUIRED.map((t) => {
        const doc = c.documents.find((d) => d.type === t);
        const color = !doc ? "bg-fg-subtle/40" : doc.status === "pending" ? "bg-blue" : doc.status === "valid" || doc.status === "expiring" ? "bg-green" : "bg-red";
        return <span key={t} title={DOCUMENT_TYPE_LABELS[t]} className={cn("size-1.5 rounded-full", color)} />;
      })}
    </span>
  );
}

type ApplicationTarget = { id: string; first_name: string; last_name: string; missing?: DocumentType[] };

/** Boutons « Refuser » / « Valider » d'une candidature, avec leurs dialogues (page Réseau, fiche chauffeur). */
export function ApplicationActions({
  candidate,
  newDriverMaxPriceCents,
  trustAfterRides,
}: {
  candidate: ApplicationTarget;
  newDriverMaxPriceCents: number | null;
  trustAfterRides: number | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [dialog, setDialog] = useState<"approve" | "reject" | null>(null);
  const [trust, setTrust] = useState<TrustLevel>("new");
  const [reason, setReason] = useState("");
  const name = fullName(candidate);
  const missing = candidate.missing ?? [];
  const newHelp = [
    newDriverMaxPriceCents != null ? `Courses jusqu'à ${formatPrice(newDriverMaxPriceCents)}` : "Courses plafonnées selon vos réglages",
    trustAfterRides ? `confirmé automatiquement après ${trustAfterRides} course${trustAfterRides > 1 ? "s" : ""} réglée${trustAfterRides > 1 ? "s" : ""}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const doApprove = () =>
    start(async () => {
      const res = await approveApplication(candidate.id, trust);
      if (!res.ok) return void toast.error(res.error);
      toast.success(`${name} rejoint le réseau`, { description: `${TRUST_LEVEL_META[trust].label} · prévenu par notification.` });
      setDialog(null);
      router.refresh();
    });
  const doReject = () =>
    start(async () => {
      const res = await rejectApplication(candidate.id, reason);
      if (!res.ok) return void toast.error(res.error);
      toast.success(`Candidature de ${name} refusée`, { description: reason ? `Motif transmis : ${reason}` : undefined });
      setDialog(null);
      router.refresh();
    });

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => { setReason(""); setDialog("reject"); }}>
        <X /> Refuser
      </Button>
      <Button variant="primary" size="sm" onClick={() => { setTrust("new"); setDialog("approve"); }}>
        <Check /> Valider
      </Button>

      <Dialog open={dialog === "approve"} onOpenChange={(o) => !o && !pending && setDialog(null)}>
        <DialogContent title={`Valider ${name} ?`} description="Son compte devient actif : il peut passer en ligne et recevoir vos courses. Il est prévenu par notification.">
          <div role="radiogroup" aria-label="Niveau de confiance" className="grid gap-2 sm:grid-cols-2">
            {(["new", "trusted"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={trust === t}
                onClick={() => setTrust(t)}
                className={cn("flex flex-col justify-start rounded-xl border p-3.5 text-left", trust === t ? "border-brand/50 bg-brand/[0.06]" : "border-line hover:border-line-strong")}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className={cn("text-[13.5px] font-semibold", trust === t && "text-brand")}>{t === "new" ? "Nouveau (courses plafonnées)" : "Confirmé"}</span>
                  {trust === t && <Check className="size-4 shrink-0 text-brand" />}
                </span>
                <span className="mt-1 block text-[12px] leading-snug text-fg-subtle">{t === "new" ? newHelp : TRUST_LEVEL_META.trusted.description}</span>
              </button>
            ))}
          </div>
          {missing.length > 0 && (
            <p className="mt-4 rounded-lg border border-amber/25 bg-amber/[0.07] px-3 py-2.5 text-[12.5px] text-amber">
              Documents manquants : {missing.map((t) => DOCUMENT_TYPE_LABELS[t]).join(", ")}. Il pourra les déposer depuis l&apos;application.
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" disabled={pending} onClick={() => setDialog(null)}>Annuler</Button>
            <Button variant="primary" loading={pending} onClick={doApprove}>
              <Check /> Valider la candidature
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "reject"} onOpenChange={(o) => !o && !pending && setDialog(null)}>
        <DialogContent title={`Refuser ${name} ?`} description="Le candidat voit votre motif dans l'application. Pour écarter un fraudeur, bannissez-le depuis sa fiche.">
          <div className="mb-3 flex flex-wrap gap-1.5">
            {REJECT_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className={cn("rounded-full border px-2.5 py-1 text-[12px]", reason === r ? "border-brand/50 bg-brand/[0.08] text-brand" : "border-line text-fg-muted hover:border-line-strong hover:text-fg")}
              >
                {r}
              </button>
            ))}
          </div>
          <Field label="Motif" optional>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Précisez si besoin…" />
          </Field>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" disabled={pending} onClick={() => setDialog(null)}>Annuler</Button>
            <Button variant="danger" loading={pending} onClick={doReject}>
              <X /> Refuser la candidature
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ApplicationsCard({
  candidates,
  canManage,
  canReviewDocuments,
  newDriverMaxPriceCents,
  trustAfterRides,
  joinActive,
}: {
  candidates: Candidate[];
  canManage: boolean;
  canReviewDocuments: boolean;
  newDriverMaxPriceCents: number | null;
  trustAfterRides: number | null;
  joinActive: boolean;
}) {
  const [docsFor, setDocsFor] = useState<string | null>(null);
  const docsCandidate = candidates.find((c) => c.id === docsFor) ?? null;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Candidatures"
        icon={<Inbox />}
        description="Chauffeurs inscrits par votre lien, en attente de validation. Ils peuvent déjà déposer leurs documents dans l'application."
        action={candidates.length ? <Badge tone="amber" pulse>{candidates.length} en attente</Badge> : undefined}
      />
      {!candidates.length ? (
        <EmptyState
          icon={<Inbox />}
          title="Aucune candidature en attente"
          description={joinActive ? "Partagez votre lien d'inscription dans vos groupes WhatsApp / Telegram : les candidatures arrivent ici en temps réel." : "Activez votre lien d'inscription pour recevoir des candidatures."}
        />
      ) : (
        <ul className="divide-y divide-line">
          {candidates.map((c) => {
            const toReview = c.documents.filter((d) => d.status === "pending").length;
            const provided = REQUIRED.filter((t) => c.documents.some((d) => d.type === t && ["valid", "expiring", "pending"].includes(d.status))).length;
            return (
              <li key={c.id} className="flex flex-col gap-3 px-5 py-4">
                <div className="flex min-w-0 gap-3.5">
                  <Avatar name={fullName(c)} src={c.photo_url} size={40} />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <p className="text-[14px] font-semibold">{fullName(c)}</p>
                      <span className="num text-[11.5px] text-fg-subtle">#{c.number}</span>
                      {c.applied_at && (
                        <span className="text-[12px] text-fg-subtle" title={formatDate(c.applied_at)} suppressHydrationWarning>
                          · candidature {formatRelative(c.applied_at)}
                        </span>
                      )}
                    </div>
                    <p className="text-[12.5px] text-fg-muted [overflow-wrap:anywhere]">
                      <a href={`tel:${c.phone.replace(/\s/g, "")}`} className="num hover:text-fg">{formatPhone(c.phone)}</a>
                      {c.email && <> · <a href={`mailto:${c.email}`} className="hover:text-fg">{c.email}</a></>}
                    </p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-fg-muted">
                      <span className="flex items-start gap-1.5">
                        <CarFront className="mt-[3px] size-3.5 shrink-0 text-fg-subtle" />
                        <span className="min-w-0">
                          {c.vehicle ? (
                            <>
                              {[c.vehicle.brand, c.vehicle.model].filter(Boolean).join(" ")}
                              {c.vehicle.color ? ` ${c.vehicle.color.toLowerCase()}` : ""} · <span className="num text-fg">{c.vehicle.plate}</span> ·{" "}
                              {VEHICLE_CATEGORY_META[c.vehicle.category]?.label ?? c.vehicle.category} · {c.vehicle.seats} places
                            </>
                          ) : (
                            "Véhicule non renseigné"
                          )}
                        </span>
                      </span>
                      <span className="flex items-start gap-1.5">
                        <IdCard className="mt-[3px] size-3.5 shrink-0 text-fg-subtle" />
                        <span className="min-w-0">
                          {c.vtc_card_number ? <>Carte VTC <span className="num text-fg">{c.vtc_card_number}</span></> : <span className="text-amber">Carte VTC non renseignée</span>}
                        </span>
                      </span>
                    </div>
                    {c.application_message && (
                      <p className="rounded-lg border border-line bg-white/[0.02] px-3 py-2 text-[12.5px] leading-relaxed text-fg">« {c.application_message} »</p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:pl-[54px]">
                  <Button variant="secondary" size="sm" onClick={() => setDocsFor(c.id)}>
                    <FileText /> Documents <span className="num text-fg-subtle">{provided}/{REQUIRED.length}</span>
                    <DocDots c={c} />
                    {toReview > 0 && <Badge tone="blue" dot={false} className="h-[18px] px-1.5">{toReview} à valider</Badge>}
                  </Button>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/dashboard/drivers/${c.id}`}><UserRound /> Fiche</Link>
                  </Button>
                  {canManage && (
                    <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
                      <ApplicationActions candidate={c} newDriverMaxPriceCents={newDriverMaxPriceCents} trustAfterRides={trustAfterRides} />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!canManage && candidates.length > 0 && (
        <p className="border-t border-line px-5 py-3 text-[12px] text-fg-subtle">Validation et refus réservés aux administrateurs de la centrale.</p>
      )}

      <Dialog open={!!docsCandidate} onOpenChange={(o) => !o && setDocsFor(null)}>
        {docsCandidate && (
          <DialogContent size="lg" title={`Documents de ${fullName(docsCandidate)}`} description="Déposés depuis l'application Rydar Drive : validez-les avant ou après la candidature.">
            <DriverDocuments
              driverId={docsCandidate.id}
              firstName={docsCandidate.first_name}
              items={docsCandidate.documents}
              missing={docsCandidate.missing}
              canReview={canReviewDocuments}
            />
          </DialogContent>
        )}
      </Dialog>
    </Card>
  );
}
