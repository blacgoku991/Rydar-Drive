"use client";
// Super admin : signalements de fraude envoyés par les centrales → bannissement de toute la plateforme.
import { BAN_CATEGORY_META, IDENTITY_KIND_LABELS, formatDate, formatRelative, type FraudReport } from "@rydar/shared";
import { Archive, Fingerprint, Gavel, ShieldBan, ShieldCheck, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { dismissFraudReport, liftPlatformBan, platformBanReport } from "@/app/admin/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

type Person = { full_name: string | null; email: string } | null;
export type AdminFraudReport = FraudReport & {
  organization: { id: string; name: string } | null;
  reporter: Person;
  reviewer: Person;
  /** Comptes bannis par ce signalement (bannissement plateforme, toutes centrales) */
  touched: { id: string; number: number; first_name: string; last_name: string; organization: { name: string } | null }[];
};

export const REPORT_STATUS_META: Record<FraudReport["status"], { label: string; tone: "amber" | "red" | "neutral" | "blue" }> = {
  open: { label: "À examiner", tone: "amber" },
  platform_banned: { label: "Banni de la plateforme", tone: "red" },
  dismissed: { label: "Classé", tone: "neutral" },
  lifted: { label: "Bannissement levé", tone: "blue" },
};

type Pending = { report: AdminFraudReport; kind: "ban" | "dismiss" | "lift" } | null;

export function IdentityChips({ identities }: { identities: FraudReport["identities"] }) {
  if (!identities?.length) return <span className="text-[12px] text-fg-subtle">Aucune identité exploitable.</span>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {identities.map((i) => (
        <li key={`${i.kind}-${i.hash}`} className="inline-flex items-center gap-1.5 rounded-md border border-line bg-white/[0.03] px-2 py-1 text-[11.5px]">
          <span className="text-fg-subtle">{IDENTITY_KIND_LABELS[i.kind] ?? i.kind}</span>
          <span className="num font-medium text-fg">{i.hint ?? "••••"}</span>
        </li>
      ))}
    </ul>
  );
}

