import { EMAIL_KIND_META, EMAIL_STATUS_META, formatDate, formatNumber, formatRelative, formatTime } from "@rydar/shared";
import { History, MailCheck, Send } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { MailQueueRefresh, RequeueEmailsButton, RetryEmailButton, TestEmailForm } from "@/components/admin/contact-tools";
import { SupervisionTabs } from "@/components/admin/supervision-tabs";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { requireSuperAdmin } from "@/lib/auth";
import { emailProgress } from "@/lib/email-status";
import { cn } from "@/lib/utils";
import { emailErrorParts } from "@/lib/wording";

export const metadata: Metadata = { title: "E-mails" };
export const dynamic = "force-dynamic";

type Email = {
  id: number;
  created_at: string;
  kind: keyof typeof EMAIL_KIND_META;
  to_email: string;
  status: keyof typeof EMAIL_STATUS_META;
  attempts: number;
  sent_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  contact_request_id: string | null;
};
/** public.mailer_status (migration 20260924005800), écrite par le service mailer toutes les 30 s. */
type MailerStatus = {
  seen_at: string;
  smtp_host: string;
  smtp_port: number;
  smtp_ready: boolean | null;
  smtp_error: string | null;
};

const EMAIL_COLUMNS = "id, created_at, kind, to_email, status, attempts, sent_at, next_attempt_at, last_error, contact_request_id";
/** E-mails listés dans « Derniers e-mails ». */
const RECENT = 6;
/** Sans signe de vie depuis ce délai (écrit toutes les 30 s) : service arrêté ou base injoignable pour lui. */
const MAILER_STALE_MS = 3 * 60_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const dateTime = (d: string | null | undefined) => (d ? `${formatDate(d)} à ${formatTime(d)}` : "—");
const code = "num rounded bg-white/[0.05] px-1 py-px text-[12px] text-fg";

/**
 * Supervision › E-mails (docs/REFONTE-PANELS.md, R2) : diagnostic de l'envoi des e-mails de la plateforme (réponses aux
 * demandes de contact, invitations, décisions…), déplacé de « Demandes de contact ». État du service d'envoi et du
 * serveur mail en mots simples ; commandes et chemins du serveur dans « Détails techniques ». Page tenue à jour tant que
 * des e-mails attendent ou que l'envoi est en panne (MailQueueRefresh).
 */
