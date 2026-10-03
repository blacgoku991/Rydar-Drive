"use client";
// Formulaire de contact public (/contact) : demande de tarif, question, partenariat. Envoi par l'action serveur
// sendContactRequest (lib/contact.ts) ; erreurs affichées dans le formulaire, jamais seulement dans un toast.
import {
  CONTACT_LIMITS,
  CONTACT_TOPIC_META,
  CONTACT_TOPICS,
  FLEET_SIZE_META,
  FLEET_SIZES,
  type ContactTopic,
  type FleetSize,
} from "@rydar/shared";
import { CircleCheck, Send } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { sendContactRequest } from "@/app/contact/actions";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";
import { fr } from "./typo";

type Values = {
  topic: ContactTopic;
  planCode: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  fleetSize: string;
  message: string;
  website: string;
};

/** Ordre des champs à l'écran (clé d'erreur → suffixe de l'id du champ) : le premier champ en erreur reçoit le focus. */
const FIELD_IDS: [string, string][] = [
  ["planCode", "plan"], ["fleetSize", "fleet"], ["name", "name"], ["company", "company"], ["email", "email"], ["phone", "phone"],
  ["message", "message"],
];

const PLACEHOLDER: Record<ContactTopic, string> = {
  pricing: "Votre activité, le nombre de chauffeurs, ce que vous utilisez aujourd'hui (WhatsApp, autre logiciel)…",
  question: "Votre question…",
  partnership: "Présentez votre projet de partenariat…",
  other: "Votre message…",
};


