"use client";
// Numéro WhatsApp Business (API Cloud de Meta) d'une centrale ou de Rydar : identifiant du numéro, jeton d'accès
// (jamais relu : champ vide = jeton conservé), modèle validé par Meta, activation, message test, état des envois.
// Refonte R10 (docs/REFONTE-PANELS.md § 5.6) : la configuration technique est repliée — « Relier un numéro WhatsApp
// Business (configuration technique) » tant qu'aucun numéro n'est relié, puis l'état, le message test et « Modifier la
// connexion » ; déconnecter demande une confirmation. Même carte côté centrale (Commission & encaissement) et côté
// super admin (Réglages de la plateforme).
import { dateTimeFormat } from "@rydar/shared";
import { Check, ChevronDown, Copy, MessageCircle, Send, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { Field, Input } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch-row";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";

const NB = " ";

export type WhatsAppRow = {
  phone_number_id: string;
  display_phone: string | null;
  verified_name: string | null;
  template: string;
  language: string;
  enabled: boolean;
  sent_count: number;
  last_sent_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
};

type ActionResult = { ok: true; message: string } | { ok: false; error: string; fieldErrors?: Record<string, string> };

type Props = {
  title: string;
  description: string;
  row: WhatsAppRow | null;
  defaultTemplate: string;
  /** Texte exact du modèle à créer chez Meta ({{1}}…) */
  templateText: string;
  variables: string;
  readOnly?: boolean;
  onSave: (input: { phoneNumberId: string; token: string; template: string; language: string; enabled: boolean }) => Promise<ActionResult>;
  onRemove: () => Promise<ActionResult>;
  onTest: (to: string) => Promise<ActionResult>;
  /** Ce qui se passe une fois le numéro déconnecté (confirmation), ex. « Les relances repasseront par l'application. » */
  disconnectConsequence?: string;
  children?: React.ReactNode;
};

/** « 10/10/2026 14:32 » (heure de Paris, formateur mémorisé). */
const when = (iso: string | null) =>
  iso ? dateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date(iso)) : "";