export default async function AdminEmailsPage() {
  const session = await requireSuperAdmin();
  const db = session.supabase;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const [pending, failed, lastSent, recent, failures, waitingLater, mailerRes] = await Promise.all([
    db.from("email_outbox").select("id", { count: "exact", head: true }).in("status", ["pending", "sending"]),
    db.from("email_outbox").select("id", { count: "exact", head: true }).eq("status", "failed"),
    db.from("email_outbox").select("sent_at").eq("status", "sent").order("sent_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("email_outbox").select(EMAIL_COLUMNS).order("id", { ascending: false }).limit(RECENT),
    db.from("email_outbox").select(EMAIL_COLUMNS).eq("status", "failed").order("id", { ascending: false }).limit(RECENT + 5),
    db.from("email_outbox").select("id", { count: "exact", head: true }).eq("status", "pending").gt("next_attempt_at", nowIso),
    db.from("mailer_status").select("seen_at, smtp_host, smtp_port, smtp_ready, smtp_error").maybeSingle(),
  ]);
  const recentEmails = (recent.data ?? []) as Email[];
  const shown = new Set(recentEmails.map((e) => e.id));
  // Échecs plus anciens que les derniers e-mails : toujours listés, pour un nouvel essai
  const olderFailures = ((failures.data ?? []) as Email[]).filter((e) => !shown.has(e.id)).slice(0, 5);
  /** Nombre exact, ou null si la lecture a échoué (« — », jamais un faux 0). */
  const pendingCount = pending.error ? null : (pending.count ?? 0);
  const failedCount = failed.error ? null : (failed.count ?? 0);
  const lastSentAt = (lastSent.data as { sent_at: string | null } | null)?.sent_at ?? null;
  const listError = recent.error || failures.error;

  // État du service d'envoi et du serveur mail (signe de vie écrit par le mailer)
  const mailer = (mailerRes.data ?? null) as MailerStatus | null;
  const service: "never" | "down" | "up" = !mailer ? "never" : now - new Date(mailer.seen_at).getTime() > MAILER_STALE_MS ? "down" : "up";
  const smtp: "ready" | "down" | "unknown" = service !== "up" ? "unknown" : mailer?.smtp_ready === true ? "ready" : mailer?.smtp_ready === false ? "down" : "unknown";
  const server = mailer ? `${mailer.smtp_host}:${mailer.smtp_port}` : "127.0.0.1:25";
  const localServer = !mailer || LOOPBACK.has(mailer.smtp_host.toLowerCase());
  // File en pause (serveur mail injoignable) : les e-mails en attente partent à son retour, pas à leur échéance
  const paused = smtp === "down";

  return (
    <>
      <PageHeader
        title="E-mails"
        description={"Envoi des e-mails de la plateforme\u00a0: état du service, derniers envois, échecs et e-mail de test."}
      >
        <SupervisionTabs current="emails" />
      </PageHeader>
      <MailQueueRefresh active={(pendingCount ?? 0) > 0 || service !== "up" || smtp !== "ready"} />
      {/* Bureau : état et test à gauche, derniers e-mails à droite ; téléphone : état, derniers e-mails, test */}
      <PageBody className="grid gap-6 lg:grid-cols-2 lg:grid-rows-[auto_1fr] lg:items-start">
        <Card className="lg:col-start-1 lg:row-start-1">
          <CardHeader icon={<MailCheck />} title="État de l'envoi" description="Les e-mails partent par le serveur mail de Rydar, avec de nouveaux essais en cas d'échec." />
          <CardBody className="space-y-5">
            {/* Liste de définitions valide : chaque groupe (div) ne contient que dt et dd ; l'état est dans un dd */}
            <dl className="space-y-3 text-[13px]">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3">
                <dt className="text-fg">Service d&apos;envoi</dt>
                <dd className="col-start-2 row-span-2 row-start-1">
                  <Badge tone={service === "up" ? "green" : service === "down" ? "red" : "amber"} dot>
                    {service === "up" ? "Actif" : service === "down" ? "Arrêté" : "Jamais démarré"}
                  </Badge>
                </dd>
                <dd className="num mt-0.5 text-[12px] text-fg-muted">
                  {mailer ? `Signe de vie ${formatRelative(mailer.seen_at, new Date(now))}` : "Aucun signe de vie"}
                </dd>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3">
                <dt className="text-fg">Serveur mail</dt>
                <dd className="col-start-2 row-span-2 row-start-1">
                  <Badge tone={smtp === "ready" ? "green" : smtp === "down" ? "red" : "neutral"} dot>
                    {smtp === "ready" ? "Joignable" : smtp === "down" ? "Injoignable" : service === "up" ? "Vérification…" : "Inconnu"}
                  </Badge>
                </dd>
                <dd className="mt-0.5 text-[12px] text-fg-muted">
                  {smtp === "ready"
                    ? "Il accepte les e-mails."
                    : smtp === "down"
                      ? "Il ne répond pas."
                      : service === "up"
                        ? "Première vérification en cours."
                        : "Vérifié par le service d'envoi, à son démarrage."}
                </dd>
              </div>
            </dl>

            {service === "never" && (
              <Callout tone="warning" title="Le service d'envoi n'a jamais démarré">
                Les e-mails restent dans la file d&apos;attente. Transmettez les détails techniques ci-dessous à votre technicien.
              </Callout>
            )}
            {service === "down" && mailer && (
              <Callout tone="danger" title="Le service d'envoi est arrêté">
                Plus de signe de vie depuis le {dateTime(mailer.seen_at)}&nbsp;: les e-mails restent dans la file d&apos;attente. Transmettez
                les détails techniques ci-dessous à votre technicien.
              </Callout>
            )}
            {smtp === "down" && (
              <Callout tone="danger" title="Le serveur mail ne répond pas">
                Les e-mails attendent et partent dès qu&apos;il répond (vérification chaque minute), sans passer en échec.
              </Callout>
            )}

            <dl className="grid grid-cols-2 gap-3 text-[13px]">
              <div className="col-span-2">
                <dt className="text-fg-muted">Dernier envoi réussi</dt>
                <dd className="num mt-0.5 text-fg">{lastSent.error ? "—" : lastSentAt ? dateTime(lastSentAt) : "Aucun pour l'instant"}</dd>
              </div>
              <div>
                <dt className="text-fg-muted">En attente</dt>
                <dd className={cn("num mt-0.5", (pendingCount ?? 0) > 0 ? "text-amber" : "text-fg")}>{pendingCount === null ? "—" : formatNumber(pendingCount)}</dd>
              </div>
              <div>
                <dt className="text-fg-muted">En échec</dt>
                <dd className={cn("num mt-0.5", (failedCount ?? 0) > 0 ? "text-red" : "text-fg")}>{failedCount === null ? "—" : formatNumber(failedCount)}</dd>
              </div>
            </dl>
            {/* Utile seulement si le serveur mail répond (sinon la file est en pause et repart seule à son retour) */}
            {smtp === "ready" && (waitingLater.count ?? 0) > 0 && <RequeueEmailsButton count={waitingLater.count ?? 0} />}

            <Disclosure title="Détails techniques (à transmettre à votre technicien)" className="border-t border-line pt-2" contentClassName="space-y-3 pb-1 pt-1 text-[12.5px] leading-relaxed text-fg-muted">
              <p>
                Service <code className={code}>mailer</code> du VPS (signe de vie toutes les 30&nbsp;s), serveur mail{" "}
                <code className={code}>{server}</code>.
              </p>
              {service === "never" && (
                <p>
                  Aucun signe de vie du service mailer. Sur le VPS&nbsp;: <code className={code}>docker compose ps mailer</code>, puis la
                  mise à jour (<code className={code}>deploy/update-production.sh</code>).
                </p>
              )}
              {service === "down" && (
                <p>
                  Conteneur arrêté, ou base injoignable pour lui. Sur le VPS&nbsp;: <code className={code}>docker compose ps mailer</code> et{" "}
                  <code className={code}>docker compose logs --tail 50 mailer</code>.
                </p>
              )}
              {smtp === "down" && mailer && (
                <>
                  {mailer.smtp_error && <p className="break-words text-fg">{mailer.smtp_error.replace(/^Serveur mail injoignable : /, "")}</p>}
                  {localServer ? (
                    <p>
                      Aucun serveur mail ne répond sur ce VPS&nbsp;: installez ou redémarrez Postfix (
                      <code className={code}>deploy/CLAUDE-VPS.md</code>, étape 5).
                    </p>
                  ) : (
                    <p>
                      Relais SMTP&nbsp;: vérifiez <code className={code}>SMTP_HOST</code>, <code className={code}>SMTP_PORT</code>,{" "}
                      <code className={code}>SMTP_USER</code> et <code className={code}>SMTP_PASS</code> dans <code className={code}>deploy/.env</code>.
                    </p>
                  )}
                </>
              )}
              <p>
                «&nbsp;Envoyé&nbsp;»&nbsp;: accepté par le serveur mail du VPS. Sa remise dans la boîte du destinataire se lit dans{" "}
                <code className={code}>/var/log/mail.log</code>.
              </p>
            </Disclosure>
          </CardBody>
        </Card>

        <Card className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <CardHeader
            icon={<History />}
            title="Derniers e-mails"
            description={"«\u00a0Envoyé\u00a0»\u00a0: accepté par le serveur mail. Un e-mail introuvable peut être dans les indésirables du destinataire."}
          />
          <CardBody className="space-y-5">
            {listError ? (
              <p className="text-[13px] text-fg-muted">Lecture impossible, réessayez dans un instant.</p>
            ) : recentEmails.length === 0 ? (
              <p className="text-[13px] text-fg-muted">Aucun e-mail pour l&apos;instant.</p>
            ) : (
              <EmailList emails={recentEmails} now={now} paused={paused} />
            )}
            {olderFailures.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-[13px] font-medium text-fg">Échecs plus anciens</h3>
                <EmailList emails={olderFailures} now={now} paused={paused} />
              </div>
            )}
          </CardBody>
        </Card>

        <Card className="lg:col-start-1 lg:row-start-2">
          <CardHeader icon={<Send />} title="E-mail de test" description={"Vérifie l'envoi de bout en bout\u00a0: il apparaît aussitôt dans «\u00a0Derniers e-mails\u00a0»."} />
          <CardBody>
            <TestEmailForm defaultTo={session.profile.email ?? ""} />
          </CardBody>
        </Card>
      </PageBody>
    </>
  );
}

