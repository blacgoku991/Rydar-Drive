// Carte « Partager mes courses non prises » : exemple chiffré aux VRAIS taux de l'organisation (networkShareExample,
// miroir exact de private.network_terms) et délai de recherche annoncé. Module pur (tests : example.test.ts).
import { DEFAULT_DISPATCH_RADII_M, formatPrice, networkShareExample, type NetworkTermsGiverInput } from "@rydar/shared";

const NB = " ";

export interface ShareExampleText {
  priceCents: number;
  /** « Course de 50 € payée à bord → le chauffeur vous reverse 12,50 € » */
  onBoard: string | null;
  /** « Course de 50 € déjà payée → vous lui versez 37,50 € » */
  prepaid: string | null;
  /** Part du chauffeur nulle avec ces taux : la course ne serait pas proposée */
  none: string | null;
  /** Montants bruts (tests, aperçu) */
  amounts: { onBoardCents: number | null; prepaidCents: number | null };
}

/** Exemple chiffré pour une course de `priceCents` (50 € par défaut). */
export function shareExampleText(giver: NetworkTermsGiverInput, currency = "EUR", priceCents = 5_000): ShareExampleText {
  const ex = networkShareExample(giver, priceCents);
  const price = formatPrice(priceCents, currency);
  return {
    priceCents,
    onBoard: ex.onBoard ? `Course de ${price} payée à bord → le chauffeur vous reverse ${formatPrice(ex.onBoard.amount_cents, currency)}` : null,
    prepaid: ex.prepaid ? `Course de ${price} déjà payée → vous lui versez ${formatPrice(ex.prepaid.amount_cents, currency)}` : null,
    none:
      !ex.onBoard && !ex.prepaid
        ? `Avec vos taux actuels, une course de ${price} ne laisse rien au chauffeur${NB}: elle ne serait pas proposée au réseau.`
        : null,
    amounts: { onBoardCents: ex.onBoard?.amount_cents ?? null, prepaidCents: ex.prepaid?.amount_cents ?? null },
  };
}

/**
 * Délai ajouté quand un partenaire est proche : une vague réseau par rayon du premier passage de l'organisation
 * (dispatch_radii_m), chacune pendant offer_timeout_seconds (paramètres fixes de la v1, spec §6.1).
 */
export function networkSearchExtraSeconds(radii: readonly number[] | null | undefined, offerTimeoutSeconds: number | null | undefined): number {
  const waves = radii?.length ? radii.length : DEFAULT_DISPATCH_RADII_M.length;
  const timeout = offerTimeoutSeconds && offerTimeoutSeconds > 0 ? offerTimeoutSeconds : 30;
  return waves * timeout;
}

/** « la recherche peut durer 2 min de plus quand un partenaire est proche » */
export function networkSearchDelayText(radii: readonly number[] | null | undefined, offerTimeoutSeconds: number | null | undefined): string {
  const s = networkSearchExtraSeconds(radii, offerTimeoutSeconds);
  const span = s < 60 ? `${s}${NB}s` : `${Math.ceil(s / 60)}${NB}min`;
  return `La recherche peut durer ${span} de plus quand un partenaire est proche.`;
}
