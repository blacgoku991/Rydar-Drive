"use client";
// Page publique /rejoindre/{code} : candidature d'un chauffeur (ouverte depuis WhatsApp / Telegram → mobile d'abord).
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_META, type VehicleCategory } from "@rydar/shared";
import { AlertCircle, Check, Eye, EyeOff, FileText, LogIn, Minus, Plus, Smartphone, Wifi } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { applyToCentrale, type JoinResult } from "@/app/rejoindre/[code]/actions";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Champs 16 px sur mobile : pas de zoom automatique d'iOS à la saisie. */
const INPUT = "h-11 text-base sm:text-sm";

const FIELD_ORDER = [
  "firstName", "lastName", "phone", "email", "password", "vtcCardNumber",
  "vehicle.brand", "vehicle.model", "vehicle.color", "vehicle.plate", "vehicle.category", "vehicle.seats", "message", "acceptTerms",
];

function Section({ step, title, hint, children }: { step: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3.5">
      <legend className="mb-3.5 flex items-center gap-2.5">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand/15 text-[12px] font-semibold text-brand">{step}</span>
        <span className="text-[15px] font-semibold tracking-tight">{title}</span>
        {hint && <span className="text-[12px] text-fg-subtle">{hint}</span>}
      </legend>
      {children}
    </fieldset>
  );
}

