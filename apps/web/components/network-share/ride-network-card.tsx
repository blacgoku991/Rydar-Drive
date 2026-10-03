"use client";
// Fiche course de l'organisation qui confie la course (A) : bloc « Réseau partagé » (org_network_ride) — état du
// partage (compteur de partenaires seulement), chauffeur partenaire (libellé court, véhicule, téléphone dans sa
// fenêtre), montants acceptés et règlement (mêmes actions que « Courses confiées »), contrôles figés, carte permanente
// de l'organisation du chauffeur, lectures des coordonnées du client. Actions : Retirer (la recherche repart, vos
// chauffeurs d'abord), Clôturer la course (partenaire empêché de la terminer). Jamais d'identifiant d'un partenaire
// non retenu.
import { NETWORK_EXECUTION_END_LABELS, formatPhone, formatPrice, formatRideDate, type NetworkGivenItem, type OrgNetworkRide } from "@rydar/shared";
import { ArrowLeftRight, CheckCheck, Mail, Phone, ShieldAlert, Undo2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { closeNetworkRide, removeNetworkRide } from "@/app/dashboard/reseau-partage/actions";
import { givenToCheck } from "@/components/network-share/given";
import { GivenActions } from "@/components/network-share/given-actions";
import { networkShareHref } from "@/components/network-share/paths";
import {
  checkLines, clientReadsText, givenItemOf, rideNetworkActions, shareSummary, suspectLabels, type GivenRideFields,
} from "@/components/network-share/ride-network";
import { useNetworkRunner } from "@/components/network-share/use-network-runner";
import { DeclarationLine, SettlementBadge, dueInfo, fromNow } from "@/components/settlements/settlement-ui";
import { Badge, toneText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { useNow } from "@/hooks/use-now";
import { cn, submitWith } from "@/lib/utils";

type Props = {
  ride: GivenRideFields & { driver_id: string | null };
  data: OrgNetworkRide | null;
  /** Lecture en échec (bloc réduit, rien n'est inventé) */
  failed: boolean;
  /** Dernier journal « dispatch.network_skipped » (« Course sans prix : non proposée au réseau partagé »…) */
  skipped?: string | null;
  canManage: boolean;
  timeZone: string;
  serverNow: number;
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[12.5px]">
      <span className="shrink-0 text-fg-subtle">{label}</span>
      <span className="min-w-0 text-right text-fg [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

export function RideNetworkCard({ ride, data, failed, skipped, canManage, timeZone, serverNow }: Props) {
  const now = useNow(30_000) ?? serverNow;
  const [mode, setMode] = useState<"remove" | "close" | null>(null);
  const item = useMemo<NetworkGivenItem | null>(() => (data ? givenItemOf(ride, data) : null), [ride, data]);

  if (!data) {
    return (
      <Card>
        <CardHeader title="Réseau partagé" icon={<ArrowLeftRight className="text-violet" />} />
        <CardBody>
          <p className="text-[13px] text-fg-muted">
            {failed
              ? "Détails du réseau partagé momentanément indisponibles : rechargez la page dans un instant."
              : (skipped ?? "Cette course n'a pas été proposée au réseau partagé.")}
          </p>
        </CardBody>
      </Card>
    );
  }

  const share = data.share ? shareSummary(data.share, timeZone) : null;
  const e = data.execution;
  const held = !!e && !e.ended_at;
  const can = rideNetworkActions(item, data, { canManage, now });
  const s = data.settlement;
  const live = s ? { ...s, overdue: s.direction === "driver_owes" && s.status === "due" && Date.parse(s.due_at) <= now } : null;
  const due = live ? dueInfo(live, now, { blockUnpaid: false }) : null;
  // Même règle que la liste « Courses confiées » (course terminée, signalée, ni validée ni contestée)
  const toCheck = !!item && givenToCheck(item);
  const t = e?.terms;
  const vehicle = e ? [[e.vehicle.brand, e.vehicle.model].filter(Boolean).join(" "), e.vehicle.color].filter(Boolean).join(" · ") : "";
  const op = data.operator;

  return (
    <Card className="border-violet/25">
      <CardHeader
        // Badge dans la ligne du titre (il passe dessous sur téléphone, sans écraser la description)
        title={
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            Réseau partagé
            {share && <Badge tone={share.tone}>{share.label}</Badge>}
          </span>
        }
        icon={<ArrowLeftRight className="text-violet" />}
        description={share?.detail ?? "Course passée par le réseau partagé."}
      />
      <CardBody className="space-y-5">
        {e && (
          <section aria-label="Chauffeur partenaire" className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[15px] font-semibold">
                  {e.driver_label} <span className="font-normal text-violet">· {e.partner.name}</span>
                </p>
                <p className="text-[12.5px] text-fg-muted">
                  {vehicle}
                  {e.vehicle.plate ? <span className="mono"> · {e.vehicle.plate}</span> : null}
                </p>
                <p className="mt-0.5 text-[12px] text-fg-subtle">
                  {held ? `Acceptée ${fromNow(e.accepted_at, now)}` : `Acceptée le ${formatRideDate(e.accepted_at, timeZone, new Date(now))}`}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {e.driver_phone ? (
                  <Button asChild variant="secondary" size="sm">
                    <a href={`tel:${e.driver_phone}`} title={formatPhone(e.driver_phone)}>
                      <Phone /> Appeler {e.driver_label.split(" ")[0]}
                    </a>
                  </Button>
                ) : null}
                {can.remove && (
                  <Button variant="outline" size="sm" onClick={() => setMode("remove")}>
                    <Undo2 /> Retirer la course
                  </Button>
                )}
                {can.close && (
                  <Button variant="outline" size="sm" onClick={() => setMode("close")}>
                    <CheckCheck /> Clôturer la course
                  </Button>
                )}
              </div>
            </div>
            <p className="text-[12px] text-fg-muted">
              {e.driver_phone
                ? `Téléphone du chauffeur visible ${e.driver_phone_until ? `jusqu'au ${formatRideDate(e.driver_phone_until, timeZone, new Date(now))}` : "pendant la course"}.`
                : "Téléphone du chauffeur masqué (plus de 48 h après la course)."}
            </p>
          </section>
        )}

        {e && t && (
          <section aria-label="Montants et règlement" className="space-y-3 rounded-xl border border-line bg-white/[0.02] p-3.5">
            <div className="grid grid-cols-3 gap-3 text-[12px]">
              <div>
                <p className="text-fg-subtle">Prix</p>
                <p className="mono text-[14px] font-semibold text-fg">{formatPrice(t.price_cents, ride.currency)}</p>
              </div>
              <div>
                <p className="text-fg-subtle">Votre part</p>
                <p className="mono text-[14px] font-semibold text-fg">{formatPrice(t.giver_cut_cents, ride.currency)}</p>
              </div>
              <div>
                <p className="text-fg-subtle">Part du chauffeur</p>
                <p className="mono text-[14px] font-semibold text-brand">{formatPrice(t.driver_payout_cents, ride.currency)}</p>
              </div>
            </div>
            <p className="text-[12.5px] text-fg-muted">
              {t.collects
                ? <>Client payé à bord : {e.driver_label} vous reverse <span className="mono text-fg">{formatPrice(t.giver_cut_cents, ride.currency)}</span>.</>
                : <>Client déjà payé : vous versez <span className="mono text-fg">{formatPrice(t.driver_payout_cents, ride.currency)}</span> à {e.driver_label}.</>}{" "}
              Montants acceptés par le chauffeur, figés.
            </p>
            {live ? (
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mono text-[14px] font-semibold">{formatPrice(live.amount_cents, live.currency)}</span>
                  <SettlementBadge settlement={live} />
                  <span className="text-[12px] text-fg-subtle">réf. <span className="mono text-fg-muted">{live.reference}</span></span>
                </div>
                {live.status === "declared" ? (
                  <DeclarationLine settlement={live} now={now} />
                ) : e.on_hold && e.hold_until ? (
                  <p className="text-[12px] text-amber">Versement retenu jusqu&apos;à validation, au plus tard {fromNow(e.hold_until, now)}.</p>
                ) : due ? (
                  <p className={cn("text-[12px]", toneText[due.tone])}>{due.text}</p>
                ) : null}
                {live.note && (live.status === "disputed" || live.status === "waived") && <p className="text-[12px] text-fg-subtle">« {live.note} »</p>}
              </div>
            ) : (
              <p className="text-[12px] text-fg-subtle">
                {held ? "Règlement créé à la fin de la course." : e.end_reason === "completed" ? "Aucun montant à régler pour cette course." : "Course non réalisée par le partenaire : aucun règlement."}
              </p>
            )}
            {/* Mêmes actions, alignées à droite, que la liste « Courses confiées » */}
            {item && <GivenActions item={item} can={can} className="justify-end" />}
          </section>
        )}

        {e && toCheck && (
          <p role="status" className="flex items-start gap-2 rounded-lg border border-amber/30 bg-amber/[0.07] px-3 py-2.5 text-[12.5px] text-fg-muted">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber" />
            <span>
              <span className="font-medium text-fg">À vérifier</span> : {suspectLabels(e.suspect_reasons).join(" · ")}. Rien n&apos;est refusé au chauffeur ;
              validez la course ou contestez-la dans les 7 jours.
            </span>
          </p>
        )}
        {e?.contested_at && (
          <p className="rounded-lg border border-red/25 bg-red/[0.06] px-3 py-2.5 text-[12.5px] text-fg-muted">
            <span className="font-medium text-red">Course contestée</span> {fromNow(e.contested_at, now)}
            {e.contested_reason ? <> · « {e.contested_reason} »</> : null}
          </p>
        )}
        {e?.driver_disputed_at && (
          <p className="rounded-lg border border-red/25 bg-red/[0.06] px-3 py-2.5 text-[12.5px] text-fg-muted">
            <span className="font-medium text-red">Le chauffeur conteste</span> {fromNow(e.driver_disputed_at, now)}
            {e.driver_dispute_reason ? <> · « {e.driver_dispute_reason} »</> : null}
          </p>
        )}

        {/* Sous-titres en h3 : le titre de la carte (CardHeader) est un h2, sans saut de niveau */}
        {e && (
          <section aria-label="Contrôles à l'acceptation">
            <h3 className="text-[12.5px] font-medium text-fg">Contrôles à l&apos;acceptation</h3>
            <p className="text-[11.5px] text-fg-subtle">
              Pièces vérifiées par {e.partner.name}
              {e.checks.verified_at ? ` (dernière vérification ${formatRideDate(e.checks.verified_at, timeZone, new Date(now)).toLowerCase()})` : ""} ; vous pouvez lui demander les justificatifs.
            </p>
            <div className="mt-1.5 divide-y divide-line">
              {checkLines(e.checks, ride.pickup_at).map((l) => (
                <Row key={l.label} label={l.label}>
                  <span className={cn(l.expired && "text-red")}>{l.value}</span>
                </Row>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-fg-subtle">{clientReadsText(e.client_data, timeZone)}</p>
          </section>
        )}

        {op && (
          <section aria-label="Organisation du chauffeur" className="rounded-xl border border-line px-3.5 py-3">
            <h3 className="text-[12.5px] font-medium text-fg">Organisation du chauffeur</h3>
            <div className="mt-1 divide-y divide-line">
              <Row label="Nom">{op.name}</Row>
              <Row label="Raison sociale">{op.legal_name}</Row>
              <Row label="SIRET"><span className="mono">{op.siret}</span></Row>
              <Row label="N° d'inscription VTC"><span className="mono">{op.vtc_registration}</span></Row>
              {op.driver_operator_registration && (
                <Row label="N° d'exploitant du chauffeur"><span className="mono">{op.driver_operator_registration}</span></Row>
              )}
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {op.phone && (
                <Button asChild variant="ghost" size="xs">
                  <a href={`tel:${op.phone}`}>
                    <Phone /> {formatPhone(op.phone)}
                  </a>
                </Button>
              )}
              {op.email && (
                <Button asChild variant="ghost" size="xs">
                  <a href={`mailto:${op.email}`}>
                    <Mail /> {op.email}
                  </a>
                </Button>
              )}
            </div>
            <p className="mt-1.5 text-[11.5px] text-fg-subtle">Pour un incident (amende, sinistre, objet perdu), elle vous demande les faits précis.</p>
          </section>
        )}

        {data.previous.length > 0 && (
          <section aria-label="Chauffeurs partenaires précédents">
            <h3 className="text-[12.5px] font-medium text-fg">Chauffeurs partenaires précédents</h3>
            <ul className="mt-1 space-y-1 text-[12px] text-fg-muted">
              {data.previous.map((p) => (
                <li key={p.id}>
                  {p.driver_label} <span className="text-violet">· {p.partner.name}</span>
                  {p.end_reason ? ` · ${NETWORK_EXECUTION_END_LABELS[p.end_reason] ?? ""}` : ""}
                  {p.ended_at ? ` ${formatRideDate(p.ended_at, timeZone, new Date(now)).toLowerCase()}` : ""}
                </li>
              ))}
            </ul>
          </section>
        )}

        <Link href={networkShareHref({ tab: "confiees" })} prefetch={false} className="inline-block text-[12px] text-fg-subtle underline-offset-2 hover:text-fg hover:underline">
          Toutes les courses confiées <span aria-hidden>→</span>
        </Link>
      </CardBody>

      {mode === "remove" && e && <RemoveDialog ride={ride} driverLabel={e.driver_label} partner={e.partner.name} onClose={() => setMode(null)} />}
      {mode === "close" && <CloseDialog ride={ride} onClose={() => setMode(null)} />}
    </Card>
  );
}

// ---------------------------------------------------------------------------- Retirer
function RemoveDialog({ ride, driverLabel, partner, onClose }: { ride: Props["ride"]; driverLabel: string; partner: string; onClose: () => void }) {
  const { pending, run } = useNetworkRunner();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        size="sm"
        title={`Retirer la course #${ride.number}`}
        description={`${driverLabel} (${partner}) est prévenu. La recherche repart, vos chauffeurs d'abord ; vous pourrez ensuite modifier la course.`}
      >
        <form onSubmit={submitWith((data) => run(() => removeNetworkRide(ride.id, ride.driver_id, String(data.get("reason") ?? "")), onClose))}>
          <Field label="Motif" optional>
            <Textarea name="reason" maxLength={300} placeholder="Ex. le client a changé d'adresse" className="min-h-[64px]" />
          </Field>
          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Retour</Button>
            <Button type="submit" variant="danger" loading={pending}>
              <Undo2 /> Retirer la course
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- Clôturer la course
function CloseDialog({ ride, onClose }: { ride: Props["ride"]; onClose: () => void }) {
  const { pending, run } = useNetworkRunner();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        size="sm"
        title={`Clôturer la course #${ride.number}`}
        description="À utiliser quand le chauffeur partenaire ne peut plus la terminer dans l'application (son organisation ou sa fiche n'est plus active, ou aucune position depuis 30 min)."
      >
        <p className="text-[13px] text-fg-muted">
          La course passe « Terminée » : le règlement et les frais sont créés comme d&apos;habitude, et la course est marquée « à vérifier ».
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Retour</Button>
          <Button variant="primary" loading={pending} onClick={() => run(() => closeNetworkRide(ride.id), onClose)}>
            <CheckCheck /> Clôturer
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
