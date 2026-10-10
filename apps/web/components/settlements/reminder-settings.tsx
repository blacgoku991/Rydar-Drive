"use client";
// Relances de commission (mode centrale) : canal — application, WhatsApp ou les deux — et numéro WhatsApp Business
// de la centrale (son compte dispatch). WhatsApp impossible pour un chauffeur : la relance part par l'application.
// Le canal est enregistré dès qu'il est choisi (updateReminderChannels) ; la configuration du numéro est repliée
// (WhatsAppCard), docs/REFONTE-PANELS.md § 5.6.
import { WHATSAPP_TEMPLATES, type ReminderChannel } from "@rydar/shared";
import { Bell, Check, MessageCircle, Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { removeOrgWhatsApp, saveOrgWhatsApp, testOrgWhatsApp, updateReminderChannels } from "@/app/dashboard/settings/actions";
import { WhatsAppCard, type WhatsAppRow } from "@/components/whatsapp/whatsapp-card";
import { runAction } from "@/lib/run-action";
import { cn } from "@/lib/utils";

const NB = " ";

const OPTIONS: { key: string; channels: ReminderChannel[]; label: string; icon: typeof Bell }[] = [
  { key: "app", channels: ["app"], label: "Application", icon: Smartphone },
  { key: "whatsapp", channels: ["whatsapp"], label: "WhatsApp", icon: MessageCircle },
  { key: "both", channels: ["app", "whatsapp"], label: "Les deux", icon: Bell },
];

export function ReminderSettings({ channels, whatsapp, readOnly }: { channels: ReminderChannel[]; whatsapp: WhatsAppRow | null; readOnly: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [current, setCurrent] = useState(channels);
  const key = current.includes("whatsapp") ? (current.includes("app") ? "both" : "whatsapp") : "app";
  const waReady = !!whatsapp?.enabled;
  const labelId = useId();

  const pick = (next: ReminderChannel[]) =>
    start(() =>
      runAction(async () => {
        const res = await updateReminderChannels(next);
        if (!res.ok) return void toast.error(res.error);
        setCurrent(next);
        toast.success("Canal des relances enregistré");
        router.refresh();
      }),
    );

  return (
    <WhatsAppCard
      title="Relances des chauffeurs"
      description={`Rappels de commission${NB}: bouton «${NB}Relancer${NB}» et relances automatiques des retards (une par jour, 3 au plus).`}
      row={whatsapp}
      defaultTemplate={WHATSAPP_TEMPLATES.driver.name}
      templateText={WHATSAPP_TEMPLATES.driver.text}
      variables={`4 variables${NB}: prénom, montant, centrale, nombre de courses`}
      readOnly={readOnly}
      onSave={saveOrgWhatsApp}
      onRemove={removeOrgWhatsApp}
      onTest={testOrgWhatsApp}
      disconnectConsequence="Les relances repasseront par l'application."
    >
      <div>
        <p id={labelId} className="mb-2 text-[13px] font-medium text-fg">
          Envoyer les relances par
        </p>
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-labelledby={labelId}>
          {OPTIONS.map((o) => {
            const on = key === o.key;
            const needsWa = o.channels.includes("whatsapp");
            return (
              <button
                key={o.key}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={readOnly || pending || (needsWa && !waReady && !on)}
                onClick={() => !on && pick(o.channels)}
                className={cn(
                  "flex h-11 items-center justify-center gap-2 rounded-xl border px-3 text-[13px] font-medium transition-colors disabled:opacity-50",
                  on ? "border-brand/50 bg-brand/[0.07] text-fg" : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
                )}
              >
                <o.icon aria-hidden className={cn("size-4", on ? "text-brand" : "text-fg-subtle")} />
                {o.label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-fg-muted">
          <Check aria-hidden className="size-3.5 text-green" /> Enregistré automatiquement
        </p>
        <p className="mt-1 text-[12.5px] text-fg-muted">
          {!waReady
            ? "Pour relancer aussi par WhatsApp, reliez d'abord votre numéro WhatsApp Business ci-dessous."
            : `Chauffeur sans numéro valide ou message refusé par WhatsApp${NB}: la relance part par l'application.`}
        </p>
      </div>
    </WhatsAppCard>
  );
}
