// Chronologie d'une course dans les mots du métier (docs/REFONTE-PANELS.md, lot R7) : un libellé par TYPE d'événement
// (ride_events.type), pour l'affichage seulement. Les messages écrits en base ne changent pas (webhooks, application
// chauffeur, journal) ; type inconnu ou données insuffisantes : le message enregistré, tel quel. Module pur, testé
// (timeline-labels.test.ts). Utilisé par la fiche course (Chronologie), le panneau d'En direct et le journal du dispatch.
import { dateTimeFormat } from "@rydar/shared";

export type LabelledEvent = {
  type: string;
  message: string;
  level?: string | null;
  data?: Record<string, unknown> | null;
};

export type LabelOptions = {
  /** Flotte Privée : « réservation », « votre téléphone », « vous » (le chauffeur est le gérant) */
  privateFleet?: boolean;
  /** Fuseau de l'organisation (heures recalculées depuis les données) */
  timeZone?: string;
};

const NBSP = " ";
const DEFAULT_TZ = "Europe/Paris";

/** Messages écrits en base pour `ride.created` : source retrouvée quand les données ne la portent pas (lignes anciennes). */
const CREATED_SOURCE_BY_MESSAGE: Record<string, string> = {
  "Course reçue via l'API (site du rattacheur)": "api",
  "Course reçue via le site de réservation": "booking_site",
  "Course créée par le rattacheur": "dashboard",
};

/** « 13/10 à 11:00 » dans le fuseau de l'organisation (même forme que les messages écrits en base). */
function dayAndTime(iso: string, timeZone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const day = dateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", timeZone }).format(d);
  const time = dateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone }).format(d);
  return `${day} à ${time}`;
}

/**
 * Libellé d'un événement de la chronologie. `ride.created` selon la source (site, mini-site, tableau de bord ou, en
 * Flotte Privée, téléphone) ; étapes `dispatch.private_*` de la Flotte Privée à la deuxième personne ; quelques
 * messages écrits pour une centrale (« par la centrale ») ramenés à des mots valables pour une flotte aussi.
 */
export function timelineLabel(e: LabelledEvent, opts: LabelOptions = {}): string {
  const data = (e.data ?? {}) as Record<string, unknown>;
  const fp = opts.privateFleet === true || data.private_fleet === true;
  const tz = opts.timeZone || DEFAULT_TZ;
  switch (e.type) {
    case "ride.created": {
      const known = Object.prototype.hasOwnProperty.call(CREATED_SOURCE_BY_MESSAGE, e.message) ? CREATED_SOURCE_BY_MESSAGE[e.message] : null;
      const source = typeof data.source === "string" ? data.source : known;
      if (source === "api") return "Réservation reçue de votre site";
      if (source === "booking_site") return "Réservation reçue de votre mini-site";
      if (source === "dashboard") return fp ? "Réservation prise par téléphone" : "Course saisie au tableau de bord";
      return e.message;
    }
    case "ride.classified": {
      // Flotte Privée : message déjà écrit pour le chauffeur (« Réservation immédiate », « Réservation du 13/10 à 11:00 »)
      if (data.private_fleet === true) return e.message;
      if (data.type === "instant") return "Course immédiate";
      if (data.type === "scheduled" && typeof data.pickup_at === "string") {
        const when = dayAndTime(data.pickup_at, tz);
        if (when) return `Course planifiée${NBSP}: prise en charge le ${when}`;
      }
      return e.message;
    }
    case "dispatch.relaunched":
      return "Recherche relancée";
    case "ride.locked":
      // Écrit juste après l'acceptation retenue (verrou de la course pris) : la course est à ce chauffeur
      return "Attribution confirmée";
    case "dispatch.context":
      return typeof data.tenant === "string" && data.tenant ? `Organisation${NBSP}: ${data.tenant}` : e.message;
    case "alert.kept": {
      // « Alerte « X » : la centrale garde Karim — pas de nouvelle alerte pendant 15 min » (écrit aussi pour une flotte)
      const m = /^Alerte « (.+?) »\s*:\s*la centrale garde (.+?) — (.+)$/su.exec(e.message);
      return m ? `Alerte « ${m[1]} »${NBSP}: vous gardez ${m[2]} — ${m[3]}` : e.message;
    }
    case "ride.reassigned": {
      // « Course retirée à Karim H. (#2) par la centrale : motif — nouvelle recherche »
      const m = /^(Course retirée à .+?) par la centrale(.*)$/su.exec(e.message);
      return m ? `${m[1]}${m[2]}` : e.message;
    }
    // ---------------------------------------------------------------- Flotte Privée (réservation à confirmer)
    case "dispatch.fleet":
      // « Course proposée à la flotte — 1 chauffeur notifié » : en Flotte Privée, la seule fiche est celle du gérant
      return fp ? "Réservation à confirmer" : e.message;
    case "dispatch.private_offer": {
      const m = /réponse attendue avant (.+)$/su.exec(e.message);
      return m ? `Envoyée sur votre téléphone · réponse avant ${m[1]}` : "Envoyée sur votre téléphone";
    }
    case "dispatch.private_self":
      // Succès : réservation saisie par le chauffeur lui-même, confirmée d'office ; sinon (code d'erreur) le message
      return e.level === "success" || (e.level == null && !("code" in data)) ? "Vous l'avez prise" : e.message;
    case "dispatch.private_declined":
      return "Refusée";
    case "dispatch.private_no_driver":
      return `Non confirmée${NBSP}: votre fiche chauffeur n'est pas active`;
    case "dispatch.private_incompatible":
      return `À vérifier${NBSP}: véhicule (catégorie ou nombre de places)`;
    case "ride.taken_by_driver":
      if (!fp) return e.message;
      return data.chained === true ? "Vous l'avez prise · enchaînée après votre course en cours" : "Vous l'avez prise";
    case "offer.accepted":
      return fp ? "Vous l'avez confirmée" : e.message;
    default:
      return e.message;
  }
}
