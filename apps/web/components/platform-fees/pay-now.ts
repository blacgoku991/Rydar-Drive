// Montant principal des frais Rydar (docs/REFONTE-PANELS.md, R9) : UNE phrase, la même sur la carte (Encaissements d'une
// centrale, « Frais Rydar » d'une flotte), le bandeau du tableau de bord et la fenêtre « J'ai payé » :
//   • « À payer maintenant : 85 € · en retard depuis 4 jours » (rouge) : échu, non couvert par un paiement déclaré ;
//   • sinon « À régler avant le 5 nov. : 235 € » (ambre) : ce qui reste à régler d'ici la prochaine échéance ;
//   • sinon « Rien à régler » (vert).
// En petit : « Solde : 330 € » (jamais en rouge : le solde comprend des frais pas encore échus) et « Déjà déclaré 10 €,
// Rydar doit confirmer ». Tout part des montants déjà lus (private.platform_account) : échéances, blocage et montant du
// lien de paiement restent calculés en base, rien n'est recalculé ici.
// Module pur : ni « use client » ni « server-only » (testé : pay-now.test.ts).
import { dateTimeFormat, formatPrice, type PlatformAccount } from "@rydar/shared";

const NB = " ";

export type PayNowAccount = Pick<
  PlatformAccount,
  "balance_cents" | "due_cents" | "declared_cents" | "next_due_cents" | "next_due_at" | "days_overdue" | "blocked"
> & { currency?: string };

export type PayNow = {
  /** now : à payer maintenant ; before : à régler avant la prochaine échéance ; nothing : rien à régler */
  kind: "now" | "before" | "nothing";
  /** « À payer maintenant », « À régler avant le 5 nov. », « Rien à régler » */
  label: string;
  /** Montant principal (centimes) ; null : rien à régler */
  amountCents: number | null;
  /** « 85 € » ; null : rien à régler */
  amount: string | null;
  /** « en retard depuis 4 jours », « échéance dépassée aujourd'hui » ; null sinon */
  detail: string | null;
  /** Phrase complète, identique partout : « À payer maintenant : 85 € · en retard depuis 4 jours » */
  text: string;
  tone: "red" | "amber" | "green";
  /** « Solde : 330 € », « Avance en votre faveur : 20 € », « Solde : 0 € » */
  balance: string;
  /** Le solde répète le montant principal (tout est à régler à la prochaine échéance) : omis par payNowDetails */
  balanceRepeats: boolean;
  /** « Déjà déclaré 10 €, Rydar doit confirmer » ; null : aucun paiement en attente */
  declared: string | null;
  /** À payer maintenant : part de la prochaine échéance en plus (« Prochaine échéance : 5 nov. · 235 € ») ; null sinon */
  next: string | null;
  /** Création de courses suspendue par Rydar (retard au-delà du seuil) */
  blocked: boolean;
};

/** « 5 nov. » dans le fuseau de l'organisation (formateur mémorisé). */
function shortDate(iso: string, timeZone: string) {
  return dateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone }).format(new Date(iso));
}

const days = (n: number) => `${n} jour${n > 1 ? "s" : ""}`;

/**
 * Montant principal et phrases des frais Rydar. `now` : horloge de l'écran — une page restée ouverte après la prochaine
 * échéance montre ce montant « à payer maintenant » sans attendre la relecture.
 */
