"use client";
// Super admin : signalements de fraude envoyés par les centrales → bannissement de toute la plateforme.
import { BAN_CATEGORY_META, DRIVER_STATUS_META, IDENTITY_KIND_LABELS, formatDate, formatRelative, type FraudReport } from "@rydar/shared";
import { AlertTriangle, Archive, Fingerprint, Gavel, ShieldBan, ShieldCheck, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { dismissFraudReport, fraudReportMatches, liftPlatformBan, platformBanReport } from "@/app/admin/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { runAction } from "@/lib/run-action";
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
type Preview = Extract<Awaited<ReturnType<typeof fraudReportMatches>>, { ok: true }>["preview"];
/** Aperçu des fiches liées, chargé à l'ouverture de « Bannir » (data et error nuls = en cours). */
type PreviewState = { reportId: string; data: Preview | null; error: string | null } | null;

/** « Carte VTC » → « carte VTC » (sigles conservés). */
const lowerFirst = (v: string) => v.charAt(0).toLowerCase() + v.slice(1);
const kindLabel = (kind: string) => IDENTITY_KIND_LABELS[kind as keyof typeof IDENTITY_KIND_LABELS] ?? kind;
/** Saisie par la centrale dans les 30 jours qui précèdent le signalement : à vérifier en priorité. */
const RECENT_EDIT_DAYS = 30;

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
  const [preview, setPreview] = useState<PreviewState>(null);
  const [extend, setExtend] = useState<string[]>([]);

  const open = (report: AdminFraudReport, kind: NonNullable<Pending>["kind"]) => {
    setText("");
    setConfirmed(false);
    setExtend([]);
    setPending({ report, kind });
    if (kind !== "ban") return setPreview(null);
    // Fiches d'autres centrales qui partagent une identité : visibles AVANT la décision, à confirmer une à une
    setPreview({ reportId: report.id, data: null, error: null });
    fraudReportMatches(report.id)
      .then((res) => ({ data: res.ok ? res.preview : null, error: res.ok ? null : res.error }))
      .catch(() => ({ data: null, error: "Aperçu indisponible." }))
      .then((next) => setPreview((cur) => (cur?.reportId === report.id ? { reportId: report.id, ...next } : cur)));
  };
  const previewLoading =
    pending?.kind === "ban" && (!preview || preview.reportId !== pending.report.id || (!preview.data && !preview.error));

  const run = () =>
    start(() => runAction(async () => {
      if (!pending) return;
      const { report, kind } = pending;
      const s = (n: number) => (n > 1 ? "s" : "");
      if (kind === "ban") {
        const res = await platformBanReport(report.id, text, extend);
        if (!res.ok) return void toast.error(res.error);
        const kept = res.identitiesSkipped
          ? ` · ${res.identitiesSkipped} identité${s(res.identitiesSkipped)} partagée${s(res.identitiesSkipped)} avec une fiche non confirmée : refusée${s(res.identitiesSkipped)} seulement chez ${report.organization?.name ?? "la centrale qui signale"}`
          : "";
        toast.success(`${report.driver_label} banni de toute la plateforme`, {
          description: `${res.identities} identité${s(res.identities)} refusée${s(res.identities)} partout · ${res.drivers} compte${s(res.drivers)} suspendu${s(res.drivers)} et déconnecté${s(res.drivers)}${kept}.`,
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
    }));

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
                ? "Décision lourde : ses identifiants connus (téléphone, e-mail, carte VTC, appareils…) seront refusés à toute nouvelle inscription dans toutes les centrales Rydar Drive."
                : pending.kind === "dismiss"
                  ? `Le chauffeur reste banni par ${pending.report.organization?.name ?? "sa centrale"} uniquement ; les autres centrales ne sont pas concernées.`
                  : "Les identités ne sont plus refusées ailleurs. Le chauffeur signalé reste banni par sa centrale."
            }
          >
            {pending.kind === "ban" && (
              <ul className="mb-4 space-y-1.5 text-[12.5px] text-fg-muted">
                <li className="flex gap-2"><span className="text-red">•</span> Identités refusées partout : <IdentityCount report={pending.report} /></li>
                <li className="flex gap-2"><span className="text-red">•</span> Fiches de sa centrale qui les partagent : suspendues, retirées des offres et déconnectées ; fiches d&apos;autres centrales : seulement celles que vous cochez.</li>
                <li className="flex gap-2"><span className="text-red">•</span> Connexion bloquée au niveau du compte (Auth), sauf pour un compte qui gère aussi une centrale ; réversible avec « Lever ».</li>
              </ul>
            )}
            {pending.kind === "ban" && (
              <BanPreview
                state={preview?.reportId === pending.report.id ? preview : null}
                orgName={pending.report.organization?.name ?? "la centrale qui signale"}
                extend={extend}
                onToggle={(id, on) => setExtend((cur) => (on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id)))}
              />
            )}
            {pending.kind === "lift" && (
              <p className="mb-4 text-[12.5px] text-fg-muted">
                Les autres comptes touchés par ricochet sont débannis mais restent suspendus : leur centrale décide de les réactiver. Un
                chauffeur que sa centrale avait déjà banni le reste.
              </p>
            )}
            <Field label={pending.kind === "lift" ? "Motif de la levée" : "Note (visible par la centrale)"} optional>
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
                <Button variant="danger" loading={busy} disabled={!confirmed || previewLoading} onClick={run}>
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
  const kinds = [...new Set(report.identities.map((i) => lowerFirst(kindLabel(i.kind))))];
  return <span className="text-fg">{kinds.length ? kinds.join(", ") : "aucune"}</span>;
}

/**
 * Avant « Bannir partout » : identités saisies par la centrale qui signale (date) et fiches qui les partagent.
 * Une fiche d'une autre centrale n'est touchée que cochée : une centrale peut recopier sur sa propre fiche le
 * téléphone ou la carte VTC d'un chauffeur concurrent avant de le signaler.
 */
function BanPreview({
  state,
  orgName,
  extend,
  onToggle,
}: {
  state: PreviewState;
  orgName: string;
  extend: string[];
  onToggle: (driverId: string, on: boolean) => void;
}) {
  if (!state || (!state.data && !state.error)) {
    return <p className="mb-4 text-[12.5px] text-fg-muted">Recherche des fiches qui partagent ces identités…</p>;
  }
  if (!state.data) {
    return (
      <p className="mb-4 text-[12.5px] text-amber">
        {state.error} Sans aperçu, seules les fiches de {orgName} seront touchées.
      </p>
    );
  }
  const { identities, matches, reportedAt } = state.data;
  const edited = identities.filter((i): i is typeof i & { edited_by_org_at: string } => !!i.edited_by_org_at);
  const same = matches.filter((m) => m.same_org);
  const others = matches.filter((m) => !m.same_org);
  const daysBefore = (at: string) => Math.max(0, Math.floor((new Date(reportedAt).getTime() - new Date(at).getTime()) / 86_400_000));

  return (
    <div className="mb-4 space-y-3 text-[12.5px]">
      {edited.length > 0 && (
        <div className="space-y-1">
          <p className="font-medium text-fg">Identités saisies par {orgName}</p>
          <ul className="space-y-1">
            {edited.map((i, k) => {
              const days = daysBefore(i.edited_by_org_at);
              const recent = days <= RECENT_EDIT_DAYS;
              return (
                <li key={`${i.kind}-${k}`} className={cn("flex gap-2", recent ? "text-red" : "text-fg-muted")}>
                  {recent ? <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <span aria-hidden>•</span>}
                  <span>
                    {kindLabel(i.kind)} <span className="num">{i.hint ?? "••••"}</span> : dernière saisie le {formatDate(i.edited_by_org_at)}
                    {days === 0 ? ", le jour du signalement" : `, ${days} jour${days > 1 ? "s" : ""} avant le signalement`}
                    {recent ? " — vérifiez qu'elle appartient bien à ce chauffeur." : "."}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {same.length > 0 && (
        <p className="text-fg-muted">
          Suspendues avec lui ({orgName}) :{" "}
          {same.map((m, k) => (
            <span key={m.driver_id} className="text-fg">
              {k > 0 && ", "}
              {m.first_name} {m.last_name} <span className="num">#{m.number}</span>
            </span>
          ))}
        </p>
      )}
      {others.length === 0 ? (
        <p className="text-fg-muted">Aucune fiche d&apos;une autre centrale ne partage ces identités.</p>
      ) : (
        <div className="space-y-1.5">
          <p className="font-medium text-fg">
            {others.length} fiche{others.length > 1 ? "s" : ""} à confirmer (autres centrales, ou même véhicule seulement) partage{others.length > 1 ? "nt" : ""} une identité
          </p>
          <p className="text-fg-muted">
            Non cochée : la fiche n&apos;est pas touchée et l&apos;identité partagée reste refusée seulement chez {orgName}.
          </p>
          <ul className="space-y-1.5">
            {others.map((m) => (
              <li key={m.driver_id}>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-white/[0.02] px-3 py-2">
                  <input
                    type="checkbox"
                    checked={extend.includes(m.driver_id)}
                    onChange={(e) => onToggle(m.driver_id, e.target.checked)}
                    className="mt-0.5 size-4 accent-[var(--color-red)]"
                  />
                  <span className="min-w-0 text-fg-muted">
                    <span className="font-medium text-fg">
                      {m.first_name} {m.last_name} <span className="num">#{m.number}</span>
                    </span>
                    {" · "}
                    {m.organization_name} · fiche créée le {formatDate(m.created_at)} · {DRIVER_STATUS_META[m.status]?.label ?? m.status}
                    {m.banned ? " · déjà banni par sa centrale" : ""}
                    <br />
                    En commun : {m.kinds.map((k) => lowerFirst(kindLabel(k))).join(", ")}
                    {m.manages_org ? " · gère aussi une centrale : connexion conservée" : ""}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
