"use client";
// Super admin — suppressions de comptes chauffeur : recherche du compte (demande reçue par e-mail), suppression
// confirmée, file des suppressions (fichiers, compte de connexion) avec « Réessayer ».
import { formatDate, formatRelative } from "@rydar/shared";
import { AlertTriangle, CheckCircle2, RotateCw, Search, Trash2, UserX } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { Field, Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/misc";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";
import { plural } from "@/lib/wording";
import { deleteDriverOnRequest, findDriversForDeletion, retryDriverDeletion } from "./actions";
import type { DeletionItem, DeletionQueue, DriverMatch } from "./types";

const STATUS_LABEL: Record<DriverMatch["status"], string> = {
  invited: "Invité",
  active: "Actif",
  inactive: "Inactif",
  suspended: "Suspendu",
};

// -----------------------------------------------------------------------------
// Recherche + suppression
// -----------------------------------------------------------------------------
export function DriverDeletionSearch() {
  const router = useRouter();
  const [searching, startSearch] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DriverMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<DriverMatch | null>(null);
  const [confirm, setConfirm] = useState("");

  const search = (value: string) =>
    startSearch(() => runAction(async () => {
      setError(null);
      const res = await findDriversForDeletion(value);
      if (!res.ok) {
        setResults(null);
        setError(res.error);
        return;
      }
      setResults(res.drivers);
    }));

  const remove = () =>
    startDelete(() => runAction(async () => {
      if (!target) return;
      const res = await deleteDriverOnRequest(target.id, confirm);
      if (!res.ok) return void toast.error(res.error);
      if (res.pending) toast.warning(res.message);
      else toast.success(res.message);
      setResults((list) => list?.filter((d) => d.id !== target.id) ?? null);
      setTarget(null);
      router.refresh();
    }));

  return (
    <Card>
      <CardHeader
        icon={<UserX />}
        title="Supprimer le compte d'un chauffeur"
        description={"Demande reçue sans l'application\u00a0: vérifiez qu'elle vient de l'adresse e-mail (ou du numéro) du compte, supprimez, puis confirmez-lui la suppression par e-mail."}
      />
      <div className="space-y-4 p-5">
        <form onSubmit={submitWith((data) => search(String(data.get("q") ?? "")))} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label="E-mail ou téléphone du chauffeur" htmlFor="deletion-q" className="flex-1" error={error ?? undefined}>
            <Input
              id="deletion-q"
              name="q"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={"ex.\u00a0: chauffeur@exemple.fr ou 06 12 34 56 78"}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!error}
              maxLength={254}
            />
          </Field>
          <Button type="submit" loading={searching} disabled={query.trim().length < 3}>
            <Search /> Rechercher
          </Button>
        </form>

        {results && results.length === 0 && (
          <Callout title="Aucun chauffeur avec cette adresse ou ce numéro, chez aucun client.">
            Un compte déjà supprimé n&apos;est plus retrouvable{"\u00a0"}: ses coordonnées ont été effacées.
          </Callout>
        )}

        {results && results.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {results.map((d) => {
              const blocked = d.rides_assigned > 0;
              return (
                <li key={d.id} className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[14px] font-semibold">
                        {d.first_name} {d.last_name} <span className="num text-fg-muted">#{d.number}</span>
                      </p>
                      <Badge tone={d.status === "active" ? "green" : d.status === "suspended" ? "amber" : "neutral"}>{STATUS_LABEL[d.status]}</Badge>
                      {d.application_status === "pending" && <Badge tone="blue">Candidature en attente</Badge>}
                      {d.banned && <Badge tone="red">Banni</Badge>}
                    </div>
                    <p className="text-[12.5px] text-fg-muted">
                      {d.organization.name}
                      {d.organization.status === "archived" ? " (client archivé)" : d.organization.status !== "active" ? " (client suspendu)" : ""} ·{" "}
                      <span className="[overflow-wrap:anywhere]">{d.email ?? d.account_email ?? "sans e-mail"}</span> ·{" "}
                      <span className="num">{d.phone || "sans téléphone"}</span> · inscrit le {formatDate(d.created_at)}
                    </p>
                    {d.account_email && d.email && d.account_email.toLowerCase() !== d.email.toLowerCase() && (
                      <p className="text-[12px] text-fg-muted [overflow-wrap:anywhere]">Compte de connexion{"\u00a0"}: {d.account_email}</p>
                    )}
                    {blocked && (
                      <p className="flex items-center gap-1.5 text-[12.5px] text-amber">
                        <AlertTriangle className="size-3.5 shrink-0" />
                        {d.rides_assigned > 1
                          ? `${d.rides_assigned} courses attribuées\u00a0: le client doit d'abord les terminer ou les réattribuer.`
                          : "Une course attribuée\u00a0: le client doit d'abord la terminer ou la réattribuer."}
                      </p>
                    )}
                    {d.keep_auth && (
                      <p className="text-[12.5px] text-fg-muted">
                        Ce compte sert aussi à gérer un client (ou la plateforme){"\u00a0"}: seul le profil chauffeur sera supprimé.
                      </p>
                    )}
                    {!d.has_account && <p className="text-[12.5px] text-fg-muted">Fiche sans compte de connexion (créée par le client).</p>}
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={blocked}
                    onClick={() => {
                      setConfirm("");
                      setTarget(d);
                    }}
                  >
                    <Trash2 /> Supprimer le compte
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog open={!!target} onOpenChange={(open) => !open && !deleting && setTarget(null)}>
        {target && (
          <DialogContent
            size="sm"
            title={`Supprimer le compte de ${target.first_name} ${target.last_name} (#${target.number})\u00a0?`}
            description={`Chauffeur de ${target.organization.name}. Suppression définitive, à la demande du chauffeur.`}
          >
            <div className="space-y-4 text-[13px] text-fg-muted">
              <ul className="list-disc space-y-1 pl-5 marker:text-fg-subtle">
                <li>
                  Supprimés{"\u00a0"}: coordonnées, justificatifs et leurs fichiers, positions, appareils, messages et signalements,
                  {target.keep_auth ? " profil chauffeur (compte de gestion conservé)." : " compte de connexion."}
                </li>
                <li>
                  Conservés sans nom (obligations comptables du client){"\u00a0"}: courses, règlements, gains, frais — fiche
                  «{"\u00a0"}Chauffeur supprimé (#{target.number}){"\u00a0"}».
                </li>
                {target.banned && <li>Banni{"\u00a0"}: les empreintes de ses identifiants et le motif restent (réinscription impossible).</li>}
              </ul>
              <form onSubmit={submitWith(() => remove())} className="space-y-3">
                <Field label="Tapez SUPPRIMER pour confirmer" htmlFor="deletion-confirm">
                  <Input
                    id="deletion-confirm"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                  />
                </Field>
                <DialogFooter backDisabled={deleting} className="mt-4">
                  <Button type="submit" variant="danger" loading={deleting} disabled={confirm.trim().toUpperCase() !== "SUPPRIMER"}>
                    <Trash2 /> Supprimer définitivement
                  </Button>
                </DialogFooter>
              </form>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </Card>
  );
}

// -----------------------------------------------------------------------------
// File des suppressions
// -----------------------------------------------------------------------------
const SOURCE_LABEL: Record<DeletionItem["source"], string> = {
  app: "Depuis l'application",
  admin: "Demande par e-mail",
  repair: "Reprise (ancienne suppression)",
};

const QUEUE_STATUS: Record<DeletionItem["status"], { label: string; tone: "green" | "amber" | "red" }> = {
  done: { label: "Terminée", tone: "green" },
  pending: { label: "En cours", tone: "amber" },
  failed: { label: "Échec", tone: "red" },
};

function authStep(item: DeletionItem) {
  if (item.keep_auth) return "conservé (compte de gestion)";
  return item.auth_done ? "supprimé" : "à supprimer";
}

export function DeletionQueueList({ queue }: { queue: DeletionQueue }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [running, setRunning] = useState<string | null>(null);

  const retry = (item: DeletionItem) =>
    start(() => runAction(async () => {
      setRunning(item.deletion_id);
      const res = await retryDriverDeletion(item.deletion_id);
      setRunning(null);
      if (!res.ok) return void toast.error(res.error);
      if (res.pending) toast.warning(res.message);
      else toast.success(res.message);
      router.refresh();
    }));

  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon={<Trash2 />}
        title="File de suppression"
        description={`Fichiers et comptes de connexion, supprimés aussitôt puis repris par le serveur en cas d'échec (10 essais). ${queue.pending} en cours${
          queue.stalled ? ` (dont ${queue.stalled} en retard)` : ""
        } · ${queue.failed} en échec.`}
      />
      {queue.items.length === 0 ? (
        <EmptyState size="compact" icon={<CheckCircle2 />} title="Aucune suppression récente." description="Les suppressions de compte des 90 derniers jours apparaissent ici." />
      ) : (
        <ul className="divide-y divide-line">
          {queue.items.map((item) => {
            const meta = QUEUE_STATUS[item.status];
            return (
              <li key={item.deletion_id} className={cn("flex flex-col gap-3 px-5 py-3.5 lg:flex-row lg:items-center", item.status === "failed" && "bg-red/[0.03]")}>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    <p className="text-[13.5px] font-semibold">
                      Chauffeur supprimé <span className="num">#{item.number}</span>
                    </p>
                    <span className="text-[12.5px] text-fg-muted">{item.organization?.name ?? "Client supprimé"}</span>
                  </div>
                  <p className="text-[12.5px] text-fg-muted">
                    {SOURCE_LABEL[item.source]} · demandée{" "}
                    <span title={formatDate(item.requested_at)} suppressHydrationWarning>
                      {formatRelative(item.requested_at)}
                    </span>
                    {" · "}justificatifs{"\u00a0"}: {item.storage_done ? "supprimés" : "à supprimer"} · compte de connexion{"\u00a0"}: {authStep(item)}
                  </p>
                  {!item.done && (
                    <p className="text-[12px] text-fg-muted">
                      {plural(item.attempts, "essai")}
                      {item.status === "pending" &&
                        (item.stalled ? (
                          <>
                            {" · "}
                            <span className="text-amber">en retard{"\u00a0"}: le serveur ne reprend pas la file</span>
                          </>
                        ) : (
                          <>
                            {" · "}prochain essai{" "}
                            <span suppressHydrationWarning>{formatRelative(item.next_attempt_at)}</span>
                          </>
                        ))}
                    </p>
                  )}
                  {!item.done && item.last_error && (
                    <Disclosure title="Message technique du dernier essai" summaryClassName="text-[12px] font-normal text-fg-muted hover:text-fg" contentClassName="pb-1">
                      <p className="mono text-[12px] text-fg-muted [overflow-wrap:anywhere]">{item.last_error}</p>
                    </Disclosure>
                  )}
                </div>
                {!item.done && (
                  <Button variant="secondary" size="sm" loading={busy && running === item.deletion_id} disabled={busy} onClick={() => retry(item)}>
                    <RotateCw /> Réessayer
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
