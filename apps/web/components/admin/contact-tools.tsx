"use client";
// Super admin : actions sur les demandes de contact (statut et note, réponse par e-mail, suppression, nouvel essai
// d'un e-mail en échec, relance des e-mails en attente, e-mail de test) et suivi de la file d'envoi. Actions serveur :
// app/admin/contacts/actions.ts.
import { CONTACT_LIMITS, CONTACT_STATUS_META, CONTACT_STATUSES, type ContactStatus } from "@rydar/shared";
import { RotateCw, Save, Send, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  deleteContactRequest,
  replyToContactRequest,
  requeueEmails,
  retryEmail,
  sendTestEmail,
  updateContactRequest,
} from "@/app/admin/contacts/actions";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { submitWith } from "@/lib/utils";

type Status = ContactStatus;

/** Statut et note interne (visible du seul super admin). */
export function ContactStatusForm({ id, status, note }: { id: string; status: Status; note: string }) {
  const router = useRouter();
  const uid = useId();
  const [pending, start] = useTransition();
  const [s, setS] = useState<Status>(status);
  const [n, setN] = useState(note);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = () =>
    start(() =>
      runAction(async () => {
        const res = await updateContactRequest(id, { status: s, note: n });
        if (!res.ok) {
          setErrors(res.fieldErrors ?? {});
          return void toast.error(res.error);
        }
        setErrors({});
        toast.success("Demande mise à jour");
        router.refresh();
      }),
    );
  return (
    <form onSubmit={submitWith(save)} className="space-y-4">
      <Field label="Statut" htmlFor={`${uid}-status`} error={errors.status}>
        <NativeSelect id={`${uid}-status`} value={s} onChange={(e) => setS(e.target.value as Status)}>
          {CONTACT_STATUSES.map((k) => (
            <option key={k} value={k}>
              {CONTACT_STATUS_META[k].label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Note interne" htmlFor={`${uid}-note`} optional error={errors.note} hint="Jamais envoyée au demandeur.">
        <Textarea id={`${uid}-note`} value={n} onChange={(e) => setN(e.target.value)} maxLength={CONTACT_LIMITS.adminNote} rows={4} />
      </Field>
      <Button type="submit" variant="primary" loading={pending} className="w-full">
        <Save aria-hidden /> Enregistrer
      </Button>
    </form>
  );
}

/** Réponse envoyée par e-mail au demandeur. */
export function ContactReplyForm({ id, to, disabledReason }: { id: string; to: string; disabledReason?: string }) {
  const router = useRouter();
  const uid = useId();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | undefined>();
  const send = () =>
    start(() =>
      runAction(async () => {
        const res = await replyToContactRequest(id, message);
        if (!res.ok) {
          setError(res.fieldErrors?.message);
          return void toast.error(res.error);
        }
        setMessage("");
        setError(undefined);
        toast.success(`Réponse mise en file d'envoi pour ${to}`);
        router.refresh();
      }),
    );
  return (
    <form onSubmit={submitWith(send)} className="space-y-3">
      <Field label={`Votre réponse à ${to}`} htmlFor={`${uid}-reply`} error={error} hint={disabledReason}>
        <Textarea
          id={`${uid}-reply`}
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            setError(undefined);
          }}
          maxLength={CONTACT_LIMITS.reply}
          rows={6}
          disabled={!!disabledReason}
          aria-invalid={!!error}
          placeholder="Bonjour, merci pour votre demande…"
        />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={pending} disabled={!!disabledReason || message.trim().length < 2}>
          <Send aria-hidden /> Envoyer la réponse
        </Button>
      </div>
    </form>
  );
}

/** Suppression définitive, en deux temps (le second appui confirme, dans les 6 secondes). */
export function DeleteContactButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(t);
  }, [armed]);
  const remove = () =>
    start(() =>
      runAction(async () => {
        const res = await deleteContactRequest(id);
        if (!res.ok) return void toast.error(res.error);
        toast.success("Demande supprimée");
        router.push("/admin/contacts");
      }),
    );
  return (
    <Button
      type="button"
      variant={armed ? "danger" : "ghost"}
      loading={pending}
      className="w-full"
      onClick={() => (armed ? remove() : setArmed(true))}
    >
      <Trash2 aria-hidden /> {armed ? "Confirmer la suppression" : "Supprimer la demande"}
    </Button>
  );
}

/** Nouvel essai d'un e-mail en échec définitif. */
export function RetryEmailButton({ emailId, contactRequestId }: { emailId: number; contactRequestId?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const retry = () =>
    start(() =>
      runAction(async () => {
        const res = await retryEmail(emailId, contactRequestId);
        if (!res.ok) return void toast.error(res.error);
        toast.success("E-mail remis en file d'envoi");
        router.refresh();
      }),
    );
  return (
    <Button type="button" variant="outline" size="sm" loading={pending} onClick={retry}>
      <RotateCw aria-hidden /> Réessayer
    </Button>
  );
}

/** E-mails en attente d'un nouvel essai : relancés maintenant (après une correction du serveur mail, par exemple). */
export function RequeueEmailsButton({ count }: { count: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const requeue = () =>
    start(() =>
      runAction(async () => {
        const res = await requeueEmails();
        if (!res.ok) return void toast.error(res.error);
        toast.success(res.count > 1 ? `${res.count} e-mails relancés` : "E-mail relancé", {
          description: "Envoi dans les secondes qui viennent, si le serveur mail répond.",
        });
        router.refresh();
      }),
    );
  return (
    <Button type="button" variant="outline" size="sm" loading={pending} onClick={requeue} className="w-full">
      <RotateCw aria-hidden /> Relancer maintenant <span className="num">({count})</span>
    </Button>
  );
}

/** Page tenue à jour toutes les 10 s (onglet visible) tant que des e-mails attendent ou que l'envoi est en panne. */
export function MailQueueRefresh({ active, everyMs = 10_000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => window.clearInterval(id);
  }, [active, everyMs, router]);
  return null;
}

/** E-mail de test (vérifie le serveur mail du VPS de bout en bout). */
export function TestEmailForm({ defaultTo }: { defaultTo: string }) {
  const router = useRouter();
  const uid = useId();
  const [pending, start] = useTransition();
  const [to, setTo] = useState(defaultTo);
  const [error, setError] = useState<string | undefined>();
  const send = () =>
    start(() =>
      runAction(async () => {
        const res = await sendTestEmail(to);
        if (!res.ok) {
          setError(res.fieldErrors?.to);
          return void toast.error(res.error);
        }
        setError(undefined);
        toast.success("E-mail de test mis en file : suivez son état ci-dessus");
        router.refresh();
      }),
    );
  return (
    <form onSubmit={submitWith(send)} className="space-y-3">
      <Field label="Envoyer un e-mail de test à" htmlFor={`${uid}-to`} error={error}>
        <Input
          id={`${uid}-to`}
          type="email"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setError(undefined);
          }}
          maxLength={CONTACT_LIMITS.email}
          aria-invalid={!!error}
        />
      </Field>
      <Button type="submit" variant="outline" loading={pending} className="w-full">
        <Send aria-hidden /> Envoyer le test
      </Button>
    </form>
  );
}
