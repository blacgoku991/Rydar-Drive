import {
  CONTACT_STATUS_META,
  contactRequestTopicLabel,
  EMAIL_KIND_META,
  EMAIL_STATUS_META,
  FLEET_SIZE_META,
  formatDate,
  formatPhone,
  formatTime,
  type ContactRequestTopic,
} from "@rydar/shared";
import { Mail, MessageSquareText, Send, SlidersHorizontal, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ContactReplyForm, ContactStatusForm, DeleteContactButton, RetryEmailButton } from "@/components/admin/contact-tools";
import { CreatePrivateFleetSheet } from "@/components/admin/private-fleet";
import { apiAccessOf, effectiveLimits, prefillFromContact } from "@/components/admin/private-fleet-state";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Disclosure } from "@/components/ui/disclosure";
import { requireSuperAdmin } from "@/lib/auth";
import { emailProgress } from "@/lib/email-status";
import { env } from "@/lib/env";
import { emailErrorParts } from "@/lib/wording";

export const metadata: Metadata = { title: "Demande de contact" };
export const dynamic = "force-dynamic";

type Status = keyof typeof CONTACT_STATUS_META;
type Request = {
  id: string;
  created_at: string;
  topic: ContactRequestTopic;
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
  // Test d'éligibilité Flotte Privée : passerelle vers la création du client (formulaire prérempli, offres avec l'API)
  const eligibility = req.topic === "eligibility" && req.status !== "spam";
  const [plan, handler, plans] = await Promise.all([
    req.plan_code ? db.from("plans").select("name").eq("code", req.plan_code).maybeSingle() : Promise.resolve({ data: null }),
    req.handled_by ? db.from("users").select("full_name, email").eq("id", req.handled_by).maybeSingle() : Promise.resolve({ data: null }),
    eligibility ? db.from("plans").select("id, name, limits").eq("is_active", true).order("sort_order") : Promise.resolve({ data: null }),
  ]);
  const planOptions = ((plans.data ?? []) as { id: string; name: string; limits: Record<string, unknown> | null }[]).map((p) => ({
    id: p.id,
    name: p.name,
    api: apiAccessOf(effectiveLimits({ planId: p.id, planLimits: p.limits, override: null, privateFleet: false })),
  }));
  const planName = (plan.data as { name?: string } | null)?.name ?? req.plan_code;
  const handledBy = handler.data as { full_name?: string | null; email?: string } | null;
  const st = CONTACT_STATUS_META[req.status];

  const facts: [string, React.ReactNode][] = [
    ["Sujet", contactRequestTopicLabel(req.topic)],
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
        back={{ href: "/admin/contacts", label: "Demandes de contact" }}
        title={req.name}
        badges={<Badge tone={st?.tone ?? "neutral"}>{st?.label ?? "Statut inconnu"}</Badge>}
        meta={[req.company, contactRequestTopicLabel(req.topic)].filter(Boolean).join(" · ")}
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
                description={"Envoyé par le serveur mail de Rydar\u00a0; le demandeur vous répond à l'adresse qui reçoit les demandes."}
              />
              <CardBody>
                <ContactReplyForm
                  id={req.id}
                  to={req.email}
                  disabledReason={req.status === "spam" ? "Demande classée indésirable\u00a0: changez d'abord son statut." : undefined}
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
                      <li key={e.id} className="space-y-1.5 px-5 py-3.5 text-[13px]">
                        <div className="flex items-start justify-between gap-3">
                          <p className="min-w-0 text-fg [overflow-wrap:anywhere]">
                            {EMAIL_KIND_META[e.kind]?.label ?? "E-mail"} <span className="text-fg-muted">→ {e.to_email}</span>
                          </p>
                          <Badge tone={es?.tone ?? "neutral"}>{es?.label ?? "Statut inconnu"}</Badge>
                        </div>
                        <p className="num text-[12px] text-fg-muted">{emailProgress(e)}</p>
                        {e.status !== "sent" && <EmailError raw={e.last_error} />}
                        {e.status === "failed" && <RetryEmailButton emailId={e.id} contactRequestId={req.id} />}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>

          <div className="space-y-6">
            {eligibility && (
              <Card>
                <CardHeader icon={<Sparkles />} title="Flotte Privée" />
                <CardBody className="space-y-3">
                  <p className="text-[12.5px] leading-relaxed text-fg-muted">
                    Contrat signé{"\u00a0"}? Créez le client à partir de cette demande (nom, e-mail et téléphone repris){"\u00a0"}: elle passe ensuite
                    «{"\u00a0"}Traitée{"\u00a0"}», avec le nom du client dans la note.
                  </p>
                  <CreatePrivateFleetSheet
                    plans={planOptions}
                    rootDomain={env.rootDomain}
                    prefill={prefillFromContact(req)}
                    contactRequestId={req.id}
                    label="Créer le client Flotte Privée"
                  />
                </CardBody>
              </Card>
            )}
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