export function FraudReportsList({ reports }: { reports: AdminFraudReport[] }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [pending, setPending] = useState<Pending>(null);
  const [text, setText] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const open = (report: AdminFraudReport, kind: NonNullable<Pending>["kind"]) => {
    setText("");
    setConfirmed(false);
    setPending({ report, kind });
  };

  const run = () =>
    start(async () => {
      if (!pending) return;
      const { report, kind } = pending;
      const s = (n: number) => (n > 1 ? "s" : "");
      if (kind === "ban") {
        const res = await platformBanReport(report.id, text);
        if (!res.ok) return void toast.error(res.error);
        toast.success(`${report.driver_label} banni de toute la plateforme`, {
          description: `${res.identities} identité${s(res.identities)} refusée${s(res.identities)} partout · ${res.drivers} compte${s(res.drivers)} suspendu${s(res.drivers)} et déconnecté${s(res.drivers)}.`,
        });
      } else if (kind === "lift") {
        const res = await liftPlatformBan(report.id, text);
        if (!res.ok) return void toast.error(res.error);
        toast.success("Bannissement plateforme levé", {
          description: `${report.driver_label} reste banni par sa centrale${res.accounts ? ` · ${res.accounts} autre${s(res.accounts)} compte${s(res.accounts)} débanni${s(res.accounts)} (toujours suspendu${s(res.accounts)})` : ""}.`,
        });
      } else {
        const res = await dismissFraudReport(report.id, text);
        if (!res.ok) return void toast.error(res.error);
        toast.success("Signalement classé", { description: "Le bannissement reste limité à la centrale." });
      }
      setPending(null);
      router.refresh();
    });

  if (!reports.length) {
    return <EmptyState icon={<ShieldCheck />} title="Aucun signalement" description="Les centrales signalent ici les chauffeurs bannis pour fraude : vous décidez d'un bannissement sur toute la plateforme." />;
  }

  const sorted = [...reports].sort(
    (a, b) => Number(b.status === "open") - Number(a.status === "open") || new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const firstClosed = sorted.findIndex((r) => r.status !== "open");

  return (
    <>
      <ul className="divide-y divide-line">
        {sorted.map((r, i) => {
          const meta = REPORT_STATUS_META[r.status];
          const reporter = r.reporter?.full_name ?? r.reporter?.email ?? "la centrale";
          const reviewer = r.reviewer?.full_name ?? r.reviewer?.email ?? "Rydar";
          return (
            <li key={r.id} className={cn("px-5 py-4", r.status === "open" && "bg-amber/[0.03]")}>
              {i === firstClosed && firstClosed > 0 && <p className="-mt-1 mb-3 text-[11.5px] font-medium uppercase tracking-[0.08em] text-fg-subtle">Traités</p>}
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={meta.tone} pulse={r.status === "open"}>{meta.label}</Badge>
                    <p className="text-[14px] font-semibold">{r.driver_label}</p>
                    <Badge tone="neutral" dot={false}>{BAN_CATEGORY_META[r.category]?.label ?? r.category}</Badge>
                  </div>
                  <p className="text-[12.5px] text-fg-muted">
                    {r.organization ? (
                      <Link href={`/admin/organizations/${r.organization.id}`} className="font-medium text-fg hover:text-brand">{r.organization.name}</Link>
                    ) : (
                      "Centrale supprimée"
                    )}
                    {" · "}signalé par {reporter} · <span title={formatDate(r.created_at)} suppressHydrationWarning>{formatRelative(r.created_at)}</span>
                  </p>
                  <p className="rounded-lg border border-line bg-white/[0.02] px-3 py-2 text-[13px] leading-relaxed text-fg">« {r.reason} »</p>
                  <div className="flex items-start gap-2">
                    <Fingerprint className="mt-1 size-3.5 shrink-0 text-fg-subtle" aria-label="Identités" />
                    <IdentityChips identities={r.identities} />
                  </div>
                  {r.status === "platform_banned" && r.touched.length > 0 && (
                    <p className="text-[12px] text-fg-subtle">
                      Comptes bannis :{" "}
                      {r.touched.map((d, k) => (
                        <span key={d.id} className="text-fg-muted">
                          {k > 0 && ", "}
                          {d.first_name} {d.last_name} <span className="num">#{d.number}</span>
                          {d.organization ? ` (${d.organization.name})` : ""}
                        </span>
                      ))}
                    </p>
                  )}
                  {r.status !== "open" && r.reviewed_at && (
                    <p className="text-[12px] text-fg-subtle">
                      {meta.label} par {reviewer} le {formatDate(r.reviewed_at)}
                      {r.review_note ? <> — <span className="text-fg-muted">{r.review_note}</span></> : null}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2 lg:flex-col lg:items-stretch">
                  {r.status === "open" && (
                    <>
                      <Button variant="danger" size="sm" onClick={() => open(r, "ban")}>
                        <ShieldBan /> Bannir de toute la plateforme
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => open(r, "dismiss")}>
                        <Archive /> Classer
                      </Button>
                    </>
                  )}
                  {r.status === "platform_banned" && (
                    <Button variant="outline" size="sm" onClick={() => open(r, "lift")}>
                      <Undo2 /> Lever
                    </Button>
                  )}
                  {(r.status === "dismissed" || r.status === "lifted") && (
                    <Button variant="ghost" size="sm" onClick={() => open(r, "ban")}>
                      <Gavel /> Bannir de la plateforme
                    </Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <Dialog open={!!pending} onOpenChange={(o) => !o && !busy && setPending(null)}>
        {pending && (
          <DialogContent
            title={
              pending.kind === "ban"
                ? `Bannir ${pending.report.driver_label} de toute la plateforme ?`
                : pending.kind === "dismiss"
                  ? "Classer ce signalement ?"
                  : "Lever le bannissement plateforme ?"
            }
            description={
              pending.kind === "ban"
                ? "Décision lourde : ses identités seront refusées dans toutes les centrales Rydar Drive, même avec un nouveau compte."
                : pending.kind === "dismiss"
                  ? `Le chauffeur reste banni par ${pending.report.organization?.name ?? "sa centrale"} uniquement ; les autres centrales ne sont pas concernées.`
                  : "Les identités ne sont plus refusées ailleurs. Le chauffeur signalé reste banni par sa centrale."
            }
          >
            {pending.kind === "ban" && (
              <ul className="mb-4 space-y-1.5 text-[12.5px] text-fg-muted">
                <li className="flex gap-2"><span className="text-red">•</span> Identités refusées partout : <IdentityCount report={pending.report} /></li>
                <li className="flex gap-2"><span className="text-red">•</span> Tout compte qui les partage (toutes centrales) est suspendu, retiré des offres et déconnecté.</li>
                <li className="flex gap-2"><span className="text-red">•</span> Connexion bloquée au niveau du compte (Auth) ; réversible avec « Lever ».</li>
              </ul>
            )}
            {pending.kind === "lift" && (
              <p className="mb-4 text-[12.5px] text-fg-muted">
                Les autres comptes touchés par ricochet sont débannis mais restent suspendus : leur centrale décide de les réactiver.
              </p>
            )}
            <Field label={pending.kind === "lift" ? "Motif de la levée" : "Note interne"} optional>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={500}
                placeholder={pending.kind === "ban" ? "Preuves vérifiées, récidive…" : pending.kind === "dismiss" ? "Litige commercial, preuves insuffisantes…" : "Erreur d'identité, dette réglée…"}
              />
            </Field>
            {pending.kind === "ban" && (
              <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-red/25 bg-red/[0.06] px-3 py-2.5 text-[12.5px] text-fg">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-red)]" />
                Je confirme le bannissement définitif de ce chauffeur sur toute la plateforme.
              </label>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => setPending(null)}>Annuler</Button>
              {pending.kind === "ban" ? (
                <Button variant="danger" loading={busy} disabled={!confirmed} onClick={run}>
                  <ShieldBan /> Bannir partout
                </Button>
              ) : pending.kind === "dismiss" ? (
                <Button variant="primary" loading={busy} onClick={run}>
                  <Archive /> Classer
                </Button>
              ) : (
                <Button variant="primary" loading={busy} onClick={run}>
                  <Undo2 /> Lever le bannissement
                </Button>
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

function IdentityCount({ report }: { report: AdminFraudReport }) {
  // « Carte VTC » → « carte VTC » (sigles conservés)
  const lower = (v: string) => v.charAt(0).toLowerCase() + v.slice(1);
  const kinds = [...new Set(report.identities.map((i) => lower(IDENTITY_KIND_LABELS[i.kind] ?? i.kind)))];
  return <span className="text-fg">{kinds.length ? kinds.join(", ") : "aucune"}</span>;
}