function SuccessScreen({ result }: { result: Extract<JoinResult, { ok: true }> }) {
  const approved = result.status === "APPROVED";
  const ref = useRef<HTMLDivElement>(null);
  // Mobile : la confirmation remplace le formulaire → on l'amène à l'écran
  useEffect(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }), []);
  const steps = [
    { icon: Smartphone, title: "Téléchargez l'application Rydar Drive", text: "Sur l'App Store ou Google Play (recherchez « Rydar Drive »)." },
    { icon: LogIn, title: "Connectez-vous", text: result.email ? `Avec ${result.email} et le mot de passe choisi.` : "Avec votre e-mail et le mot de passe choisi." },
    { icon: FileText, title: "Déposez vos documents", text: "Carte VTC, permis de conduire, pièce d'identité, assurance et carte grise : une photo suffit." },
    approved
      ? { icon: Wifi, title: "Passez EN LIGNE", text: "Vous recevez les courses proches de vous, avec votre part affichée avant d'accepter." }
      : { icon: Check, title: "Attendez la validation", text: `${result.organizationName} vérifie votre profil : vous recevrez une notification dès la validation.` },
  ];
  return (
    <div ref={ref} className="scroll-mt-4 px-5 py-8 sm:px-7">
      <div className="flex flex-col items-center text-center">
        <div className="relative mb-5 grid size-16 place-items-center">
          <span className="absolute inset-0 animate-ping-ring rounded-full border border-brand/60" />
          <span className="grid size-14 place-items-center rounded-full bg-brand text-brand-fg">
            <Check className="size-7" strokeWidth={3} />
          </span>
        </div>
        <h2 className="text-[22px] font-semibold leading-tight tracking-tight">
          {approved ? "Bienvenue, votre compte est actif" : `Candidature envoyée à ${result.organizationName}`}
        </h2>
        <p className="mt-2 max-w-sm text-[14px] leading-relaxed text-fg-muted">
          {approved
            ? `Vous faites maintenant partie du réseau ${result.organizationName}.`
            : "Merci ! La centrale étudie votre candidature. En attendant, préparez votre compte dans l'application."}
        </p>
      </div>
      <p className="mb-3 mt-8 text-[12px] font-medium uppercase tracking-[0.08em] text-fg-subtle">Prochaines étapes</p>
      <ol className="space-y-2.5">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-3 rounded-xl border border-line bg-white/[0.02] p-3.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line-strong bg-ink-700 text-brand">
              <s.icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-[14px] font-medium">
                <span className="num mr-1.5 text-fg-subtle">{i + 1}.</span>
                {s.title}
              </span>
              <span className="mt-0.5 block text-[12.5px] leading-relaxed text-fg-muted">{s.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function JoinForm({ code, organizationName, autoApprove }: { code: string; organizationName: string; autoApprove: boolean }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [category, setCategory] = useState<VehicleCategory>("standard");
  const [seats, setSeats] = useState(4);
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Extract<JoinResult, { ok: true }> | null>(null);

  if (done) return <SuccessScreen result={done} />;

  const err = (k: string) => errors[k];
  const focusFirstError = (fe: Record<string, string>) => {
    const first = FIELD_ORDER.find((k) => fe[k]);
    if (!first) return;
    const el = formRef.current?.querySelector<HTMLElement>(`[data-field="${first}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => el?.querySelector<HTMLElement>("input, textarea, button")?.focus({ preventScroll: true }), 350);
  };

  return (
    <form
      ref={formRef}
      noValidate
      className="space-y-8 px-5 py-6 sm:px-7"
      onSubmit={(e) => {
        // Soumission manuelle : les champs saisis sont conservés en cas d'erreur (pas de réinitialisation du formulaire)
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const g = (k: string) => String(f.get(k) ?? "");
        setError(null);
        start(async () => {
          const res = await applyToCentrale(code, {
            firstName: g("firstName"),
            lastName: g("lastName"),
            phone: g("phone"),
            email: g("email"),
            password: g("password"),
            vtcCardNumber: g("vtcCardNumber"),
            vehicle: { brand: g("brand"), model: g("model"), color: g("color"), plate: g("plate"), category, seats, luggageCapacity: 3 },
            message: g("message"),
            acceptTerms: (f.get("acceptTerms") === "on") as true,
            website: g("website"),
          });
          if (!res.ok) {
            const fe = res.fieldErrors ?? {};
            setErrors(fe);
            setError(res.error);
            if (Object.keys(fe).length) focusFirstError(fe);
            else formRef.current?.querySelector("[data-form-error]")?.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
          }
          setErrors({});
          setDone(res);
        });
      }}
    >
      <Section step={1} title="Vous">
        <div className="grid grid-cols-2 gap-3">
          <div data-field="firstName" className="min-w-0">
            <Field label="Prénom" error={err("firstName")}>
              <Input name="firstName" autoComplete="given-name" required maxLength={80} aria-invalid={!!err("firstName")} className={INPUT} />
            </Field>
          </div>
          <div data-field="lastName" className="min-w-0">
            <Field label="Nom" error={err("lastName")}>
              <Input name="lastName" autoComplete="family-name" required maxLength={80} aria-invalid={!!err("lastName")} className={INPUT} />
            </Field>
          </div>
        </div>
        <div data-field="phone">
          <Field label="Téléphone mobile" error={err("phone")}>
            <Input name="phone" type="tel" inputMode="tel" autoComplete="tel" required placeholder="06 12 34 56 78" aria-invalid={!!err("phone")} className={cn(INPUT, "num")} />
          </Field>
        </div>
        <div data-field="email">
          <Field label="E-mail" error={err("email")} hint="Il vous servira d'identifiant dans l'application.">
            <Input name="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" required placeholder="prenom.nom@exemple.fr" aria-invalid={!!err("email")} className={INPUT} />
          </Field>
        </div>
        <div data-field="password">
          <Field label="Mot de passe" error={err("password")} hint="10 caractères minimum.">
            <div className="relative">
              <Input
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                required
                minLength={10}
                maxLength={72}
                aria-invalid={!!err("password")}
                className={cn(INPUT, "pr-11")}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-fg-subtle hover:bg-white/5 hover:text-fg"
                aria-label={showPassword ? "Masquer le mot de passe" : "Afficher le mot de passe"}
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </Field>
        </div>
      </Section>

      <Section step={2} title="Carte VTC">
        <div data-field="vtcCardNumber">
          <Field label="Numéro de carte professionnelle" optional error={err("vtcCardNumber")} hint="Inscrit sur votre carte VTC — accélère la validation.">
            <Input name="vtcCardNumber" autoCapitalize="characters" maxLength={40} placeholder="EVTC 075 18 000123" aria-invalid={!!err("vtcCardNumber")} className={cn(INPUT, "num")} />
          </Field>
        </div>
      </Section>

      <Section step={3} title="Votre véhicule">
        <div className="grid grid-cols-2 gap-3">
          <div data-field="vehicle.brand" className="min-w-0">
            <Field label="Marque" optional error={err("vehicle.brand")}>
              <Input name="brand" maxLength={40} placeholder="Toyota" aria-invalid={!!err("vehicle.brand")} className={INPUT} />
            </Field>
          </div>
          <div data-field="vehicle.model" className="min-w-0">
            <Field label="Modèle" error={err("vehicle.model")}>
              <Input name="model" required maxLength={60} placeholder="Prius+" aria-invalid={!!err("vehicle.model")} className={INPUT} />
            </Field>
          </div>
          <div data-field="vehicle.color" className="min-w-0">
            <Field label="Couleur" optional error={err("vehicle.color")}>
              <Input name="color" maxLength={40} placeholder="Noir" aria-invalid={!!err("vehicle.color")} className={INPUT} />
            </Field>
          </div>
          <div data-field="vehicle.plate" className="min-w-0">
            <Field label="Plaque" error={err("vehicle.plate")}>
              <Input name="plate" required maxLength={12} autoCapitalize="characters" placeholder="AB-123-CD" aria-invalid={!!err("vehicle.plate")} className={cn(INPUT, "num uppercase placeholder:normal-case")} />
            </Field>
          </div>
        </div>
        <div data-field="vehicle.category">
          <p className="mb-1.5 text-[12.5px] font-medium text-fg-muted">Catégorie</p>
          <div role="radiogroup" aria-label="Catégorie du véhicule" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {VEHICLE_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={category === c}
                onClick={() => {
                  setCategory(c);
                  setSeats((s) => (c === "van" ? Math.max(s, 7) : s > 4 && category === "van" ? 4 : s));
                }}
                className={cn("min-w-0 rounded-xl border px-3 py-2.5 text-left transition-colors", category === c ? "border-brand/60 bg-brand/[0.08]" : "border-line hover:border-line-strong")}
              >
                <span className={cn("block truncate text-[13px] font-semibold", category === c ? "text-brand" : "text-fg")}>{VEHICLE_CATEGORY_META[c].label}</span>
                <span className="block truncate text-[11px] text-fg-subtle">{VEHICLE_CATEGORY_META[c].description.split(",")[0]}</span>
              </button>
            ))}
          </div>
          {err("vehicle.category") && <p className="mt-1.5 text-xs text-red">{err("vehicle.category")}</p>}
        </div>
        <div data-field="vehicle.seats" className="flex items-center justify-between gap-4 rounded-xl border border-line px-3.5 py-2.5">
          <span>
            <span className="block text-[13px] font-medium">Places passagers</span>
            <span className="block text-[11.5px] text-fg-subtle">Hors chauffeur</span>
          </span>
          <span className="flex items-center gap-1 rounded-lg border border-line-strong bg-ink-850 p-1">
            <button type="button" onClick={() => setSeats((s) => Math.max(1, s - 1))} className="grid size-9 place-items-center rounded-md text-fg-muted hover:bg-white/5" aria-label="Une place de moins">
              <Minus className="size-4" />
            </button>
            <span className="num w-7 text-center text-[16px] font-semibold" aria-live="polite">{seats}</span>
            <button type="button" onClick={() => setSeats((s) => Math.min(8, s + 1))} className="grid size-9 place-items-center rounded-md text-fg-muted hover:bg-white/5" aria-label="Une place de plus">
              <Plus className="size-4" />
            </button>
          </span>
        </div>
      </Section>

      <Section step={4} title="Un mot pour la centrale" hint="optionnel">
        <div data-field="message">
          <Field error={err("message")}>
            <Textarea name="message" maxLength={1000} className="text-base sm:text-sm" placeholder="Disponibilités, secteurs, expérience, langues parlées…" aria-label="Message pour la centrale" />
          </Field>
        </div>
      </Section>

      {/* Piège à robots : invisible pour les humains */}
      <div aria-hidden className="sr-only">
        <label>
          Site web
          <input name="website" type="text" tabIndex={-1} autoComplete="off" />
        </label>
      </div>

      <div className="space-y-4">
        <div data-field="acceptTerms">
          <label className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 text-[13px] leading-relaxed", err("acceptTerms") ? "border-red/50 bg-red/[0.05]" : "border-line")}>
            <input type="checkbox" name="acceptTerms" className="mt-0.5 size-[18px] shrink-0 accent-[var(--color-brand)]" aria-invalid={!!err("acceptTerms")} />
            <span className="text-fg-muted">
              J&apos;accepte les conditions d&apos;utilisation de Rydar Drive et la transmission de mes informations à <span className="text-fg">{organizationName}</span> pour
              l&apos;étude de ma candidature.
            </span>
          </label>
          {err("acceptTerms") && <p className="mt-1.5 text-xs text-red">{err("acceptTerms")}</p>}
        </div>

        {error && (
          <p data-form-error role="alert" className="flex items-start gap-2 rounded-xl border border-red/30 bg-red/[0.08] px-3.5 py-3 text-[13px] text-red">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}

        <Button type="submit" variant="primary" size="xl" className="w-full" loading={pending}>
          {autoApprove ? "Créer mon compte chauffeur" : "Envoyer ma candidature"}
        </Button>
        <p className="text-center text-[12px] leading-relaxed text-fg-subtle">
          Vos documents (carte VTC, permis, pièce d&apos;identité, assurance, carte grise) se déposent ensuite dans l&apos;application.
        </p>
      </div>
    </form>
  );
}
