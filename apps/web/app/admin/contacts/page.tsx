import {
  CONTACT_STATUS_META,
  CONTACT_TOPIC_META,
  EMAIL_KIND_META,
  EMAIL_STATUS_META,
  formatDate,
  formatRelative,
  formatTime,
  type ContactTopic,
} from "@rydar/shared";
import { AlertTriangle, Inbox, MailCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { MailQueueRefresh, RequeueEmailsButton, RetryEmailButton, TestEmailForm } from "@/components/admin/contact-tools";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireSuperAdmin } from "@/lib/auth";
import { emailProgress } from "@/lib/email-status";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Demandes de contact" };
export const dynamic = "force-dynamic";

type Status = keyof typeof CONTACT_STATUS_META;
const FILTERS: { key: string; label: string; statuses: Status[] | null }[] = [
  { key: "a-traiter", label: "À traiter", statuses: ["new", "in_progress"] },
  { key: "traitees", label: "Traitées", statuses: ["done"] },
  { key: "indesirables", label: "Indésirables", statuses: ["spam"] },
  { key: "toutes", label: "Toutes", statuses: null },
];

type Row = {
  id: string;
  created_at: string;
  topic: ContactTopic;
  name: string;
  company: string | null;
  email: string;
  status: Status;
};
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
const code = "num rounded bg-white/[0.05] px-1 py-px text-[11.5px] text-fg";

