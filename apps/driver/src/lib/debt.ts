// Commissions encore dues à la centrale, rappelées avant la suppression du compte. Module sans dépendance native
// (debt.test.ts).
import { formatPrice, type DriverDeletionDebt, type DriverSettlements } from "@rydar/shared";

export type OpenDebt = { cents: number; declaredCents: number; currency: string; organization: string | null };

/**
 * Montant qui reste dû à la centrale après la suppression du compte : commissions à régler, contestées, ou signalées
 * payées mais pas encore confirmées — même périmètre que private.driver_open_debt (migration 20260924004800), tant
 * qu'il en reste les empreintes du chauffeur sont gardées (private.debtor_identities). Montants lus par
 * driver_deletion_debt ou l'aperçu de la suppression (tout état du compte). null : rien de dû.
 */
export function openDebt(d: DriverDeletionDebt | null | undefined): OpenDebt | null {
  const owed = Math.max(0, Number(d?.owed_cents) || 0);
  const declared = Math.max(0, Number(d?.declared_cents) || 0);
  if (!d || owed + declared <= 0) return null;
  return { cents: owed + declared, declaredCents: declared, currency: d.currency || "EUR", organization: d.organization || null };
}

/** Mêmes montants tirés du relevé des commissions (serveur antérieur à driver_deletion_debt : chauffeur actif seulement). */
export function debtFromSettlements(s: Pick<DriverSettlements, "currency" | "organization" | "summary"> | null | undefined): DriverDeletionDebt | null {
  if (!s) return null;
  return {
    owed_cents: s.summary?.owed_cents ?? 0,
    declared_cents: s.summary?.declared_cents ?? 0,
    currency: s.currency,
    organization: s.organization?.name ?? null,
  };
}

/** Avertissement avant la suppression (il ne l'empêche pas) : titre, texte de l'écran, ajout à la confirmation. */
export function openDebtNotice(d: OpenDebt): { title: string; message: string; confirm: string } {
  const amount = formatPrice(d.cents, d.currency);
  const org = d.organization ?? "votre centrale";
  const declared =
    d.declaredCents <= 0
      ? ""
      : d.declaredCents >= d.cents
        ? "Paiement signalé, en attente de confirmation par la centrale. "
        : `Dont ${formatPrice(d.declaredCents, d.currency)} signalés payés, en attente de confirmation par la centrale. `;
  return {
    title: `Commissions dues : ${amount}`,
    message:
      `${declared}Supprimer votre compte n'efface pas cette dette : elle reste due à ${org}. Tant qu'une somme reste due, ` +
      "des empreintes (hachages) de votre téléphone, de votre e-mail et de votre carte VTC sont conservées pour la centrale, puis effacées.",
    confirm: `Les commissions dues (${amount}) restent à régler à ${org}.`,
  };
}