export function ContactForm({
  defaultTopic,
  defaultPlan,
  plans,
}: {
  defaultTopic: ContactTopic;
  /** Offre choisie sur /tarifs (code), si elle existe */
  defaultPlan: string | null;
  plans: { code: string; name: string }[];
}) {
  const uid = useId();
  const id = (k: string) => `${uid}-${k}`;
  const initial: Values = {
    topic: defaultTopic,
    planCode: defaultPlan && plans.some((p) => p.code === defaultPlan) ? defaultPlan : "",
    name: "",
    company: "",
    email: "",
    phone: "",
    fleetSize: "",
    message: "",
    website: "",
  };
  const [v, setV] = useState<Values>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ email: string; ackQueued: boolean } | null>(null);
  const [pending, start] = useTransition();

  const set = <K extends keyof Values>(k: K, value: Values[K]) => {
    setV((cur) => ({ ...cur, [k]: value }));
    setErrors(({ [k]: _drop, ...rest }) => rest);
    setFormError(null);
  };

  const submit = () =>
    start(() =>
      runAction(
        async () => {
          const pricing = v.topic === "pricing";
          const res = await sendContactRequest({
            topic: v.topic,
            planCode: pricing && v.planCode ? v.planCode : undefined,
            name: v.name,
            company: v.company || undefined,
            email: v.email,
            phone: v.phone || undefined,
            fleetSize: pricing && v.fleetSize ? (v.fleetSize as FleetSize) : undefined,
            message: v.message,
            website: v.website || undefined,
          });
          if (!res.ok) {
            const fe = res.fieldErrors ?? {};
            setErrors(fe);
            setFormError(res.error);
            // Focus sur le premier champ en erreur (son message lui est relié) ; sinon il reste sur le bouton d'envoi
            const first = FIELD_IDS.find(([k]) => fe[k]);
            if (first) document.getElementById(id(first[1]))?.focus();
            return;
          }
          setSent({ email: v.email.trim().toLowerCase(), ackQueued: res.ackQueued });
        },
        (message) => setFormError(message),
      ),
    );

  if (sent) {
    return (
      <div className="flex flex-col items-start gap-4 py-4">
        <span className="grid size-11 place-items-center rounded-full border border-brand/40 bg-brand/10">
          <CircleCheck className="size-5 text-brand" aria-hidden />
        </span>
        <div>
          <SentHeading />
          <p className="mt-2 max-w-md text-[14.5px] leading-relaxed text-fg-muted">
            {fr(`Merci ! Nous vous répondons à l'adresse ${sent.email}.`)}
            {sent.ackQueued ? ` ${fr("Un e-mail de confirmation vient de vous être envoyé.")}` : ""}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setSent(null);
            setV({ ...initial, topic: v.topic, planCode: v.planCode });
          }}
        >
          Envoyer une autre demande
        </Button>
      </div>
    );
  }

  const pricing = v.topic === "pricing";
  return (
    <form onSubmit={submitWith(submit)} noValidate className="space-y-6">
      <fieldset>
        <legend className="text-[12.5px] font-medium text-fg-muted">Sujet de votre demande</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {CONTACT_TOPICS.map((t) => {
            const checked = v.topic === t;
            return (
              <label
                key={t}
                className={cn(
                  "flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-2.5 text-[14px] transition-colors",
                  "has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand/15",
                  checked ? "border-brand/50 bg-brand/[0.07] text-fg" : "border-line bg-white/[0.02] text-fg-muted hover:border-line-strong hover:text-fg",
                )}
              >
                <input
                  type="radio"
                  name="topic"
                  value={t}
                  checked={checked}
                  onChange={() => set("topic", t)}
                  className="size-4 shrink-0 accent-brand"
                />
                {CONTACT_TOPIC_META[t].label}
              </label>
            );
          })}
        </div>
      </fieldset>

      {pricing && (
        <div className="grid gap-4 sm:grid-cols-2">
          {plans.length > 0 && (
            <Field label="Offre qui vous intéresse" htmlFor={id("plan")} optional error={errors.planCode}>
              <NativeSelect id={id("plan")} value={v.planCode} onChange={(e) => set("planCode", e.target.value)}>
                <option value="">Je ne sais pas encore</option>
                {plans.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label="Taille de votre flotte" htmlFor={id("fleet")} optional error={errors.fleetSize}>
            <NativeSelect id={id("fleet")} value={v.fleetSize} onChange={(e) => set("fleetSize", e.target.value)}>
              <option value="">Non précisé</option>
              {FLEET_SIZES.map((s) => (
                <option key={s} value={s}>
                  {FLEET_SIZE_META[s].label}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nom et prénom" htmlFor={id("name")} error={errors.name}>
          <Input
            id={id("name")}
            value={v.name}
            onChange={(e) => set("name", e.target.value)}
            autoComplete="name"
            maxLength={CONTACT_LIMITS.name}
            required
            aria-invalid={!!errors.name}
          />
        </Field>
        <Field label="Société" htmlFor={id("company")} optional error={errors.company}>
          <Input
            id={id("company")}
            value={v.company}
            onChange={(e) => set("company", e.target.value)}
            autoComplete="organization"
            maxLength={CONTACT_LIMITS.company}
            aria-invalid={!!errors.company}
          />
        </Field>
        <Field label="E-mail" htmlFor={id("email")} error={errors.email}>
          <Input
            id={id("email")}
            type="email"
            inputMode="email"
            value={v.email}
            onChange={(e) => set("email", e.target.value)}
            autoComplete="email"
            maxLength={CONTACT_LIMITS.email}
            required
            aria-invalid={!!errors.email}
          />
        </Field>
        <Field label="Téléphone" htmlFor={id("phone")} optional error={errors.phone}>
          <Input
            id={id("phone")}
            type="tel"
            inputMode="tel"
            value={v.phone}
            onChange={(e) => set("phone", e.target.value)}
            autoComplete="tel"
            maxLength={CONTACT_LIMITS.phone}
            aria-invalid={!!errors.phone}
          />
        </Field>
      </div>

      <Field
        label="Message"
        htmlFor={id("message")}
        error={errors.message}
        hint={`${v.message.length.toLocaleString("fr-FR")} / ${CONTACT_LIMITS.message.toLocaleString("fr-FR")} caractères`}
      >
        <Textarea
          id={id("message")}
          value={v.message}
          onChange={(e) => set("message", e.target.value)}
          placeholder={fr(PLACEHOLDER[v.topic])}
          rows={6}
          maxLength={CONTACT_LIMITS.message}
          required
          aria-invalid={!!errors.message}
          className="min-h-[150px]"
        />
      </Field>

      {/* Piège à robots : invisible et hors du parcours clavier ; rempli → faux succès côté serveur */}
      <div aria-hidden className="absolute -left-[10000px] top-auto size-px overflow-hidden">
        <label>
          Site web
          <input tabIndex={-1} autoComplete="off" value={v.website} onChange={(e) => set("website", e.target.value)} />
        </label>
      </div>

      {formError && (
        <p role="alert" className="rounded-xl border border-red/30 bg-red/[0.07] px-3.5 py-2.5 text-[13.5px] text-red">
          {formError}
        </p>
      )}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-md text-[12.5px] leading-relaxed text-fg-muted">
          {fr("Vos coordonnées servent uniquement à répondre à votre demande et sont conservées 3 ans au plus.")}{" "}
          <Link href="/confidentialite" className="text-fg underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-brand">
            Politique de confidentialité
          </Link>
        </p>
        <Button type="submit" variant="primary" size="lg" loading={pending} className="shrink-0">
          <Send aria-hidden /> Envoyer la demande
        </Button>
      </div>
    </form>
  );
}

/**
 * Confirmation : le formulaire (et son bouton, qui avait le focus) disparaît ; le titre reçoit le focus pour que la
 * confirmation soit lue (WCAG 4.1.3, 2.4.3) au lieu d'un focus perdu sur <body>.
 */
function SentHeading() {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <h2 ref={ref} tabIndex={-1} className="text-[20px] font-semibold tracking-tight outline-none">
      Demande envoyée
    </h2>
  );
}