export function payNowSummary(a: PayNowAccount, now: number, timeZone = "Europe/Paris"): PayNow {
  const cur = a.currency || "EUR";
  const price = (cents: number) => formatPrice(cents, cur);
  const declaredCents = Math.max(0, a.declared_cents || 0);
  const dueCents = Math.max(0, a.due_cents || 0);
  const blocked = !!a.blocked;
  const nextAt = a.next_due_at ? Date.parse(a.next_due_at) : Number.NaN;
  // Cumul à régler d'ici la prochaine échéance (échu compris, private.platform_position), moins ce qui est déclaré
  const beforeCents = Math.max(0, (a.next_due_cents || 0) - declaredCents);

  const balanceCents = a.balance_cents || 0;
  const balance = balanceCents < 0 ? `Avance en votre faveur${NB}: ${price(-balanceCents)}` : `Solde${NB}: ${price(balanceCents)}`;
  const declared = declaredCents > 0 ? `Déjà déclaré ${price(declaredCents)}, Rydar doit confirmer` : null;

  // Échu non couvert par une déclaration ; création de courses suspendue malgré une déclaration (déclaration de plus de
  // 7 jours ou refusée récemment, private.platform_position) : tout l'échu reste à payer
  let nowCents = Math.max(0, dueCents - declaredCents);
  if (!nowCents && blocked) nowCents = dueCents;
  let detail: string | null = nowCents > 0 ? (a.days_overdue > 0 ? `en retard depuis ${days(a.days_overdue)}` : "échéance dépassée aujourd'hui") : null;
  let next: string | null = null;
  if (nowCents > 0) {
    // Part qui tombe à la prochaine échéance, en plus de l'échu
    const coming = Math.max(0, (a.next_due_cents || 0) - dueCents);
    if (a.next_due_at && Number.isFinite(nextAt) && nextAt > now && coming > 0) {
      next = `Prochaine échéance${NB}: ${shortDate(a.next_due_at, timeZone)} · ${price(coming)}`;
    }
  } else if (a.next_due_at && Number.isFinite(nextAt) && nextAt <= now && beforeCents > 0) {
    // Page restée ouverte après l'échéance : le montant est maintenant dû
    nowCents = beforeCents;
    detail = "échéance dépassée aujourd'hui";
  }

  if (nowCents > 0) {
    const amount = price(nowCents);
    return {
      kind: "now",
      label: "À payer maintenant",
      amountCents: nowCents,
      amount,
      detail,
      text: `À payer maintenant${NB}: ${amount}${detail ? ` · ${detail}` : ""}`,
      tone: "red",
      balance,
      balanceRepeats: balanceCents === nowCents,
      declared,
      next,
      blocked,
    };
  }
  if (a.next_due_at && Number.isFinite(nextAt) && beforeCents > 0) {
    const label = `À régler avant le ${shortDate(a.next_due_at, timeZone)}`;
    const amount = price(beforeCents);
    return {
      kind: "before",
      label,
      amountCents: beforeCents,
      amount,
      detail: null,
      text: `${label}${NB}: ${amount}`,
      tone: "amber",
      balance,
      balanceRepeats: balanceCents === beforeCents,
      declared,
      next: null,
      blocked,
    };
  }
  return {
    kind: "nothing",
    label: "Rien à régler",
    amountCents: null,
    amount: null,
    detail: null,
    text: "Rien à régler",
    tone: "green",
    balance,
    balanceRepeats: false,
    declared,
    next: null,
    blocked,
  };
}

/**
 * Ligne en petit sous le montant principal (carte, relevé, fenêtre « J'ai payé », page suspendue) : prochaine échéance
 * (si `withNext`), solde, paiement déclaré. Le solde est omis quand il répète le montant principal.
 */
export function payNowDetails(pay: Pick<PayNow, "next" | "balance" | "balanceRepeats" | "declared">, withNext = true): string {
  return [withNext ? pay.next : null, pay.balanceRepeats ? null : pay.balance, pay.declared].filter(Boolean).join(" · ");
}

/**
 * Aide du bouton « Payer en ligne » : le montant du lien de paiement est calculé en base (échu, sinon solde), sans tenir
 * compte des paiements déjà déclarés. S'il diffère du montant principal, on dit lequel indiquer :
 * « La page de paiement propose 95 € : indiquez 85 € (10 € déjà déclarés). »
 */
export function payLinkHint(linkCents: number, pay: Pick<PayNow, "amountCents">, declaredCents: number, currency = "EUR"): string | null {
  const main = pay.amountCents;
  if (!main || !(linkCents > 0) || linkCents === main) return null;
  const already = declaredCents > 0 ? ` (${formatPrice(declaredCents, currency)} déjà déclarés)` : "";
  return `La page de paiement propose ${formatPrice(linkCents, currency)}${NB}: indiquez ${formatPrice(main, currency)}${already}.`;
}
