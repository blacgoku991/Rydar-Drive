import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Éditeur et hébergeurs, affichés par les pages légales publiques (mentions légales, confidentialité, CGU, CGV,
 * cookies, accord de traitement, suppression de compte). Source : table platform_legal, que le super admin
 * renseigne dans /admin/legal. Repli sur les variables du serveur LEGAL_NAME, LEGAL_EMAIL et LEGAL_ADDRESS.
 */
export type LegalInfo = {
  /** Raison sociale (« Rydar SAS ») */
  name: string;
  /** Forme juridique (« SAS ») */
  form: string;
  /** Capital social (« 1 000 € ») */
  capital: string;
  /** Adresse du siège */
  address: string;
  /** Immatriculation (« RCS Paris 912 345 678 ») */
  registration: string;
  /** N° de TVA intracommunautaire */
  vat: string;
  /** Directeur de la publication */
  director: string;
  /** Contact général */
  email: string;
  phone: string;
  /** Contact « données personnelles » (repli : contact général) */
  privacyEmail: string;
  /** Hébergeur du site (serveur applicatif) */
  hostName: string;
  hostAddress: string;
  hostPhone: string;
  /** Hébergeur des données (base de données, fichiers) */
  dataHost: string;
  /** Raison sociale réellement renseignée (/admin/legal ou LEGAL_NAME) : sinon `name` vaut le nom du service par défaut */
  nameSet: boolean;
  /** Au moins l'éditeur et un contact renseignés */
  complete: boolean;
};

type Row = Partial<Record<
  | "company_name" | "legal_form" | "share_capital" | "address" | "registration" | "vat_number" | "publication_director"
  | "email" | "phone" | "privacy_email" | "host_name" | "host_address" | "host_phone" | "data_host",
  string | null
>>;

/** Informations de l'éditeur (une lecture par requête). */
export const getLegalInfo = cache(async (): Promise<LegalInfo> => {
  let row: Row = {};
  try {
    const { data } = await createAdminClient().rpc("public_legal_info");
    row = (data ?? {}) as Row;
  } catch {
    // Base injoignable : variables du serveur
  }
  const setName = row.company_name || process.env.LEGAL_NAME || "";
  const name = setName || "Rydar Drive";
  const email = row.email || process.env.LEGAL_EMAIL || "";
  return {
    name,
    form: row.legal_form || "",
    capital: row.share_capital || "",
    address: row.address || process.env.LEGAL_ADDRESS || "",
    registration: row.registration || "",
    vat: row.vat_number || "",
    director: row.publication_director || "",
    email,
    phone: row.phone || "",
    privacyEmail: row.privacy_email || email,
    hostName: row.host_name || "",
    hostAddress: row.host_address || "",
    hostPhone: row.host_phone || "",
    dataHost: row.data_host || "Supabase (base de données et fichiers, région Union européenne)",
    nameSet: !!setName,
    complete: !!setName && !!email,
  };
});

/**
 * Version des documents légaux (CGU, confidentialité, CGV, accord de traitement) : source unique dans
 * @rydar/shared, que l'app chauffeur compare aussi à la version acceptée. À changer quand leur contenu change de
 * façon importante : centrales, membres et chauffeurs sont alors invités à accepter la nouvelle version.
 */
export { LEGAL_VERSION } from "@rydar/shared";

/** Date de dernière mise à jour affichée sur les pages légales. */
export const LEGAL_UPDATED_AT = "27 septembre 2026";
/** Politique de confidentialité : formulaire de contact ajouté (données, finalité, destinataires, durée). */
export const PRIVACY_UPDATED_AT = "28 septembre 2026";
