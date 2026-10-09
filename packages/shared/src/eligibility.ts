// Test d'éligibilité « Flotte Privée » (eligibilite.<domaine>) : questions, score, verdict, simulateur de gains,
// validation du formulaire. Le résultat est enregistré comme demande de contact (sujet « eligibility »,
// /admin/contacts) : aucune table dédiée. Textes en tutoiement (comme les publicités qui mènent à la page).
import { z } from "zod";
import { normalizePhone } from "./format";

// -----------------------------------------------------------------------------
// Questions (étape 1)
// -----------------------------------------------------------------------------
export const ELIGIBILITY_REVENUES = ["lt2k", "2k-4k", "4k-7k", "gt7k"] as const;
export const ELIGIBILITY_BUDGETS = ["none", "150-300", "300-800", "gt800"] as const;
export const ELIGIBILITY_ZONES = ["idf", "metropole", "ville", "rural"] as const;
export type EligibilityRevenue = (typeof ELIGIBILITY_REVENUES)[number];
export type EligibilityBudget = (typeof ELIGIBILITY_BUDGETS)[number];
export type EligibilityZone = (typeof ELIGIBILITY_ZONES)[number];

type Option<T extends string> = { value: T; label: string; points: number };

export const ELIGIBILITY_QUESTIONS = {
  revenue: {
    title: "Ton chiffre d’affaires VTC, par mois ?",
    options: [
      { value: "lt2k", label: "Moins de 2 000 €", points: 0 },
      { value: "2k-4k", label: "2 000 à 4 000 €", points: 1 },
      { value: "4k-7k", label: "4 000 à 7 000 €", points: 2 },
      { value: "gt7k", label: "Plus de 7 000 €", points: 3 },
    ] satisfies Option<EligibilityRevenue>[],
  },
  budget: {
    title: "Quel budget publicité tu peux sortir chaque mois ?",
    options: [
      { value: "none", label: "Rien pour l’instant", points: 0 },
      { value: "150-300", label: "150 à 300 €", points: 1 },
      { value: "300-800", label: "300 à 800 €", points: 2 },
      { value: "gt800", label: "Plus de 800 €", points: 3 },
    ] satisfies Option<EligibilityBudget>[],
  },
  zone: {
    title: "Tu roules où ?",
    options: [
      { value: "idf", label: "Île‑de‑France", points: 3 },
      { value: "metropole", label: "Grande métropole", points: 2 },
      { value: "ville", label: "Ville moyenne", points: 1 },
      { value: "rural", label: "Zone rurale", points: 0 },
    ] satisfies Option<EligibilityZone>[],
  },
} as const;

export type EligibilityAnswers = { revenue: EligibilityRevenue; budget: EligibilityBudget; zone: EligibilityZone };
export type EligibilityVerdict = "eligible" | "to_discuss" | "not_yet";

const points = <K extends keyof typeof ELIGIBILITY_QUESTIONS>(k: K, v: string) =>
  (ELIGIBILITY_QUESTIONS[k].options as readonly { value: string; points: number }[]).find((o) => o.value === v)?.points ?? 0;
export const optionLabel = <K extends keyof typeof ELIGIBILITY_QUESTIONS>(k: K, v: string) =>
  (ELIGIBILITY_QUESTIONS[k].options as readonly { value: string; label: string }[]).find((o) => o.value === v)?.label ?? v;

/** Score sur 9 et verdict : sans budget publicité, pas encore ; sinon éligible à partir de 5 points. */
export function eligibilityVerdict(a: EligibilityAnswers): { score: number; max: number; verdict: EligibilityVerdict } {
  const score = points("revenue", a.revenue) + points("budget", a.budget) + points("zone", a.zone);
  const verdict: EligibilityVerdict = a.budget === "none" ? "not_yet" : score >= 5 ? "eligible" : "to_discuss";
  return { score, max: 9, verdict };
}

export const ELIGIBILITY_VERDICT_META: Record<EligibilityVerdict, { title: string; text: string; tone: "brand" | "amber" | "muted" }> = {
  eligible: {
    title: "Ton profil est éligible",
    text: "Avec ton activité, ton budget et ta zone, Flotte Privée peut t’amener tes propres clients. Notre équipe te rappelle pour réserver ta place parmi les 15.",
    tone: "brand",
  },
  to_discuss: {
    title: "Éligible, avec une stratégie adaptée",
    text: "Ton profil peut fonctionner avec une stratégie taillée pour ta zone et ton budget. Notre équipe te rappelle pour étudier ton cas ensemble.",
    tone: "amber",
  },
  not_yet: {
    title: "Pas encore… mais bientôt",
    text: "Sans budget publicité, les pubs ne peuvent pas encore t’amener de clients. On garde ton contact et on te prévient dès que tu peux démarrer : 150 € par mois suffisent pour commencer.",
    tone: "muted",
  },
};

