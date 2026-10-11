"use client";
// Flotte Privée, Réglages › Délais et rappels (onglet « bookings », docs/FLOTTE-PRIVEE.md § 3.3 et § 7.3) : ce que le
// chauffeur-propriétaire règle lui-même — confirmation au plus tard avant la prise en charge, délai de réponse à une
// réservation immédiate, rappels, paiement par défaut. Choix proposés seulement (privateBookingSettingsSchema) ; le
// reste du profil de dispatch (seuil, rayons du dernier appel) est posé par l'équipe Rydar.
import {
  PAYMENT_METHOD_LABELS, PAYMENT_METHODS, PRIVATE_BOOKING_LEAD_CHOICES, PRIVATE_BOOKING_REMINDER_CHOICES, PRIVATE_BOOKING_TIMEOUT_CHOICES,
  type PaymentMethod,
} from "@rydar/shared";
import { CalendarClock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updatePrivateBookingSettings } from "@/app/dashboard/settings/actions";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, NativeSelect } from "@/components/ui/input";
import { minutesLabel, nearestChoice, secondsLabel } from "@/components/settings/private-booking";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";

export type PrivateBookingSettingsRow = {
  scheduled_dispatch_lead_minutes: number;
  offer_timeout_seconds: number;
  reminder_offsets_minutes: number[];
  default_payment_method: PaymentMethod;
};

export function PrivateBookingSettingsForm({ settings, readOnly }: { settings: PrivateBookingSettingsRow; readOnly: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const lead = nearestChoice(settings.scheduled_dispatch_lead_minutes, PRIVATE_BOOKING_LEAD_CHOICES);
  const timeout = nearestChoice(settings.offer_timeout_seconds, PRIVATE_BOOKING_TIMEOUT_CHOICES);
  const [reminders, setReminders] = useState<number[]>(() =>
    (settings.reminder_offsets_minutes ?? []).filter((m) => (PRIVATE_BOOKING_REMINDER_CHOICES as readonly number[]).includes(m)),
  );
  const toggle = (m: number) => setReminders((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m].sort((a, b) => b - a)));

  return (
    <Card data-tour="fp-booking-settings" className="max-w-3xl">
      <CardHeader
        icon={<CalendarClock />}
        title="Délais et rappels"
        description="Chaque réservation de votre site vous est proposée à confirmer, application ouverte ou non. Sans réponse à temps, elle passe « Non confirmée » et votre site en est informé."
      />
      <CardBody>
        <form
          onSubmit={submitWith((f) =>
            start(() => runAction(async () => {
              const res = await updatePrivateBookingSettings({
                scheduledDispatchLeadMinutes: Number(f.get("lead")),
                offerTimeoutSeconds: Number(f.get("timeout")),
                reminderOffsetsMinutes: reminders,
                defaultPaymentMethod: String(f.get("payment")) as PaymentMethod,
              });
              if (!res.ok) {
                setErrors(res.fieldErrors ?? {});
                toast.error(res.error);
                return;
              }
              setErrors({});
              toast.success("Réglages des réservations enregistrés");
              router.refresh();
            })),
          )}
          className="space-y-6"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Confirmer au plus tard"
              hint={
                lead === settings.scheduled_dispatch_lead_minutes
                  ? "Avant la prise en charge. Ensuite : un dernier appel sur votre téléphone s'il est en ligne, puis « Non confirmée ». Un délai plus long ne vaut que pour les nouvelles réservations."
                  : `Réglage actuel : ${minutesLabel(settings.scheduled_dispatch_lead_minutes)} (non proposé) — choisissez un délai.`
              }
              error={errors.scheduledDispatchLeadMinutes}
            >
              <NativeSelect name="lead" defaultValue={String(lead)} disabled={readOnly}>
                {PRIVATE_BOOKING_LEAD_CHOICES.map((m) => (
                  <option key={m} value={m}>
                    {minutesLabel(m)} avant
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field
              label="Délai de réponse à une réservation immédiate"
              hint={
                timeout === settings.offer_timeout_seconds
                  ? "Réservation « maintenant » : votre téléphone sonne pendant ce délai."
                  : `Réglage actuel : ${secondsLabel(settings.offer_timeout_seconds)} (non proposé) — choisissez un délai.`
              }
              error={errors.offerTimeoutSeconds}
            >
              <NativeSelect name="timeout" defaultValue={String(timeout)} disabled={readOnly}>
                {PRIVATE_BOOKING_TIMEOUT_CHOICES.map((s) => (
                  <option key={s} value={s}>
                    {secondsLabel(s)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>

          <fieldset>
            <legend className="text-[12.5px] font-medium text-fg-muted">Rappels avant la prise en charge</legend>
            <p className="mt-0.5 text-[12.5px] text-fg-muted">Aussi utilisés pour vous rappeler une réservation encore à confirmer.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {PRIVATE_BOOKING_REMINDER_CHOICES.map((m) => {
                const on = reminders.includes(m);
                return (
                  <button
                    key={m}
                    type="button"
                    disabled={readOnly}
                    aria-pressed={on}
                    onClick={() => toggle(m)}
                    className={cn(
                      "min-h-10 rounded-lg border px-3 text-[13px] transition-colors disabled:opacity-50 max-sm:min-h-11",
                      on ? "border-brand/50 bg-brand/[0.08] text-brand" : "border-line text-fg-muted hover:text-fg",
                    )}
                  >
                    {minutesLabel(m)} avant
                  </button>
                );
              })}
            </div>
            {errors.reminderOffsetsMinutes && <p className="mt-1.5 text-xs text-red">{errors.reminderOffsetsMinutes}</p>}
          </fieldset>

          <Field label="Paiement par défaut" hint="Proposé pour une réservation saisie au tableau de bord." error={errors.defaultPaymentMethod} className="sm:max-w-xs">
            <NativeSelect name="payment" defaultValue={settings.default_payment_method} disabled={readOnly}>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </NativeSelect>
          </Field>

          {!readOnly && (
            <div className="flex justify-end">
              <Button type="submit" variant="primary" loading={pending} className="max-sm:w-full">
                Enregistrer
              </Button>
            </div>
          )}
        </form>
      </CardBody>
    </Card>
  );
}
