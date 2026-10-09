"use client";
// Test d'éligibilité Flotte Privée : étape 1 (activité, budget publicité, zone), étape 2 (coordonnées), puis
// résultat (verdict, score, simulation). Envoi par l'action serveur sendEligibility (lib/eligibility.ts) ; erreurs
// affichées dans le formulaire.
import {
  BUDGET_FOR_ANSWER,
  ELIGIBILITY_LIMITS,
  ELIGIBILITY_QUESTIONS,
  ELIGIBILITY_VERDICT_META,
  eligibilityVerdict,
  formatPhone,
  normalizePhone,
  optionLabel,
  simulate,
  type EligibilityAnswers,
  type EligibilityVerdict,
} from "@rydar/shared";
import { ArrowLeft, ArrowRight, Check, CircleCheck, Clock3, PhoneCall, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { sendEligibility } from "@/app/eligibilite/actions";
import { fr } from "@/components/marketing/typo";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { cn, submitWith } from "@/lib/utils";
import { eur, int } from "./format";
import { useSim } from "./sim-context";

type QuestionKey = keyof typeof ELIGIBILITY_QUESTIONS;
const QUESTION_KEYS: QuestionKey[] = ["revenue", "budget", "zone"];

type Contact = { name: string; phone: string; email: string; city: string; consent: boolean; website: string };
const EMPTY_CONTACT: Contact = { name: "", phone: "", email: "", city: "", consent: false, website: "" };
/** Ordre des champs à l'écran (clé d'erreur → suffixe de l'id) : le premier champ en erreur reçoit le focus. */
const FIELD_IDS: [string, string][] = [["name", "name"], ["phone", "phone"], ["email", "email"], ["city", "city"], ["consent", "consent"]];

function Progress({ step, answered }: { step: 1 | 2; answered: number }) {
  const value = step === 1 ? (answered / 3) * 50 : 50 + 25;
  return (
    <div className="flex items-center gap-4">
      <p className="shrink-0 text-[12px] font-semibold uppercase tracking-[0.16em] text-brand">{fr(`Étape ${step} sur 2`)}</p>
      <div aria-hidden className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-600">
        <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${value}%` }} />
      </div>
      {step === 1 && <p className="num shrink-0 text-[12.5px] text-fg-muted">{answered}/3</p>}
    </div>
  );
}

/** Titre qui reçoit le focus à son affichage (changement d'étape annoncé, focus jamais perdu sur <body>). */
function FocusHeading({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: false }), []);
  return (
    <h3 ref={ref} tabIndex={-1} className={cn("scroll-mt-28 outline-none", className)}>
      {children}
    </h3>
  );
}

const VERDICT_ICON: Record<EligibilityVerdict, typeof CircleCheck> = { eligible: CircleCheck, to_discuss: Sparkles, not_yet: Clock3 };
const VERDICT_TONE: Record<EligibilityVerdict, string> = {
  eligible: "border-brand/40 bg-brand/[0.08] text-brand",
  to_discuss: "border-amber/40 bg-amber/[0.08] text-amber",
  not_yet: "border-line-strong bg-white/[0.03] text-fg-muted",
};

export function EligibilityTest() {
  const uid = useId();
  const id = (k: string) => `${uid}-${k}`;
  const sim = useSim();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [answers, setAnswers] = useState<Partial<EligibilityAnswers>>({});
  const [missing, setMissing] = useState<Partial<Record<QuestionKey, boolean>>>({});
  const [c, setC] = useState<Contact>(EMPTY_CONTACT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<{ verdict: EligibilityVerdict; phone: string } | null>(null);
  const [pending, start] = useTransition();
  const topRef = useRef<HTMLDivElement>(null);

  const answered = QUESTION_KEYS.filter((k) => answers[k]).length;

  const choose = (k: QuestionKey, value: string) => {
    setAnswers((cur) => ({ ...cur, [k]: value }));
    setMissing(({ [k]: _drop, ...rest }) => rest);
  };
  const set = <K extends keyof Contact>(k: K, value: Contact[K]) => {
    setC((cur) => ({ ...cur, [k]: value }));
    setErrors(({ [k]: _drop, ...rest }) => rest);
    setFormError(null);
  };
  const scrollTop = () => topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  const next = () => {
    const absent = QUESTION_KEYS.filter((k) => !answers[k]);
    if (absent.length) {
      setMissing(Object.fromEntries(absent.map((k) => [k, true])));
      document.querySelector<HTMLInputElement>(`input[name="${id(absent[0]!)}"]`)?.focus();
      return;
    }
    setStep(2);
    scrollTop();
  };

  const submit = () =>
    start(() =>
      runAction(
        async () => {
          const a = answers as EligibilityAnswers;
          const res = await sendEligibility({
            revenue: a.revenue,
            budget: a.budget,
            zone: a.zone,
            name: c.name,
            phone: c.phone,
            email: c.email,
            city: c.city || undefined,
            consent: c.consent as true,
            simBudget: sim.touched ? sim.budget : undefined,
            website: c.website || undefined,
          });
          if (!res.ok) {
            const fe = res.fieldErrors ?? {};
            setErrors(fe);
            setFormError(res.error);
            const first = FIELD_IDS.find(([k]) => fe[k]);
            if (first) document.getElementById(id(first[1]))?.focus();
            return;
          }
          setResult({ verdict: res.verdict, phone: c.phone });
          setStep(3);
          scrollTop();
        },
        (message) => setFormError(message),
      ),
    );

  return (
    <div ref={topRef} className="scroll-mt-24">
      {step === 1 && (
        <div className="space-y-8">
          <Progress step={1} answered={answered} />
          {QUESTION_KEYS.map((k, qi) => {
            const q = ELIGIBILITY_QUESTIONS[k];
            const errId = id(`${k}-error`);
            return (
              <fieldset key={k} aria-describedby={missing[k] ? errId : undefined}>
                <legend className="flex items-center gap-3 text-[17px] font-semibold tracking-tight text-fg sm:text-[19px]">
                  <span
                    className={cn(
                      "num grid size-7 shrink-0 place-items-center rounded-full border text-[13px]",
                      answers[k] ? "border-brand bg-brand text-brand-fg" : "border-line-strong text-fg-muted",
                    )}
                    aria-hidden
                  >
                    {answers[k] ? <Check className="size-3.5" strokeWidth={3} /> : qi + 1}
                  </span>
                  {fr(q.title)}
                </legend>
                <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
                  {q.options.map((o) => {
                    const checked = answers[k] === o.value;
                    return (
                      <label
                        key={o.value}
                        className={cn(
                          "group relative flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-[15px] font-medium transition-all",
                          "has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand/20",
                          checked
                            ? "border-brand/70 bg-brand/[0.09] text-fg shadow-glow"
                            : "border-line-strong bg-white/[0.02] text-fg-muted hover:border-fg-subtle hover:bg-white/[0.04] hover:text-fg",
                        )}
                      >
                        <input
                          type="radio"
                          name={id(k)}
                          value={o.value}
                          checked={checked}
                          onChange={() => choose(k, o.value)}
                          className="peer sr-only"
                        />
                        <span
                          aria-hidden
                          className={cn(
                            "grid size-5 shrink-0 place-items-center rounded-full border-2 transition-colors",
                            checked ? "border-brand bg-brand" : "border-fg-subtle",
                          )}
                        >
                          {checked && <span className="size-1.5 rounded-full bg-brand-fg" />}
                        </span>
                        {fr(o.label)}
                      </label>
                    );
                  })}
                </div>
                {missing[k] && (
                  <p id={errId} className="mt-2 text-[13px] text-red">
                    Choisis une réponse
                  </p>
                )}
              </fieldset>
            );
          })}
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[12.5px] text-fg-muted">{fr("1 minute · gratuit · sans engagement")}</p>
            <Button type="button" variant="primary" size="xl" onClick={next} className="w-full sm:w-auto">
              Continuer <ArrowRight aria-hidden />
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <form onSubmit={submitWith(submit)} noValidate className="space-y-6">
          <Progress step={2} answered={3} />
          <div>
            <FocusHeading className="text-[22px] font-semibold tracking-tight sm:text-[26px]">{fr("Dernière étape : où on te rappelle ?")}</FocusHeading>
            <p className="mt-2 text-[14.5px] leading-relaxed text-fg-muted">
              {fr("Ton résultat s'affiche juste après. Notre équipe te rappelle pour la suite : aucun engagement.")}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Prénom et nom" htmlFor={id("name")} error={errors.name}>
              <Input
                id={id("name")}
                value={c.name}
                onChange={(e) => set("name", e.target.value)}
                autoComplete="name"
                maxLength={ELIGIBILITY_LIMITS.name}
                required
                aria-invalid={!!errors.name}
                className="h-12 text-[15px]"
              />
            </Field>
            <Field label="Téléphone" htmlFor={id("phone")} error={errors.phone}>
              <Input
                id={id("phone")}
                type="tel"
                inputMode="tel"
                value={c.phone}
                onChange={(e) => set("phone", e.target.value)}
                autoComplete="tel"
                placeholder="06 12 34 56 78"
                maxLength={ELIGIBILITY_LIMITS.phone}
                required
                aria-invalid={!!errors.phone}
                className="h-12 text-[15px]"
              />
            </Field>
            <Field label="E-mail" htmlFor={id("email")} error={errors.email}>
              <Input
                id={id("email")}
                type="email"
                inputMode="email"
                value={c.email}
                onChange={(e) => set("email", e.target.value)}
                autoComplete="email"
                maxLength={ELIGIBILITY_LIMITS.email}
                required
                aria-invalid={!!errors.email}
                className="h-12 text-[15px]"
              />
            </Field>
            <Field label="Ville où tu roules" htmlFor={id("city")} optional error={errors.city}>
              <Input
                id={id("city")}
                value={c.city}
                onChange={(e) => set("city", e.target.value)}
                autoComplete="address-level2"
                maxLength={ELIGIBILITY_LIMITS.city}
                aria-invalid={!!errors.city}
                className="h-12 text-[15px]"
              />
            </Field>
          </div>

          <div>
            <label
              htmlFor={id("consent")}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3.5 text-[13.5px] leading-relaxed transition-colors",
                errors.consent ? "border-red/50 bg-red/[0.05]" : "border-line-strong bg-white/[0.02] hover:border-fg-subtle",
              )}
            >
              <input
                id={id("consent")}
                type="checkbox"
                checked={c.consent}
                onChange={(e) => set("consent", e.target.checked)}
                aria-invalid={!!errors.consent}
                aria-describedby={errors.consent ? id("consent-error") : undefined}
                className="mt-0.5 size-5 shrink-0 accent-brand"
              />
              <span className="text-fg-muted">
                {fr("J'accepte que l'équipe Rydar Drive me contacte par téléphone ou par e-mail au sujet de Flotte Privée. Mes réponses et coordonnées servent seulement à cela.")}
              </span>
            </label>
            {errors.consent && (
              <p id={id("consent-error")} className="mt-1.5 text-xs text-red">
                {errors.consent}
              </p>
            )}
          </div>

          {/* Piège à robots : invisible et hors du parcours clavier ; rempli → faux succès côté serveur */}
          <div aria-hidden className="absolute -left-[10000px] top-auto size-px overflow-hidden">
            <label>
              Site web
              <input name="website" tabIndex={-1} autoComplete="off" value={c.website} onChange={(e) => set("website", e.target.value)} />
            </label>
          </div>

          {formError && (
            <p role="alert" className="rounded-xl border border-red/30 bg-red/[0.07] px-3.5 py-2.5 text-[13.5px] text-red">
              {formError}
            </p>
          )}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              size="lg"
              onClick={() => {
                setStep(1);
                scrollTop();
              }}
            >
              <ArrowLeft aria-hidden /> Modifier mes réponses
            </Button>
            <Button type="submit" variant="primary" size="xl" loading={pending} className="w-full sm:w-auto">
              Voir mon résultat <ArrowRight aria-hidden />
            </Button>
          </div>
          <p className="text-[12px] leading-relaxed text-fg-muted">
            {fr("Données conservées 3 ans au plus, jamais revendues. ")}
            <Link href="/confidentialite" className="text-fg underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-brand">
              Politique de confidentialité
            </Link>
          </p>
        </form>
      )}

      {step === 3 && result && <Result answers={answers as EligibilityAnswers} verdict={result.verdict} phone={result.phone} />}
    </div>
  );
}

function Result({ answers, verdict, phone }: { answers: EligibilityAnswers; verdict: EligibilityVerdict; phone: string }) {
  const sim = useSim();
  const meta = ELIGIBILITY_VERDICT_META[verdict];
  const { score, max } = eligibilityVerdict(answers);
  const Icon = VERDICT_ICON[verdict];
  const budget = sim.touched ? sim.budget : BUDGET_FOR_ANSWER[answers.budget];
  const s = simulate({ budget, fare: sim.fare, conversion: sim.conversion });

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <span className={cn("grid size-14 shrink-0 place-items-center rounded-2xl border", VERDICT_TONE[verdict])}>
          <Icon className="size-7" aria-hidden />
        </span>
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-fg-muted">Ton résultat</p>
          <FocusHeading className="mt-1 text-[26px] font-semibold tracking-tight sm:text-[32px]">{fr(meta.title)}</FocusHeading>
          <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-fg-muted">{fr(meta.text)}</p>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-white/[0.02] p-4 sm:p-5">
        <div className="flex items-center justify-between gap-4">
          <p className="text-[13px] font-medium text-fg">Score de ton profil</p>
          <p className="num text-[20px] font-semibold text-fg">
            {score}
            <span className="text-fg-muted">/{max}</span>
          </p>
        </div>
        <div aria-hidden className="mt-3 grid grid-cols-9 gap-1">
          {Array.from({ length: max }, (_, i) => (
            <span key={i} className={cn("h-2 rounded-full", i < score ? (verdict === "eligible" ? "bg-brand" : "bg-amber") : "bg-ink-500")} />
          ))}
        </div>
        <ul className="mt-4 grid gap-2 text-[13.5px] sm:grid-cols-3">
          {QUESTION_KEYS.map((k) => (
            <li key={k} className="rounded-lg bg-ink-900/60 px-3 py-2">
              <span className="block text-[11.5px] text-fg-muted">{k === "revenue" ? "Chiffre d'affaires" : k === "budget" ? "Budget pub" : "Zone"}</span>
              <span className="text-fg">{fr(optionLabel(k, answers[k]))}</span>
            </li>
          ))}
        </ul>
      </div>

      {verdict !== "not_yet" && budget > 0 && (
        <div className="rounded-xl border border-brand/25 bg-brand/[0.05] p-4 sm:p-5">
          <p className="text-[13px] font-medium text-fg">{fr(`Ta simulation avec ${eur(budget)} de pub par mois`)}</p>
          <p className="mt-2 text-[15px] leading-relaxed text-fg-muted">
            {fr("Environ ")}
            <strong className="num font-semibold text-fg">{fr(`${int(s.bookings)} réservations`)}</strong>
            {fr(" et ")}
            <strong className="num font-semibold text-brand">{eur(s.revenue)}</strong>
            {fr(" de chiffre d'affaires par mois, dont ")}
            <strong className="num font-semibold text-fg">{eur(s.net)}</strong>
            {fr(" après la pub (simulation indicative).")}
          </p>
          <a href="#simulateur" className="mt-3 inline-flex min-h-10 items-center gap-1.5 text-[13.5px] font-medium text-brand underline-offset-4 hover:underline">
            Affiner dans le simulateur <ArrowRight className="size-3.5" aria-hidden />
          </a>
        </div>
      )}

      <div className="flex items-start gap-3 rounded-xl border border-line bg-ink-900/60 p-4">
        <PhoneCall className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden />
        <p className="text-[14px] leading-relaxed text-fg-muted">
          {fr("Demande bien reçue. Notre équipe te rappelle au ")}
          <span className="num whitespace-nowrap text-fg">{formatPhone(normalizePhone(phone) ?? phone)}</span>
          {fr(" : garde ton téléphone à portée de main.")}
        </p>
      </div>
    </div>
  );
}
