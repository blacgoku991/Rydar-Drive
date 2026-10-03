/**
 * Mentions légales obligatoires de l'éditeur (pure, testable) : ce qui manque dans /admin/legal et ce que la page
 * publique /mentions-legales affiche « à compléter ». Références : LCEN (loi n° 2004-575) art. 1-1 (ancien art. 6-III,
 * renuméroté par la loi SREN du 21 mai 2024), sanction art. 1-2 ; LCEN art. 19 (e-mail, TVA) ; Code de commerce
 * R123-237 (forme juridique, capital, immatriculation sur les sites internet).
 * Aucune valeur n'est jamais inventée ici : seulement des contrôles de présence.
 */

export type LegalNoticeFields = {
  /** Raison sociale réellement renseignée (vide = non renseignée, jamais le nom du service) */
  companyName: string;
  form: string;
  capital: string;
  address: string;
  registration: string;
  vat: string;
  director: string;
  email: string;
  phone: string;
  hostName: string;
  hostAddress: string;
  hostPhone: string;
  dataHost: string;
};

export type LegalNoticeGap = {
  /** Champ de /admin/legal concerné */
  key: "company_name" | "legal_form" | "share_capital" | "address" | "registration" | "vat_number" | "publication_director" | "email" | "phone" | "host_name" | "host_address" | "host_phone" | "data_host";
  label: string;
  /** false : recommandé (exactitude de la politique de confidentialité), pas exigé par la LCEN */
  required: boolean;
};

/**
 * Entreprise individuelle (EI, EIRL, micro-entreprise) : pas de capital social. Reconnue d'après la forme juridique
 * saisie ; une forme vide ou inconnue est traitée comme une société (capital demandé).
 */
export function isIndividualBusiness(form: string): boolean {
  return /(^|[^a-z])(e\.?\s?i\.?|eirl|entrepreneur|entreprise individuelle|micro[- ]?entreprise|auto[- ]?entrepreneur)([^a-z]|$)/i.test(form.trim());
}

/** Le capital social est exigé pour une société, pas pour une entreprise individuelle. */
export function capitalRequired(form: string): boolean {
  return !isIndividualBusiness(form);
}

const blank = (v: string) => !v.trim();

/** Mentions manquantes, dans l'ordre du formulaire de /admin/legal. */
export function legalNoticeGaps(f: LegalNoticeFields): LegalNoticeGap[] {
  const gaps: LegalNoticeGap[] = [];
  const need = (missing: boolean, key: LegalNoticeGap["key"], label: string, required = true) => {
    if (missing) gaps.push({ key, label, required });
  };
  need(blank(f.companyName), "company_name", "Raison sociale (ou nom et prénom de l'entrepreneur individuel)");
  need(blank(f.form), "legal_form", "Forme juridique (SAS, SARL, EI…)");
  need(blank(f.capital) && capitalRequired(f.form), "share_capital", "Capital social (société)");
  need(blank(f.address), "address", "Adresse du siège");
  need(blank(f.registration), "registration", "Immatriculation (RCS et ville, ou SIREN)");
  need(blank(f.vat), "vat_number", "N° de TVA intracommunautaire (ou « TVA non applicable, art. 293 B du CGI »)");
  need(blank(f.director), "publication_director", "Directeur de la publication");
  need(blank(f.email), "email", "E-mail de contact (aussi point de contact du règlement sur les services numériques)");
  need(blank(f.phone), "phone", "Téléphone de l'éditeur");
  need(blank(f.hostName), "host_name", "Hébergeur du site : nom ou raison sociale");
  need(blank(f.hostAddress), "host_address", "Hébergeur du site : adresse");
  need(blank(f.hostPhone), "host_phone", "Hébergeur du site : téléphone");
  need(blank(f.dataHost), "data_host", "Hébergement des données : lieu (pays du datacenter), cité par la politique de confidentialité", false);
  return gaps;
}