export function WhatsAppCard({
  title,
  description,
  row,
  defaultTemplate,
  templateText,
  variables,
  readOnly,
  onSave,
  onRemove,
  onTest,
  disconnectConsequence,
  children,
}: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [phoneNumberId, setPhoneNumberId] = useState(row?.phone_number_id ?? "");
  const [token, setToken] = useState("");
  const [template, setTemplate] = useState(row?.template ?? defaultTemplate);
  const [language, setLanguage] = useState(row?.language ?? "fr");
  const [enabled, setEnabled] = useState(row?.enabled ?? true);
  const [to, setTo] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const formId = useId();

  useEffect(() => {
    setPhoneNumberId(row?.phone_number_id ?? "");
    setTemplate(row?.template ?? defaultTemplate);
    setLanguage(row?.language ?? "fr");
    setEnabled(row?.enabled ?? true);
    setToken("");
  }, [row, defaultTemplate]);

  const lastFailed = !!row?.last_error_at && (!row.last_sent_at || row.last_error_at > row.last_sent_at);
  // Formulaire ouvert à la demande, et gardé ouvert tant qu'il porte une erreur
  const formErrors = Object.keys(errors).some((k) => k !== "to");
  const formOpen = !readOnly && (editing || formErrors);

  const save = () =>
    start(() =>
      runAction(async () => {
        setErrors({});
        const res = await onSave({ phoneNumberId: phoneNumberId.trim(), token: token.trim(), template: template.trim(), language: language.trim(), enabled });
        if (!res.ok) {
          setErrors(res.fieldErrors ?? {});
          toast.error(res.error);
          return;
        }
        toast.success(res.message);
        setToken("");
        setEditing(false);
        router.refresh();
      }),
    );

  const remove = () =>
    start(() =>
      runAction(async () => {
        const res = await onRemove();
        if (!res.ok) return void toast.error(res.error);
        toast.success(res.message);
        setConfirmRemove(false);
        setEditing(false);
        router.refresh();
      }),
    );

  const test = () =>
    start(() =>
      runAction(async () => {
        setErrors({});
        const res = await onTest(to);
        if (!res.ok) {
          setErrors(res.fieldErrors ?? {});
          toast.error(res.error);
        } else toast.success(res.message);
        router.refresh();
      }),
    );

  return (
    <Card>
      <CardHeader
        icon={<MessageCircle />}
        title={title}
        description={description}
        action={
          row ? (
            <Badge tone={!row.enabled ? "neutral" : lastFailed ? "red" : "green"}>{!row.enabled ? "Désactivé" : lastFailed ? "Erreur" : "Relié"}</Badge>
          ) : (
            <Badge tone="neutral">Non relié</Badge>
          )
        }
      />
      <CardBody className="space-y-5">
        {children}

        <section className="space-y-4 rounded-xl border border-line px-4 py-3.5" aria-label="Numéro WhatsApp Business">
          <div className="min-w-0 text-[13px]">
            <p className="font-medium text-fg">Numéro WhatsApp Business</p>
            {row ? (
              <>
                <p className="mt-0.5 text-fg [overflow-wrap:anywhere]">
                  {row.verified_name ?? "Numéro relié"}
                  {row.display_phone ? <span className="mono text-fg-muted"> · {row.display_phone}</span> : null}
                </p>
                <p className="mt-0.5 text-[12.5px] text-fg-muted" suppressHydrationWarning>
                  {row.sent_count > 0 ? `${row.sent_count} message${row.sent_count > 1 ? "s" : ""} envoyé${row.sent_count > 1 ? "s" : ""}` : "Aucun message envoyé"}
                  {row.last_sent_at ? ` · dernier le ${when(row.last_sent_at)}` : ""}
                </p>
                {lastFailed && (
                  <p className="mt-1 text-[12.5px] text-red [overflow-wrap:anywhere]" suppressHydrationWarning>
                    Dernière erreur ({when(row.last_error_at)}){NB}: {row.last_error}
                  </p>
                )}
              </>
            ) : (
              <p className="mt-0.5 text-[12.5px] text-fg-muted">Aucun numéro relié.</p>
            )}
          </div>

          {row && !readOnly && (
            <form onSubmit={submitWith(test)} className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Field label="Message test" className="flex-1" error={errors.to} hint={`Votre numéro${NB}: vous recevez le modèle avec des valeurs d'exemple.`}>
                <Input type="tel" inputMode="tel" autoComplete="tel" value={to} onChange={(e) => setTo(e.target.value)} placeholder={`ex.${NB}: 06 12 34 56 78`} aria-invalid={!!errors.to} />
              </Field>
              <Button type="submit" variant="outline" size="md" loading={pending} disabled={!to.trim()} className="max-sm:min-h-11 sm:mb-[22px]">
                <Send aria-hidden /> Envoyer le message test
              </Button>
            </form>
          )}

          {!readOnly && (
            <Button
              type="button"
              variant={row ? "ghost" : "outline"}
              size="sm"
              aria-expanded={formOpen}
              aria-controls={formId}
              onClick={() => setEditing((v) => !v)}
              className="h-auto min-h-9 max-w-full whitespace-normal py-1.5 text-left max-sm:min-h-11"
            >
              {row ? "Modifier la connexion" : "Relier un numéro WhatsApp Business (configuration technique)"}
              <ChevronDown aria-hidden className={cn("transition-transform", formOpen && "rotate-180")} />
            </Button>
          )}

          {formOpen && (
            <div id={formId} className="space-y-4 border-t border-line pt-4">
              <form onSubmit={submitWith(save)} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Identifiant du numéro (Phone Number ID)" error={errors.phoneNumberId}>
                    <Input
                      value={phoneNumberId}
                      inputMode="numeric"
                      autoComplete="off"
                      onChange={(e) => setPhoneNumberId(e.target.value.replace(/\D/g, ""))}
                      placeholder={`ex.${NB}: 106540352242922`}
                      className="mono"
                      aria-invalid={!!errors.phoneNumberId}
                    />
                  </Field>
                  <Field
                    label="Jeton d'accès permanent"
                    error={errors.token}
                    hint={row ? "Laissez vide pour garder le jeton enregistré." : "Utilisateur système Meta, droit whatsapp_business_messaging."}
                  >
                    <Input
                      type="password"
                      autoComplete="off"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder={row ? "•••••••• enregistré" : "EAAG…"}
                      className="mono"
                      aria-invalid={!!errors.token}
                    />
                  </Field>
                  <Field label="Nom du modèle" error={errors.template} hint={`Modèle «${NB}Utilité${NB}» approuvé par Meta, ${variables}.`}>
                    <Input value={template} onChange={(e) => setTemplate(e.target.value.toLowerCase())} className="mono" aria-invalid={!!errors.template} spellCheck={false} />
                  </Field>
                  <Field label="Langue du modèle" error={errors.language}>
                    <Input value={language} onChange={(e) => setLanguage(e.target.value)} className="mono" aria-invalid={!!errors.language} spellCheck={false} />
                  </Field>
                </div>
                <SwitchRow
                  title="Envois actifs"
                  hintOn="Les messages partent par WhatsApp."
                  hintOff="Désactivé : les relances partent par l'application."
                  checked={enabled}
                  onCheckedChange={setEnabled}
                />
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
                  {row && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRemove(true)} disabled={pending} className="text-red hover:text-red max-sm:min-h-11">
                      <Unplug aria-hidden /> Déconnecter le numéro
                    </Button>
                  )}
                  <Button type="submit" variant="primary" size="sm" loading={pending} className="max-sm:min-h-11">
                    <Check aria-hidden /> {row ? "Enregistrer" : "Vérifier et relier"}
                  </Button>
                </div>
              </form>

              <Disclosure title="Comment obtenir ces informations" defaultOpen={!row} className="rounded-xl bg-white/[0.03] px-4" contentClassName="space-y-3 pb-4">
                <ol className="list-decimal space-y-1.5 pl-4 text-[12.5px] leading-[19px] text-fg-muted">
                  <li>
                    Créez un compte WhatsApp Business sur <span className="text-fg">business.facebook.com</span> (Meta Business Suite) et ajoutez votre numéro dans
                    l&apos;application «{NB}WhatsApp{NB}» de <span className="text-fg">developers.facebook.com</span> (API Cloud). Un numéro déjà utilisé dans
                    l&apos;app WhatsApp doit d&apos;abord en être retiré.
                  </li>
                  <li>
                    Copiez l&apos;<span className="text-fg">identifiant du numéro</span> (WhatsApp › Configuration de l&apos;API, «{NB}Phone number ID{NB}»).
                  </li>
                  <li>
                    Créez un <span className="text-fg">utilisateur système</span> (Paramètres de l&apos;entreprise › Utilisateurs système), donnez-lui accès à
                    l&apos;application et au compte WhatsApp, puis générez un jeton permanent avec les droits <span className="mono">whatsapp_business_messaging</span>{" "}
                    et <span className="mono">whatsapp_business_management</span>.
                  </li>
                  <li>
                    Créez le modèle <span className="mono text-fg">{defaultTemplate}</span> (catégorie Utilité, langue Français) avec exactement ce texte, puis attendez
                    son approbation{NB}:
                  </li>
                </ol>
                <div className="flex items-start gap-2 rounded-lg border border-line bg-ink-800/60 px-3 py-2.5 text-[12.5px]">
                  <p className="flex-1 text-fg [overflow-wrap:anywhere]">{templateText}</p>
                  <button
                    type="button"
                    aria-label="Copier le texte du modèle"
                    className="grid size-8 shrink-0 place-items-center rounded-md text-fg-subtle hover:bg-white/[0.06] hover:text-fg"
                    onClick={() => navigator.clipboard?.writeText(templateText).then(() => toast.success("Texte du modèle copié"), () => undefined)}
                  >
                    <Copy aria-hidden className="size-3.5" />
                  </button>
                </div>
                <p className="text-[12.5px] text-fg-muted">
                  Chaque message est facturé par Meta à votre compte WhatsApp Business (conversation «{NB}Utilité{NB}»). Les destinataires doivent avoir accepté de
                  recevoir vos messages WhatsApp.
                </p>
              </Disclosure>
            </div>
          )}
        </section>
      </CardBody>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Déconnecter ce numéro WhatsApp${NB}?`}
        consequence={disconnectConsequence ?? "Plus aucun message ne partira par WhatsApp depuis ce numéro."}
        confirmLabel="Déconnecter le numéro"
        loading={pending}
        onConfirm={remove}
      />
    </Card>
  );
}
