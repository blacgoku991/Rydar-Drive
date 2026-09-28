import { CONTACT_STATUS_META, CONTACT_TOPIC_META, EMAIL_KIND_META, formatDate, formatTime, type ContactTopic } from "@rydar/shared";
import { Inbox, MailCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { TestEmailForm } from "@/components/admin/contact-tools";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireSuperAdmin } from "@/lib/auth";
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
type FailedEmail = { id: number; kind: keyof typeof EMAIL_KIND_META; created_at: string; last_error: string | null; contact_request_id: string | null };

const dateTime = (d: string | null | undefined) => (d ? `${formatDate(d)} à ${formatTime(d)}` : "—");

export default async function AdminContactsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSuperAdmin();
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f.key === sp.filtre) ?? FILTERS[0]!;
  const db = session.supabase;

  let list = db.from("contact_requests").select("id, created_at, topic, name, company, email, status").order("created_at", { ascending: false }).limit(200);
  if (filter.statuses) list = list.in("status", filter.statuses);
  const count = (statuses: Status[]) => db.from("contact_requests").select("id", { count: "exact", head: true }).in("status", statuses);
  const [rows, todo, done, spam, all, pending, failed, lastSent, recentFailed] = await Promise.all([
    list,
    count(["new", "in_progress"]),
    count(["done"]),
    count(["spam"]),
    db.from("contact_requests").select("id", { count: "exact", head: true }),
    db.from("email_outbox").select("id", { count: "exact", head: true }).in("status", ["pending", "sending"]),
    db.from("email_outbox").select("id", { count: "exact", head: true }).eq("status", "failed"),
    db.from("email_outbox").select("sent_at").eq("status", "sent").order("sent_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("email_outbox").select("id, kind, created_at, last_error, contact_request_id").eq("status", "failed").order("created_at", { ascending: false }).limit(5),
  ]);
  const counts: Record<string, number> = {
    "a-traiter": todo.count ?? 0,
    traitees: done.count ?? 0,
    indesirables: spam.count ?? 0,
    toutes: all.count ?? 0,
  };
  const requests = (rows.data ?? []) as Row[];
  const failures = (recentFailed.data ?? []) as FailedEmail[];
  const failedCount = failed.count ?? 0;
  const lastSentAt = (lastSent.data as { sent_at: string | null } | null)?.sent_at ?? null;

  return (
    <>
      <PageHeader
        eyebrow="Plateforme"
        title="Demandes de contact"
        description="Reçues par le formulaire /contact du site (tarifs, questions, partenariats). Les e-mails partent par le serveur mail du VPS."
      />
      <PageBody>
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
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
            <CardHeader icon={<MailCheck />} title="Envoi des e-mails" description="Serveur mail du VPS (SMTP localhost:25), via le service mailer." />
            <CardBody className="space-y-5">
              <dl className="grid grid-cols-2 gap-3 text-[13px]">
                <div className="col-span-2">
                  <dt className="text-fg-muted">Dernier envoi réussi</dt>
                  <dd className="num mt-0.5 text-fg">{lastSentAt ? dateTime(lastSentAt) : "Aucun pour l'instant"}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">En attente</dt>
                  <dd className="num mt-0.5 text-fg">{pending.count ?? 0}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">En échec</dt>
                  <dd className={cn("num mt-0.5", failedCount > 0 ? "text-red" : "text-fg")}>{failedCount}</dd>
                </div>
              </dl>
              {failures.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[12.5px] font-medium text-fg">Derniers échecs</p>
                  <ul className="space-y-2">
                    {failures.map((f) => (
                      <li key={f.id} className="rounded-lg border border-red/20 bg-red/[0.05] px-3 py-2 text-[12.5px]">
                        <p className="text-fg">
                          {EMAIL_KIND_META[f.kind]?.label ?? f.kind} · <span className="num">{dateTime(f.created_at)}</span>
                        </p>
                        {f.last_error && <p className="mt-0.5 break-words text-fg-muted">{f.last_error}</p>}
                        {f.contact_request_id && (
                          <Link href={`/admin/contacts/${f.contact_request_id}`} className="mt-1 inline-block text-brand hover:underline">
                            Voir la demande
                          </Link>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="text-[12px] leading-relaxed text-fg-muted">
                    Serveur mail du VPS injoignable ou refus : voir « docker compose logs mailer » et /var/log/mail.log (docs/DEPLOYMENT.md).
                  </p>
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