function EmailList({ emails, now, paused }: { emails: Email[]; now: number; paused: boolean }) {
  return (
    <ul className="divide-y divide-line rounded-lg border border-line">
      {emails.map((e) => {
        const st = EMAIL_STATUS_META[e.status];
        return (
          <li key={e.id} className="space-y-1 px-3 py-2.5 text-[12.5px]">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 text-fg">
                {EMAIL_KIND_META[e.kind]?.label ?? "E-mail"}
                <span className="block truncate text-[12px] text-fg-muted" title={e.to_email}>
                  {e.to_email}
                </span>
              </p>
              <Badge tone={st?.tone ?? "neutral"}>{st?.label ?? "Statut inconnu"}</Badge>
            </div>
            <p className="num text-[12px] text-fg-muted">
              {paused && e.status === "pending"
                ? `${e.attempts > 0 ? `${e.attempts} essai${e.attempts > 1 ? "s" : ""} · ` : ""}en pause\u00a0: part dès que le serveur mail répond`
                : emailProgress(e, now)}
            </p>
            {e.status !== "sent" && <EmailError raw={e.last_error} />}
            {(e.status === "failed" || e.contact_request_id) && (
              <div className="flex flex-wrap items-center gap-3 pt-1">
                {e.status === "failed" && <RetryEmailButton emailId={e.id} contactRequestId={e.contact_request_id ?? undefined} />}
                {e.contact_request_id && (
                  <Link href={`/admin/contacts/${e.contact_request_id}`} prefetch={false} className="text-[12px] text-brand hover:underline">
                    Voir la demande
                  </Link>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Motif d'échec en français ; message brut du serveur mail replié (pour le technicien). */
function EmailError({ raw }: { raw: string | null }) {
  const parts = emailErrorParts(raw);
  if (!parts) return null;
  return (
    <div className="text-[12px]">
      <p className="text-fg [overflow-wrap:anywhere]">Motif{"\u00a0"}: {parts.reason}</p>
      {parts.detail && (
        <Disclosure title="Message du serveur mail" summaryClassName="text-[12px] font-normal text-fg-muted hover:text-fg" contentClassName="pb-1">
          <p className="mono text-[12px] text-fg-muted [overflow-wrap:anywhere]">{parts.detail}</p>
        </Disclosure>
      )}
    </div>
  );
}
