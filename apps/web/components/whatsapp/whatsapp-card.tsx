"use client";
// Numéro WhatsApp Business (API Cloud de Meta) d'une centrale ou de Rydar : identifiant du numéro, jeton d'accès
// (jamais relu : champ vide = jeton conservé), modèle validé par Meta, activation, message test, état des envois.
import { WHATSAPP_API_VERSION } from "@rydar/shared";
import { Check, ChevronDown, Copy, MessageCircle, Send, Unplug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/misc";
import { cn, submitWith } from "@/lib/utils";

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
  children?: React.ReactNode;
};

const when = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date(iso)) : "";

export function WhatsAppCard({ title, description, row, defaultTemplate, templateText, variables, readOnly, onSave, onRemove, onTest, children }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [phoneNumberId, setPhoneNumberId] = useState(row?.phone_number_id ?? "");
  const [token, setToken] = useState("");
  const [template, setTemplate] = useState(row?.template ?? defaultTemplate);
  const [language, setLanguage] = useState(row?.language ?? "fr");
  const [enabled, setEnabled] = useState(row?.enabled ?? true);
  const [to, setTo] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [help, setHelp] = useState(!row);

  useEffect(() => {
    setPhoneNumberId(row?.phone_number_id ?? "");
    setTemplate(row?.template ?? defaultTemplate);
    setLanguage(row?.language ?? "fr");
    setEnabled(row?.enabled ?? true);
    setToken("");
  }, [row, defaultTemplate]);

  const lastFailed = !!row?.last_error_at && (!row.last_sent_at || row.last_error_at > row.last_sent_at);

  const save = () =>
    start(async () => {
      setErrors({});
      const res = await onSave({ phoneNumberId: phoneNumberId.trim(), token: token.trim(), template: template.trim(), language: language.trim(), enabled });
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
        return;
      }
      toast.success(res.message);
      setToken("");
      router.refresh();
    });

  const remove = () =>
    start(async () => {
      if (!window.confirm("Déconnecter ce numéro WhatsApp ? Les relances repasseront par l'application.")) return;
      const res = await onRemove();
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.message);
      router.refresh();
    });

  const test = () =>
    start(async () => {
      setErrors({});
      const res = await onTest(to);
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.error);
      } else toast.success(res.message);
      router.refresh();
    });

  return (
    <Card>
      <CardHeader
        icon={<MessageCircle />}
        title={title}
        description={description}
        action={row ? <Badge tone={!row.enabled ? "neutral" : lastFailed ? "red" : "green"}>{!row.enabled ? "Désactivé" : lastFailed ? "Erreur" : "Relié"}</Badge> : <Badge tone="neutral">Non relié</Badge>}
      />
      <CardBody className="space-y-5">
        {children}

        {row && (
          <div className="rounded-xl border border-line bg-white/[0.02] px-4 py-3 text-[12.5px]">
            <p className="font-medium text-fg">
              {row.verified_name ?? "Numéro WhatsApp Business"}
              {row.display_phone ? <span className="mono text-fg-muted"> · {row.display_phone}</span> : null}
            </p>
            <p className="mt-0.5 text-fg-muted" suppressHydrationWarning>
              {row.sent_count > 0 ? `${row.sent_count} message${row.sent_count > 1 ? "s" : ""} envoyé${row.sent_count > 1 ? "s" : ""}` : "Aucun message envoyé"}
              {row.last_sent_at ? ` · dernier le ${when(row.last_sent_at)}` : ""}
            </p>
            {lastFailed && (
              <p className="mt-1.5 text-red" suppressHydrationWarning>
                Dernière erreur ({when(row.last_error_at)}) : {row.last_error}
              </p>
            )}
          </div>
        )}

        <form onSubmit={submitWith(save)} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Identifiant du numéro (Phone Number ID)" error={errors.phoneNumberId}>
              <Input value={phoneNumberId} disabled={readOnly} inputMode="numeric" onChange={(e) => setPhoneNumberId(e.target.value.replace(/\D/g, ""))} placeholder="106540352242922" className="mono" aria-invalid={!!errors.phoneNumberId} />
            </Field>
            <Field label="Jeton d'accès permanent" error={errors.token} hint={row ? "Laissez vide pour garder le jeton enregistré." : "Utilisateur système Meta, droit whatsapp_business_messaging."}>
              <Input type="password" autoComplete="off" value={token} disabled={readOnly} onChange={(e) => setToken(e.target.value)} placeholder={row ? "•••••••• enregistré" : "EAAG…"} className="mono" aria-invalid={!!errors.token} />
            </Field>
            <Field label="Nom du modèle" error={errors.template} hint={`Modèle « Utilité » approuvé par Meta, ${variables}.`}>
              <Input value={template} disabled={readOnly} onChange={(e) => setTemplate(e.target.value.toLowerCase())} className="mono" aria-invalid={!!errors.template} spellCheck={false} />
            </Field>
            <Field label="Langue du modèle" error={errors.language}>
              <Input value={language} disabled={readOnly} onChange={(e) => setLanguage(e.target.value)} className="mono" aria-invalid={!!errors.language} spellCheck={false} />
            </Field>
          </div>
          <label className="flex items-center justify-between gap-4 rounded-xl border border-line bg-white/[0.02] px-4 py-3">
            <span>
              <span className="block text-[13.5px] font-medium">Envois actifs</span>
              <span className="block text-[12px] text-fg-subtle">Désactivé : les relances partent par l&apos;application.</span>
            </span>
            <Switch checked={enabled} onCheckedChange={setEnabled} disabled={readOnly} aria-label="Envois WhatsApp actifs" />
          </label>
          {!readOnly && (
            <div className="flex flex-wrap justify-end gap-2">
              {row && (
                <Button type="button" variant="ghost" size="sm" onClick={remove} disabled={pending}>
                  <Unplug /> Déconnecter
                </Button>
              )}
              <Button type="submit" variant="primary" size="sm" loading={pending}>
                <Check /> {row ? "Enregistrer" : "Vérifier et relier"}
              </Button>
            </div>
          )}
        </form>

        {row && !readOnly && (
          <form onSubmit={submitWith(test)} className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-end">
            <Field label="Message test" className="flex-1" error={errors.to} hint="Votre numéro : vous recevez le modèle avec des valeurs d'exemple.">
              <Input type="tel" value={to} onChange={(e) => setTo(e.target.value)} placeholder="06 12 34 56 78" aria-invalid={!!errors.to} />
            </Field>
            <Button type="submit" variant="outline" size="md" loading={pending} disabled={!to.trim()} className="sm:mb-[22px]">
              <Send /> Envoyer
            </Button>
          </form>
        )}

        <div className="rounded-xl bg-white/[0.03]">
          <button type="button" onClick={() => setHelp((v) => !v)} className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-[13px] font-medium" aria-expanded={help}>
            Comment obtenir ces informations
            <ChevronDown className={cn("size-4 text-fg-subtle transition-transform", help && "rotate-180")} />
          </button>
          {help && (
            <div className="space-y-3 px-4 pb-4 text-[12.5px] leading-[19px] text-fg-muted">
              <ol className="list-decimal space-y-1.5 pl-4">
                <li>
                  Créez un compte WhatsApp Business sur <span className="text-fg">business.facebook.com</span> (Meta Business Suite) et ajoutez votre numéro dans
                  l&apos;application « WhatsApp » de <span className="text-fg">developers.facebook.com</span> (API Cloud). Un numéro déjà utilisé dans l&apos;app
                  WhatsApp doit d&apos;abord en être retiré.
                </li>
                <li>
                  Copiez l&apos;<span className="text-fg">identifiant du numéro</span> (WhatsApp › Configuration de l&apos;API, « Phone number ID »).
                </li>
                <li>
                  Créez un <span className="text-fg">utilisateur système</span> (Paramètres de l&apos;entreprise › Utilisateurs système), donnez-lui accès à
                  l&apos;application et au compte WhatsApp, puis générez un jeton permanent avec les droits <span className="mono">whatsapp_business_messaging</span>{" "}
                  et <span className="mono">whatsapp_business_management</span>.
                </li>
                <li>
                  Créez le modèle <span className="mono text-fg">{defaultTemplate}</span> (catégorie Utilité, langue Français) avec exactement ce texte, puis attendez
                  son approbation :
                </li>
              </ol>
              <div className="flex items-start gap-2 rounded-lg border border-line bg-ink-800/60 px-3 py-2.5">
                <p className="flex-1 text-fg">{templateText}</p>
                <button
                  type="button"
                  aria-label="Copier le texte du modèle"
                  className="shrink-0 rounded-md p-1 text-fg-subtle hover:bg-white/[0.06] hover:text-fg"
                  onClick={() => navigator.clipboard?.writeText(templateText).then(() => toast.success("Texte du modèle copié"), () => undefined)}
                >
                  <Copy className="size-3.5" />
                </button>
              </div>
              <p>
                Chaque message est facturé par Meta à votre compte WhatsApp Business (conversation « Utilité »). Les destinataires doivent avoir accepté de recevoir
                vos messages WhatsApp. API Graph {WHATSAPP_API_VERSION}.
              </p>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
