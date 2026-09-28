import {
  CONTACT_STATUS_META,
  CONTACT_TOPIC_META,
  EMAIL_KIND_META,
  EMAIL_STATUS_META,
  FLEET_SIZE_META,
  formatDate,
  formatPhone,
  formatTime,
  type ContactTopic,
} from "@rydar/shared";
import { ArrowLeft, Mail, MessageSquareText, Send, SlidersHorizontal } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ContactReplyForm, ContactStatusForm, DeleteContactButton, RetryEmailButton } from "@/components/admin/contact-tools";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireSuperAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Demande de contact" };
export const dynamic = "force-dynamic";

type Status = keyof typeof CONTACT_STATUS_META;
type Request = {
  id: string;
  created_at: string;
  topic: ContactTopic;
  plan_code: string | null;
  name: string;
  company: string | null;
  email: string;
  phone: string | null;
  fleet_size: keyof typeof FLEET_SIZE_META | null;
  message: string;
  status: Status;
  admin_note: string | null;
  handled_by: string | null;
  handled_at: string | null;
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
};

const dateTime = (d: string | null | undefined) => (d ? `${formatDate(d)} à ${formatTime(d)}` : "—");
const link = "text-brand underline-offset-4 hover:underline";

export default async function ContactRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSuperAdmin();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const db = session.supabase;
  const [{ data: reqData }, { data: emailData }] = await Promise.all([
    db
      .from("contact_requests")
      .select("id, created_at, topic, plan_code, name, company, email, phone, fleet_size, message, status, admin_note, handled_by, handled_at")
      .eq("id", id)
      .maybeSingle(),
    db
      .from("email_outbox")
      .select("id, created_at, kind, to_email, status, attempts, sent_at, next_attempt_at, last_error")
      .eq("contact_request_id", id)
      .order("created_at"),
  ]);
  const req = reqData as Request | null;
  if (!req) notFound();
  const emails = (emailData ?? []) as Email[];
  const [plan, handler] = await Promise.all([
    req.plan_code ? db.from("plans").select("name").eq("code", req.plan_code).maybeSingle() : Promise.resolve({ data: null }),
    req.handled_by ? db.from("users").select("full_name, email").eq("id", req.handled_by).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const planName = (plan.data as { name?: string } | null)?.name ?? req.plan_code;
  const handledBy = handler.data as { full_name?: string | null; email?: string } | null;
  const st = CONTACT_STATUS_META[req.status];

  const facts: [string, React.ReactNode][] = [
    ["Sujet", CONTACT_TOPIC_META[req.topic]?.label ?? req.topic],
    ...(planName ? ([["Offre visée", planName]] as [string, React.ReactNode][]) : []),
    ...(req.fleet_size ? ([["Taille de la flotte", FLEET_SIZE_META[req.fleet_size]?.label ?? req.fleet_size]] as [string, React.ReactNode][]) : []),
    [
      "E-mail",
      <a key="e" href={`mailto:${req.email}`} className={link}>
        {req.email}
      </a>,
    ],
    [
      "Téléphone",
      req.phone ? (
        <a key="p" href={`tel:${req.phone.replace(/[^\d+]/g, "")}`} className={link}>
          {formatPhone(req.phone)}
        </a>
      ) : (
        "—"
      ),
    ],
    ["Reçue le", dateTime(req.created_at)],
  ];

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/admin/contacts" className="inline-flex items-center gap-1.5 hover:text-fg">
            <ArrowLeft className="size-3.5" aria-hidden /> Demandes de contact
          </Link>
        }
        title={req.name}
        description={[req.company, CONTACT_TOPIC_META[req.topic]?.label].filter(Boolean).join(" · ")}
        actions={<Badge tone={st?.tone ?? "neutral"}>{st?.label ?? req.status}</Badge>}
      />
      <PageBody>
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-6">
            <Card>
              <CardHeader icon={<MessageSquareText />} title="Demande" />
              <CardBody className="space-y-5">
                <dl className="grid gap-x-6 gap-y-3 text-[13.5px] sm:grid-cols-2">
                  {facts.map(([label, value]) => (
                    <div key={label} className="min-w-0">
                      <dt className="text-fg-muted">{label}</dt>
                      <dd className="mt-0.5 break-words text-fg">{value}</dd>
                    </div>
                  ))}
                </dl>
                <div>
                  <p className="text-[12.5px] font-medium text-fg-muted">Message</p>
                  <p className="mt-1.5 whitespace-pre-wrap break-words rounded-lg border border-line bg-white/[0.02] p-4 text-[14px] leading-relaxed text-fg">
                    {req.message}
                  </p>
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                icon={<Send />}
                title="Répondre par e-mail"
                description="Envoyé par le serveur mail du VPS ; le demandeur vous répond à l'adresse qui reçoit les demandes."
              />
              <CardBody>
                <ContactReplyForm
                  id={req.id}
                  to={req.email}
                  disabledReason={req.status === "spam" ? "Demande classée indésirable : changez d'abord son statut." : undefined}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader icon={<Mail />} title="E-mails" description="Notification, accusé de réception et réponses liés à cette demande." />
              {emails.length === 0 ? (
                <CardBody className="text-[13px] text-fg-muted">Aucun e-mail pour cette demande.</CardBody>
              ) : (
                <ul className="divide-y divide-line">
                  {emails.map((e) => {
                    const es = EMAIL_STATUS_META[e.status];
                    return (
                      <li key={e.id} className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 text-[13px]">
                          <p className="text-fg">
                            {EMAIL_KIND_META[e.kind]?.label ?? e.kind} <span className="text-fg-muted">→ {e.to_email}</span>
                          </p>
                          <p className="num mt-0.5 text-[12px] text-fg-muted">
                            {e.status === "sent"
                              ? `Envoyé le ${dateTime(e.sent_at)}`
                              : e.status === "failed"
                                ? `Échec après ${e.attempts} essai${e.attempts > 1 ? "s" : ""}`
                                : e.attempts > 0
                                  ? `${e.attempts} essai${e.attempts > 1 ? "s" : ""} · prochain le ${dateTime(e.next_attempt_at)}`
                                  : `Créé le ${dateTime(e.created_at)}`}
                          </p>
                          {e.last_error && e.status !== "sent" && <p className="mt-1 break-words text-[12px] text-red">{e.last_error}</p>}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge tone={es?.tone ?? "neutral"}>{es?.label ?? e.status}</Badge>
                          {e.status === "failed" && <RetryEmailButton emailId={e.id} contactRequestId={req.id} />}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader icon={<SlidersHorizontal />} title="Suivi" />
              <CardBody className="space-y-4">
                <ContactStatusForm id={req.id} status={req.status} note={req.admin_note ?? ""} />
                {req.handled_at && (req.status === "done" || req.status === "spam") && (
                  <p className="text-[12.5px] text-fg-muted">
                    {req.status === "done" ? "Traitée" : "Classée indésirable"} le {dateTime(req.handled_at)}
                    {handledBy ? ` par ${handledBy.full_name || handledBy.email}` : ""}.
                  </p>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardBody className="space-y-2">
                <DeleteContactButton id={req.id} />
                <p className="text-[12px] leading-relaxed text-fg-muted">
                  Suppression définitive de la demande et de ses e-mails (demande d&apos;effacement, par exemple). Sinon, elle
                  est supprimée automatiquement 3 ans après sa réception (30 jours si elle est indésirable).
                </p>
              </CardBody>
            </Card>
          </div>
        </div>
      </PageBody>
    </>
  );
}