export default async function AdminContactsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSuperAdmin();
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f.key === sp.filtre) ?? FILTERS[0]!;
  const db = session.supabase;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  let list = db.from("contact_requests").select("id, created_at, topic, name, company, email, status").order("created_at", { ascending: false }).limit(200);
  if (filter.statuses) list = list.in("status", filter.statuses);
  const count = (statuses: Status[]) => db.from("contact_requests").select("id", { count: "exact", head: true }).in("status", statuses);
  const [rows, todo, done, spam, all, pending, failed, lastSent, recent, failures, waitingLater, mailerRes] = await Promise.all([
    list,
    count(["new", "in_progress"]),
    count(["done"]),
    count(["spam"]),
    db.from("contact_requests").select("id", { count: "exact", head: true }),
    db.from("email_outbox").select("id", { count: "exact", head: true }).in("status", ["pending", "sending"]),
    db.from("email_outbox").select("id", { count: "exact", head: true }).eq("status", "failed"),
    db.from("email_outbox").select("sent_at").eq("status", "sent").order("sent_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("email_outbox").select(EMAIL_COLUMNS).order("id", { ascending: false }).limit(RECENT),
    db.from("email_outbox").select(EMAIL_COLUMNS).eq("status", "failed").order("id", { ascending: false }).limit(RECENT + 5),
    db.from("email_outbox").select("id", { count: "exact", head: true }).eq("status", "pending").gt("next_attempt_at", nowIso),
    db.from("mailer_status").select("seen_at, smtp_host, smtp_port, smtp_ready, smtp_error").maybeSingle(),
  ]);
  const counts: Record<string, number> = {
    "a-traiter": todo.count ?? 0,
    traitees: done.count ?? 0,
    indesirables: spam.count ?? 0,
    toutes: all.count ?? 0,
  };
  const requests = (rows.data ?? []) as Row[];
  const recentEmails = (recent.data ?? []) as Email[];
  const shown = new Set(recentEmails.map((e) => e.id));
  // Échecs plus anciens que les derniers e-mails : toujours listés, pour un nouvel essai
  const olderFailures = ((failures.data ?? []) as Email[]).filter((e) => !shown.has(e.id)).slice(0, 5);
  const pendingCount = pending.count ?? 0;
  const failedCount = failed.count ?? 0;
  const lastSentAt = (lastSent.data as { sent_at: string | null } | null)?.sent_at ?? null;

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
        eyebrow="Plateforme"
        title="Demandes de contact"
        description="Reçues par le formulaire /contact du site (tarifs, questions, partenariats). Les e-mails partent par le serveur mail du VPS."
      />
      <MailQueueRefresh active={pendingCount > 0 || service !== "up" || smtp !== "ready"} />
      <PageBody>
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <nav aria-label="Filtrer les demandes" className="flex flex-wrap gap-2">
              {FILTERS.map((f) => {
                const active = f.key === filter.key;
                return (
                  <Link
                    key={f.key}
                    href={f.key === FILTERS[0]!.key ? "/admin/contacts" : `/admin/contacts?filtre=${f.key}`}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-[13px] transition-colors",
                      active ? "border-brand/40 bg-brand/[0.08] text-fg" : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
                    )}
                  >
                    {f.label}
                    <span className="num text-[12px] text-fg-muted">{counts[f.key] ?? 0}</span>
                  </Link>
                );
              })}
            </nav>

            <Card>
              {rows.error ? (
                <CardBody className="text-[13px] text-red">Lecture des demandes impossible pour le moment.</CardBody>
              ) : requests.length === 0 ? (
                <CardBody className="flex flex-col items-center gap-3 py-14 text-center">
                  <Inbox className="size-8 text-fg-subtle" aria-hidden />
                  <p className="text-[14px] font-medium">Aucune demande {filter.key === "toutes" ? "pour l'instant" : "dans cette liste"}.</p>
                  <p className="max-w-sm text-[13px] text-fg-muted">
                    Les demandes envoyées depuis la page Contact du site (dont « Demander un tarif ») arrivent ici.
                  </p>
                </CardBody>
              ) : (
                <ul className="divide-y divide-line">
                  {requests.map((r) => {
                    const st = CONTACT_STATUS_META[r.status];
                    return (
                      <li key={r.id}>
                        <Link
                          href={`/admin/contacts/${r.id}`}
                          className="flex flex-col gap-2 px-5 py-4 transition-colors hover:bg-white/[0.025] sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-[14px] font-medium text-fg">
                              {r.name}
                              {r.company && <span className="font-normal text-fg-muted"> · {r.company}</span>}
                            </p>
                            <p className="mt-0.5 truncate text-[12.5px] text-fg-muted">
                              {CONTACT_TOPIC_META[r.topic]?.label ?? r.topic} · {r.email}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-3">
                            <span className="num text-[12px] text-fg-muted">{dateTime(r.created_at)}</span>
                            <Badge tone={st?.tone ?? "neutral"}>{st?.label ?? r.status}</Badge>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
            {requests.length === 200 && <p className="text-[12.5px] text-fg-muted">Les 200 demandes les plus récentes sont affichées.</p>}
          </div>

          <Card>
            <CardHeader icon={<MailCheck />} title="Envoi des e-mails" description={`Service mailer du VPS, serveur mail ${server}.`} />
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
                  <dd className="num mt-0.5 break-all text-[12px] text-fg-muted">{server}</dd>
                </div>
              </dl>

              {service === "never" && (
                <Notice tone="amber" title="Service d'envoi jamais démarré">
                  Aucun signe de vie du service mailer : les e-mails restent en file. Sur le VPS :{" "}
                  <code className={code}>docker compose ps mailer</code>, puis la mise à jour (
                  <code className={code}>deploy/update-production.sh</code>).
                </Notice>
              )}
              {service === "down" && mailer && (
                <Notice tone="red" title="Service d'envoi arrêté">
                  Plus de signe de vie depuis le {dateTime(mailer.seen_at)} : conteneur arrêté, ou base injoignable pour lui. Les
                  e-mails restent en file. Sur le VPS : <code className={code}>docker compose ps mailer</code> et{" "}
                  <code className={code}>docker compose logs --tail 50 mailer</code>.
                </Notice>
              )}
              {smtp === "down" && mailer && (
                <Notice tone="red" title="Serveur mail injoignable">
                  {mailer.smtp_error && (
                    <span className="mb-1 block break-words text-fg">{mailer.smtp_error.replace(/^Serveur mail injoignable : /, "")}</span>
                  )}
                  {localServer ? (
                    <>
                      Aucun serveur mail ne répond sur ce VPS : installez ou redémarrez Postfix (
                      <code className={code}>deploy/CLAUDE-VPS.md</code>, étape 5).
                    </>
                  ) : (
                    <>
                      Relais SMTP : vérifiez <code className={code}>SMTP_HOST</code>, <code className={code}>SMTP_PORT</code>,{" "}
                      <code className={code}>SMTP_USER</code> et <code className={code}>SMTP_PASS</code> dans{" "}
                      <code className={code}>deploy/.env</code>.
                    </>
                  )}{" "}
                  Les e-mails attendent et partent dès qu&apos;il répond (vérification chaque minute), sans passer en échec.
                </Notice>
              )}

              <dl className="grid grid-cols-2 gap-3 text-[13px]">
                <div className="col-span-2">
                  <dt className="text-fg-muted">Dernier envoi réussi</dt>
                  <dd className="num mt-0.5 text-fg">{lastSentAt ? dateTime(lastSentAt) : "Aucun pour l'instant"}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">En attente</dt>
                  <dd className={cn("num mt-0.5", pendingCount > 0 ? "text-amber" : "text-fg")}>{pendingCount}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">En échec</dt>
                  <dd className={cn("num mt-0.5", failedCount > 0 ? "text-red" : "text-fg")}>{failedCount}</dd>
                </div>
              </dl>
              {/* Utile seulement si le serveur mail répond (sinon la file est en pause et repart seule à son retour) */}
              {smtp === "ready" && (waitingLater.count ?? 0) > 0 && <RequeueEmailsButton count={waitingLater.count ?? 0} />}

              <div className="space-y-2">
                <p className="text-[12.5px] font-medium text-fg">Derniers e-mails</p>
                {recentEmails.length === 0 ? (
                  <p className="text-[12.5px] text-fg-muted">Aucun e-mail pour l&apos;instant.</p>
                ) : (
                  <EmailList emails={recentEmails} now={now} paused={paused} />
                )}
                <p className="text-[12px] leading-relaxed text-fg-muted">
                  « Envoyé » : accepté par le serveur mail du VPS. Sa remise dans la boîte du destinataire se lit dans{" "}
                  <code className={code}>/var/log/mail.log</code> (pensez aussi aux indésirables).
                </p>
              </div>
              {olderFailures.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[12.5px] font-medium text-fg">Échecs plus anciens</p>
                  <EmailList emails={olderFailures} now={now} paused={paused} />
                </div>
              )}
              <TestEmailForm defaultTo={session.profile.email ?? ""} />
            </CardBody>
          </Card>
        </div>
      </PageBody>
    </>
  );
}

function Notice({ tone, title, children }: { tone: "red" | "amber"; title: string; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-lg border px-3.5 py-3 text-[12.5px] leading-relaxed text-fg-muted",
        tone === "red" ? "border-red/25 bg-red/[0.06]" : "border-amber/25 bg-amber/[0.06]",
      )}
    >
      <p className="mb-1 flex items-center gap-1.5 font-medium text-fg">
        <AlertTriangle className={cn("size-3.5 shrink-0", tone === "red" ? "text-red" : "text-amber")} aria-hidden />
        {title}
      </p>
      {children}
    </div>
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
                {EMAIL_KIND_META[e.kind]?.label ?? e.kind}
                <span className="block truncate text-[12px] text-fg-muted">{e.to_email}</span>
              </p>
              <Badge tone={st?.tone ?? "neutral"}>{st?.label ?? e.status}</Badge>
            </div>
            <p className="num text-[12px] text-fg-muted">
              {paused && e.status === "pending"
                ? `${e.attempts > 0 ? `${e.attempts} essai${e.attempts > 1 ? "s" : ""} · ` : ""}en pause : part dès que le serveur mail répond`
                : emailProgress(e, now)}
            </p>
            {e.last_error && e.status !== "sent" && <p className="break-words text-[12px] text-red">{e.last_error}</p>}
            {(e.status === "failed" || e.contact_request_id) && (
              <div className="flex flex-wrap items-center gap-3 pt-1">
                {e.status === "failed" && <RetryEmailButton emailId={e.id} contactRequestId={e.contact_request_id ?? undefined} />}
                {e.contact_request_id && (
                  <Link href={`/admin/contacts/${e.contact_request_id}`} className="text-[12px] text-brand hover:underline">
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