// -----------------------------------------------------------------------------
// Simulateur (hypothèses affichées sur la page : simulation indicative, aucun résultat garanti)
// -----------------------------------------------------------------------------
export const SIMULATOR = {
  /** Budget publicité mensuel (€). */
  budget: { min: 150, max: 2000, step: 50, default: 600 },
  /** Course moyenne d'une centrale (réservation directe, €). */
  fare: { min: 40, max: 80, step: 1, default: 57, rangeLabel: "55 à 60 €" },
  /** Part des visiteurs (clics) qui réservent. */
  conversion: { min: 0.1, max: 0.35, step: 0.01, default: 0.25 },
  /** Coût moyen d'un clic publicitaire (hypothèse, €). */
  cpc: 2.5,
  /** Applis de VTC : course moyenne (15 à 22 €) et commission prélevée (jusqu'à 25 %). */
  app: { fare: 18.5, rangeLabel: "15 à 22 €", commission: 0.25 },
} as const;

export type SimulationInput = { budget: number; fare?: number; conversion?: number; cpc?: number };
export type Simulation = {
  clicks: number;
  bookings: number;
  revenue: number;
  /** Chiffre d'affaires moins le budget publicité. */
  net: number;
  /** Chiffre d'affaires pour 1 € de publicité. */
  roi: number;
  /** Courses d'appli nécessaires pour garder le même montant (course moyenne d'appli, commission déduite). */
  appRides: number;
};

export function simulate({ budget, fare = SIMULATOR.fare.default, conversion = SIMULATOR.conversion.default, cpc = SIMULATOR.cpc }: SimulationInput): Simulation {
  const b = Math.max(0, budget);
  const clicks = Math.floor(b / cpc);
  const bookings = Math.round(clicks * conversion);
  const revenue = bookings * fare;
  const net = revenue - b;
  const perAppRide = SIMULATOR.app.fare * (1 - SIMULATOR.app.commission);
  return { clicks, bookings, revenue, net, roi: b > 0 ? revenue / b : 0, appRides: net > 0 ? Math.ceil(net / perAppRide) : 0 };
}

/** Budget mensuel retenu pour la simulation du résultat quand le simulateur n'a pas été touché. */
export const BUDGET_FOR_ANSWER: Record<EligibilityBudget, number> = { none: 0, "150-300": 250, "300-800": 550, gt800: 1000 };

// -----------------------------------------------------------------------------
// Validation (étape 2 : coordonnées)
// -----------------------------------------------------------------------------
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u{2028}\u{2029}]/u;
const clean = (max: number, required: string) =>
  z
    .string({ error: required })
    .trim()
    .min(1, required)
    .max(max, `${max} caractères maximum`)
    .refine((v) => !CONTROL.test(v), "Caractères non autorisés");

export const ELIGIBILITY_LIMITS = { name: 120, email: 254, phone: 40, city: 80 } as const;

export const eligibilitySchema = z.object({
  revenue: z.enum(ELIGIBILITY_REVENUES, { error: "Choisis une réponse" }),
  budget: z.enum(ELIGIBILITY_BUDGETS, { error: "Choisis une réponse" }),
  zone: z.enum(ELIGIBILITY_ZONES, { error: "Choisis une réponse" }),
  name: clean(ELIGIBILITY_LIMITS.name, "Indique ton prénom et ton nom").refine((v) => Array.from(v).length >= 2, "2 caractères minimum"),
  phone: z
    .string({ error: "Indique ton numéro de téléphone" })
    .trim()
    .min(1, "Indique ton numéro de téléphone")
    .max(ELIGIBILITY_LIMITS.phone, `${ELIGIBILITY_LIMITS.phone} caractères maximum`)
    .transform((value, ctx) => {
      const e164 = normalizePhone(value);
      if (!e164) {
        ctx.addIssue({ code: "custom", message: "Numéro de téléphone invalide" });
        return z.NEVER;
      }
      return e164;
    }),
  email: z
    .string({ error: "Indique ton adresse e-mail" })
    .trim()
    .min(1, "Indique ton adresse e-mail")
    .max(ELIGIBILITY_LIMITS.email, `${ELIGIBILITY_LIMITS.email} caractères maximum`)
    .toLowerCase()
    .pipe(z.email("Adresse e-mail invalide")),
  city: z
    .string()
    .trim()
    .max(ELIGIBILITY_LIMITS.city, `${ELIGIBILITY_LIMITS.city} caractères maximum`)
    .refine((v) => !CONTROL.test(v), "Caractères non autorisés")
    .nullish()
    .transform((v) => v || undefined),
  consent: z.literal(true, { error: "Coche la case pour qu’on puisse te recontacter" }),
  /** Budget choisi dans le simulateur (indicatif) : ignoré s'il est invalide. */
  simBudget: z.number().int().min(0).max(100_000).optional().catch(undefined),
});
export type EligibilityInput = z.input<typeof eligibilitySchema>;
export type EligibilityData = z.output<typeof eligibilitySchema>;

/** Texte enregistré dans la demande de contact (lu dans /admin/contacts). */
export function eligibilityMessage(d: EligibilityData): string {
  const { score, max, verdict } = eligibilityVerdict(d);
  const lines = [
    `Test d’éligibilité Flotte Privée — ${ELIGIBILITY_VERDICT_META[verdict].title} (score ${score}/${max})`,
    "",
    `Chiffre d’affaires VTC par mois : ${optionLabel("revenue", d.revenue)}`,
    `Budget publicité par mois : ${optionLabel("budget", d.budget)}`,
    `Zone : ${optionLabel("zone", d.zone)}${d.city ? ` — ${d.city}` : ""}`,
  ];
  if (d.simBudget) lines.push(`Budget testé dans le simulateur : ${d.simBudget} € par mois`);
  return lines.join("\n");
}
