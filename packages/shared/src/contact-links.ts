// Liens vers le formulaire de contact (/contact?sujet=…&offre=…) : sans zod, importable par les composants du site
// vitrine (en-tête, boutons) sans embarquer la validation dans chaque page (@rydar/shared/contact-links).
export const CONTACT_TOPICS = ["pricing", "question", "partnership", "other"] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

/** Paramètre d'URL « ?sujet= » → sujet (« Demander un tarif » : /contact?sujet=tarif, offre : &offre=<code>). */
export const CONTACT_TOPIC_PARAM = {
  tarif: "pricing",
  question: "question",
  partenariat: "partnership",
  autre: "other",
} as const satisfies Record<string, ContactTopic>;
export type ContactTopicParam = keyof typeof CONTACT_TOPIC_PARAM;

export const CONTACT_TOPIC_META: Record<ContactTopic, { label: string; param: ContactTopicParam }> = {
  pricing: { label: "Demande de tarif", param: "tarif" },
  question: { label: "Question sur Rydar Drive", param: "question" },
  partnership: { label: "Partenariat", param: "partenariat" },
  other: { label: "Autre demande", param: "autre" },
};

/** « ?sujet=tarif » → « pricing » ; absent ou inconnu → undefined (jamais une clé héritée comme « constructor »). */
export function contactTopicFromParam(param: string | string[] | null | undefined): ContactTopic | undefined {
  const value = (Array.isArray(param) ? param[0] : param)?.trim().toLowerCase();
  if (!value || !Object.prototype.hasOwnProperty.call(CONTACT_TOPIC_PARAM, value)) return undefined;
  return CONTACT_TOPIC_PARAM[value as ContactTopicParam];
}

/** Code d'offre accepté dans « &offre= » (même règle que la validation du formulaire). */
export const PLAN_CODE_RE = /^[a-z0-9_-]{1,40}$/;

/** Lien vers le formulaire : contactHref("pricing", "pro") → « /contact?sujet=tarif&offre=pro » (code invalide ignoré). */
export function contactHref(topic?: ContactTopic, planCode?: string | null): string {
  const params: string[] = [];
  if (topic) params.push(`sujet=${CONTACT_TOPIC_META[topic].param}`);
  const plan = planCode?.trim().toLowerCase();
  if (plan && PLAN_CODE_RE.test(plan)) params.push(`offre=${plan}`);
  return params.length ? `/contact?${params.join("&")}` : "/contact";
}
