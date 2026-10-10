import { CONTACT_STATUS_META, contactRequestTopicLabel, formatDate, formatNumber, formatTime, type ContactRequestTopic } from "@rydar/shared";
import { Inbox } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody } from "@/components/ui/card";
import { FilterTabs } from "@/components/ui/filter-tabs";
import { requireSuperAdmin } from "@/lib/auth";
import { plural } from "@/lib/wording";

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
  topic: ContactRequestTopic;
  name: string;
  company: string | null;
  email: string;
  status: Status;
};

/**
 * Même règle que Supervision › E-mails (/admin/emails) : sans signe de vie du service d'envoi depuis ce délai (écrit
 * toutes les 30 s), il est arrêté ou la base lui est injoignable.
 */
const MAILER_STALE_MS = 3 * 60_000;

const dateTime = (d: string | null | undefined) => (d ? `${formatDate(d)} à ${formatTime(d)}` : "—");

/**
 * Demandes de contact (boîte de réception du formulaire /contact du site). Le diagnostic de l'envoi des e-mails est
 * sur Supervision › E-mails (docs/REFONTE-PANELS.md, R2) : ici, seulement un encadré quand les réponses ne partent pas
 * (service arrêté, serveur mail injoignable ou e-mails en échec).
 */
export default async function AdminContactsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSuperAdmin();
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f.key === sp.filtre) ?? FILTERS[0]!;
  const db = session.supabase;
  const now = Date.now();

  let list = db.from("contact_requests").select("id, created_at, topic, name, company, email, status").order("created_at", { ascending: false }).limit(200);
  if (filter.statuses) list = list.in("status", filter.statuses);
  const count = (statuses: Status[]) => db.from("contact_requests").select("id", { count: "exact", head: true }).in("status", statuses);
  const [rows, todo, done, spam, all, failed, mailerRes] = await Promise.all([
    list,
    count(["new", "in_progress"]),
    count(["done"]),
    count(["spam"]),
    db.from("contact_requests").select("id", { count: "exact", head: true }),
    // État de l'envoi (mêmes lectures que Supervision › E-mails) : e-mails en échec, signe de vie du service d'envoi
    db.from("email_outbox").select("id", { count: "exact", head: true }).eq("status", "failed"),
    db.from("mailer_status").select("seen_at, smtp_ready").maybeSingle(),
  ]);
  /** Compteur exact, ou null si la lecture a échoué (rien d'affiché, jamais un faux 0). */
  const n = (r: { count: number | null; error: unknown }) => (r.error ? null : (r.count ?? 0));
  const counts: Record<string, number | null> = { "a-traiter": n(todo), traitees: n(done), indesirables: n(spam), toutes: n(all) };
  const requests = (rows.data ?? []) as Row[];

  // Les réponses partent-elles ? Service d'envoi arrêté ou jamais démarré, serveur mail injoignable, e-mails en échec
  const mailer = (mailerRes.data ?? null) as { seen_at: string; smtp_ready: boolean | null } | null;
  const serviceDown = !mailerRes.error && (!mailer || now - new Date(mailer.seen_at).getTime() > MAILER_STALE_MS);
  const smtpDown = !serviceDown && mailer?.smtp_ready === false;
  const failedCount = n(failed) ?? 0;
  const mailProblem = serviceDown
    ? "Le service d'envoi est arrêté\u00a0: vos réponses attendent dans la file d'envoi."
    : smtpDown
      ? "Le serveur mail ne répond pas\u00a0: vos réponses attendent et partiront dès son retour."
      : failedCount > 0
        ? `${plural(failedCount, "e-mail en échec", "e-mails en échec")}\u00a0: vous pouvez les renvoyer.`
        : null;

  return (
    <>
      <PageHeader title="Demandes de contact" description={"Reçues par le formulaire de contact du site : tarifs, questions, partenariats."} />
      <PageBody className="space-y-4">
        {mailProblem && (
          <Callout
            tone={serviceDown || smtpDown ? "danger" : "warning"}
            title="Les e-mails ne partent pas"
            action={
              <Link href="/admin/emails" prefetch={false} className="inline-flex min-h-11 items-center text-[13px] font-medium text-brand hover:underline sm:min-h-0">
                Voir Supervision › E-mails
              </Link>
            }
          >
            {mailProblem}
          </Callout>
        )}

        <FilterTabs
          label="Filtrer les demandes"
          items={FILTERS.map((f) => ({
            href: f.key === FILTERS[0]!.key ? "/admin/contacts" : `/admin/contacts?filtre=${f.key}`,
            label: f.label,
            active: f.key === filter.key,
            count: counts[f.key] ?? null,
            countLabel: counts[f.key] == null ? undefined : plural(counts[f.key]!, "demande", "demandes"),
          }))}
        />

        <Card>
          {rows.error ? (
            <CardBody className="text-[13px] text-fg-muted">Lecture impossible, réessayez dans un instant.</CardBody>
          ) : requests.length === 0 ? (
            <CardBody className="flex flex-col items-center gap-3 py-14 text-center">
              <Inbox className="size-8 text-fg-subtle" aria-hidden />
              <p className="text-[14px] font-medium">Aucune demande {filter.key === "toutes" ? "pour l'instant" : "dans cette liste"}.</p>
              <p className="max-w-sm text-[13px] text-fg-muted">
                Les demandes envoyées depuis la page Contact du site (dont «&nbsp;Demander un tarif&nbsp;») arrivent ici.
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
                      prefetch={false}
                      className="flex flex-col gap-2 px-5 py-4 transition-colors hover:bg-white/[0.025] sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[14px] font-medium text-fg">
                          {r.name}
                          {r.company && <span className="font-normal text-fg-muted"> · {r.company}</span>}
                        </p>
                        <p className="mt-0.5 truncate text-[12.5px] text-fg-muted">
                          {contactRequestTopicLabel(r.topic)} · {r.email}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="num text-[12px] text-fg-muted">{dateTime(r.created_at)}</span>
                        <Badge tone={st?.tone ?? "neutral"}>{st?.label ?? "Statut inconnu"}</Badge>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        {requests.length === 200 && <p className="text-[12.5px] text-fg-muted">Les {formatNumber(200)} demandes les plus récentes sont affichées.</p>}
      </PageBody>
    </>
  );
}
