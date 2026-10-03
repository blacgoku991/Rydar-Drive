// Commissions encore dues à la centrale, et sommes dues aux organisations partenaires (réseau partagé), rappelées
// avant la suppression du compte. Module sans dépendance native (debt.test.ts).
import { formatPrice, type DriverDeletionDebt, type DriverSettlements } from "@rydar/shared";

/** Dette envers une organisation partenaire (courses du réseau partagé payées à bord). */
export type NetworkDebt = { organization: string; cents: number; declaredCents: number };

/** cents : commissions dues à sa propre organisation ; network : sommes dues aux organisations partenaires (si présentes). */
export type OpenDebt = { cents: number; declaredCents: number; currency: string; organization: string | null; network?: NetworkDebt[] };

const positive = (v: unknown) => Math.max(0, Number(v) || 0);

/**
 * Montant qui reste dû à la centrale après la suppression du compte : commissions à régler, contestées, ou signalées
 * payées mais pas encore confirmées — même périmètre que private.driver_open_debt (migration 20260924004800), tant
 * qu'il en reste les empreintes du chauffeur sont gardées (private.debtor_identities). Réseau partagé : même périmètre
 * pour chaque organisation partenaire créancière (private.network_debtor_identities). Montants lus par
 * driver_deletion_debt ou l'aperçu de la suppression (tout état du compte). null : rien de dû.
 */
export function openDebt(d: DriverDeletionDebt | null | undefined): OpenDebt | null {
  if (!d) return null;
  const owed = positive(d.owed_cents);
  const declared = positive(d.declared_cents);
  const network = (d.network ?? [])
    .map((n) => ({ organization: n.organization, cents: positive(n.owed_cents) + positive(n.declared_cents), declaredCents: positive(n.declared_cents) }))
    .filter((n) => n.cents > 0);
  if (owed + declared <= 0 && network.length === 0) return null;
  const base = { cents: owed + declared, declaredCents: declared, currency: d.currency || "EUR", organization: d.organization || null };
  return network.length > 0 ? { ...base, network } : base;
}

/** Total dû (sa propre organisation + organisations partenaires) : la confirmation se redemande s'il change. */
export const debtTotal = (d: OpenDebt) => d.cents + (d.network ?? []).reduce((s, n) => s + n.cents, 0);

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
  if ((d.network ?? []).length > 0) return withNetworkDebt(d);
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

/** Courses partenaires dues (avec ou sans commissions dues à sa propre organisation) : chaque créancière listée. */
function withNetworkDebt(d: OpenDebt): { title: string; message: string; confirm: string } {
  const network = d.network ?? [];
  const total = formatPrice(debtTotal(d), d.currency);
  const own = d.cents > 0;
  const org = d.organization ?? "votre centrale";
  const list = network.map((n) => `${formatPrice(n.cents, d.currency)} à ${n.organization}`).join(", ");
  const declared = d.declaredCents + network.reduce((s, n) => s + n.declaredCents, 0);
  const lines = [
    own ? `Commissions : ${formatPrice(d.cents, d.currency)} à ${org}.` : null,
    `Courses partenaires : ${list}.`,
    declared > 0 ? `Dont ${formatPrice(declared, d.currency)} signalés payés, en attente de confirmation.` : null,
    "Supprimer votre compte n'efface pas ces sommes : elles restent dues. Tant qu'une somme reste due, des empreintes (hachages) de votre téléphone, de votre e-mail et de votre carte VTC sont conservées pour chaque organisation concernée, puis effacées.",
  ];
  return {
    title: own ? `Sommes dues : ${total}` : `Courses partenaires : ${total} dus`,
    message: lines.filter(Boolean).join(" "),
    confirm: own
      ? `Les sommes dues (${total}) restent à régler : ${formatPrice(d.cents, d.currency)} à ${org}, ${list}.`
      : `Les sommes dues aux organisations partenaires (${total}) restent à régler : ${list}.`,
  };
}
