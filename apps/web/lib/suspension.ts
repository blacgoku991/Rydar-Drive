/**
 * Suspension d'une centrale par le super admin (CGV, article 7) : fondement obligatoire (mise en demeure restée sans
 * effet pendant 8 jours au moins, urgence ou demande écrite de la centrale) et motif écrit. Le texte obtenu est
 * enregistré comme motif de la suspension (organizations.suspended_reason, journal d'audit) et montré au propriétaire
 * et aux administrateurs de la centrale (/suspended). Module pur : testé seul (suspension.test.ts).
 */
export type SuspensionBasis = { kind: "notice" | "urgent" | "request"; noticeDate?: string | null };

/** Délai minimal entre la mise en demeure et la suspension (CGV, article 7). */
export const SUSPENSION_NOTICE_DAYS = 8;
/** Longueur minimale du motif (faits reprochés, lus par la centrale). */
export const SUSPENSION_REASON_MIN = 10;

const NB = " ";
const DAY_MS = 86_400_000;

/** « 2026-09-20 » → « 20/09/2026 » (date saisie, sans fuseau). */
function frDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function suspensionReason(
  reason: string | null | undefined,
  basis: SuspensionBasis | null | undefined,
  now: Date = new Date(),
): { ok: true; text: string } | { ok: false; error: string } {
  const motive = (reason ?? "").replace(/\s+/g, " ").trim();
  if (motive.length < SUSPENSION_REASON_MIN) {
    return { ok: false, error: `Indiquez le motif de la suspension (${SUSPENSION_REASON_MIN} caractères au moins)${NB}: il est affiché à la centrale.` };
  }
  let prefix: string;
  switch (basis?.kind) {
    case "notice": {
      const iso = (basis.noticeDate ?? "").trim();
      const at = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? Date.parse(`${iso}T00:00:00Z`) : NaN;
      const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      if (!Number.isFinite(at)) return { ok: false, error: "Indiquez la date de la mise en demeure." };
      if (today - at < SUSPENSION_NOTICE_DAYS * DAY_MS) {
        return {
          ok: false,
          error: `La mise en demeure doit dater d'au moins ${SUSPENSION_NOTICE_DAYS}${NB}jours (article 7 des CGV). Sinon, choisissez «${NB}Urgence${NB}» si la situation l'exige.`,
        };
      }
      prefix = `Mise en demeure du ${frDate(iso)} restée sans effet.`;
      break;
    }
    case "urgent":
      prefix = "Suspension d'urgence.";
      break;
    case "request":
      prefix = "Suspension à la demande de la centrale.";
      break;
    default:
      return { ok: false, error: "Choisissez le fondement de la suspension (article 7 des CGV)." };
  }
  return { ok: true, text: `${prefix} ${motive}`.slice(0, 500) };
}
