import { describe, expect, it } from "vitest";
import { timelineLabel, type LabelledEvent } from "./timeline-labels";

const NBSP = " ";
const ev = (type: string, message: string, data: Record<string, unknown> = {}, level?: string): LabelledEvent => ({ type, message, data, level });

describe("chronologie dans les mots du métier", () => {
  it("course créée : selon la source, « réservation prise par téléphone » en Flotte Privée", () => {
    const created = (source: string) => ev("ride.created", "Course créée par le rattacheur", { source, number: 12 });
    expect(timelineLabel(created("api"))).toBe("Réservation reçue de votre site");
    expect(timelineLabel(created("booking_site"))).toBe("Réservation reçue de votre mini-site");
    expect(timelineLabel(created("dashboard"))).toBe("Course saisie au tableau de bord");
    expect(timelineLabel(created("dashboard"), { privateFleet: true })).toBe("Réservation prise par téléphone");
    expect(timelineLabel(created("api"), { privateFleet: true })).toBe("Réservation reçue de votre site");
    // Source inconnue : message enregistré
    expect(timelineLabel(created("import"))).toBe("Course créée par le rattacheur");
    // Ligne ancienne sans source dans les données : retrouvée par le message écrit en base
    expect(timelineLabel(ev("ride.created", "Course créée par le rattacheur"))).toBe("Course saisie au tableau de bord");
    expect(timelineLabel(ev("ride.created", "Course reçue via l'API (site du rattacheur)"))).toBe("Réservation reçue de votre site");
    expect(timelineLabel(ev("ride.created", "Course reçue via le site de réservation"))).toBe("Réservation reçue de votre mini-site");
    expect(timelineLabel(ev("ride.created", "Course créée par le rattacheur"), { privateFleet: true })).toBe("Réservation prise par téléphone");
  });

  it("étapes de la Flotte Privée à la deuxième personne", () => {
    const fp = { private_fleet: true };
    expect(timelineLabel(ev("dispatch.private_offer", "Proposée — réponse attendue avant 10:30", fp, "info"))).toBe(
      "Envoyée sur votre téléphone · réponse avant 10:30",
    );
    expect(timelineLabel(ev("dispatch.private_offer", "Proposée — réponse attendue avant 13/10 à 08:00", fp))).toBe(
      "Envoyée sur votre téléphone · réponse avant 13/10 à 08:00",
    );
    expect(timelineLabel(ev("dispatch.private_offer", "Autre texte", fp))).toBe("Envoyée sur votre téléphone");
    expect(timelineLabel(ev("dispatch.private_self", "Réservation saisie par le chauffeur — confirmée d'office", fp, "success"))).toBe("Vous l'avez prise");
    // Confirmation d'office impossible : le message (avec son code) reste
    const failed = "Confirmation d'office impossible (DRIVER_BUSY) — réservation proposée à confirmer";
    expect(timelineLabel(ev("dispatch.private_self", failed, { ...fp, code: "DRIVER_BUSY" }, "warning"))).toBe(failed);
    expect(timelineLabel(ev("dispatch.private_declined", "Réservation refusée par le chauffeur", fp, "warning"))).toBe("Refusée");
    expect(timelineLabel(ev("dispatch.private_no_driver", "Aucune fiche chauffeur active", fp, "error"))).toBe(
      `Non confirmée${NBSP}: votre fiche chauffeur n'est pas active`,
    );
    expect(timelineLabel(ev("dispatch.private_incompatible", "Véhicule du chauffeur incompatible", fp, "warning"))).toBe(
      `À vérifier${NBSP}: véhicule (catégorie ou nombre de places)`,
    );
    expect(timelineLabel(ev("ride.taken_by_driver", "Claire prend la réservation", { ...fp, chained: false }, "success"))).toBe("Vous l'avez prise");
    expect(timelineLabel(ev("ride.taken_by_driver", "Claire prend la réservation — enchaînée", { ...fp, chained: true }))).toBe(
      "Vous l'avez prise · enchaînée après votre course en cours",
    );
    expect(timelineLabel(ev("offer.accepted", "Claire accepte", {}, "success"), { privateFleet: true })).toBe("Vous l'avez confirmée");
    const fleet = ev("dispatch.fleet", "Course proposée à la flotte — 1 chauffeur notifié", { count: 1, pending: 1 }, "success");
    expect(timelineLabel(fleet, { privateFleet: true })).toBe("Réservation à confirmer");
    expect(timelineLabel(fleet)).toBe("Course proposée à la flotte — 1 chauffeur notifié");
    // Réservation déjà écrite pour le chauffeur : inchangée
    expect(timelineLabel(ev("ride.classified", "Réservation du 13/10 à 11:00", { ...fp, type: "scheduled", pickup_at: "2026-10-13T09:00:00Z" }))).toBe(
      "Réservation du 13/10 à 11:00",
    );
  });

  it("organisation standard : acceptation et prise par le chauffeur gardent leur message", () => {
    expect(timelineLabel(ev("offer.accepted", "Karim accepte", { driver_id: "d1" }, "success"))).toBe("Karim accepte");
    expect(timelineLabel(ev("ride.taken_by_driver", "Karim prend la réservation", { chained: false }))).toBe("Karim prend la réservation");
  });

  it("type de course : immédiate, planifiée avec l'heure dans le fuseau de l'organisation", () => {
    expect(timelineLabel(ev("ride.classified", "Course instantanée détectée", { type: "instant" }))).toBe("Course immédiate");
    expect(
      timelineLabel(ev("ride.classified", "Course planifiée détectée — prise en charge le 13/10 à 11:00", { type: "scheduled", pickup_at: "2026-10-13T09:00:00Z" }), {
        timeZone: "Europe/Paris",
      }),
    ).toBe(`Course planifiée${NBSP}: prise en charge le 13/10 à 11:00`);
    expect(
      timelineLabel(ev("ride.classified", "x", { type: "scheduled", pickup_at: "2026-10-13T09:00:00Z" }), { timeZone: "America/Martinique" }),
    ).toBe(`Course planifiée${NBSP}: prise en charge le 13/10 à 05:00`);
    // Données incomplètes : message
    expect(timelineLabel(ev("ride.classified", "Course planifiée détectée", { type: "scheduled", pickup_at: "pas une date" }))).toBe("Course planifiée détectée");
  });

  it("messages écrits pour une centrale, valables aussi pour une flotte", () => {
    expect(timelineLabel(ev("dispatch.relaunched", "Dispatch relancé par le rattacheur"))).toBe("Recherche relancée");
    expect(timelineLabel(ev("ride.locked", "Course verrouillée", { mechanism: "row_lock+compare_and_set" }))).toBe("Attribution confirmée");
    expect(
      timelineLabel(ev("alert.kept", "Alerte « Chauffeur en retard » : la centrale garde Karim T. — pas de nouvelle alerte pendant 15 min", { kind: "late" })),
    ).toBe(`Alerte « Chauffeur en retard »${NBSP}: vous gardez Karim T. — pas de nouvelle alerte pendant 15 min`);
    expect(timelineLabel(ev("ride.reassigned", "Course retirée à Karim Haddad (#2) par la centrale : client en avance — nouvelle recherche"))).toBe(
      "Course retirée à Karim Haddad (#2) : client en avance — nouvelle recherche",
    );
    expect(timelineLabel(ev("ride.reassigned", "Course retirée à Karim Haddad (#2) par la centrale — à attribuer manuellement"))).toBe(
      "Course retirée à Karim Haddad (#2) — à attribuer manuellement",
    );
    expect(timelineLabel(ev("dispatch.context", "Course #12 créée — tenant : Élite", { tenant: "Élite Chauffeurs Paris" }))).toBe(
      `Organisation${NBSP}: Élite Chauffeurs Paris`,
    );
  });

  it("type inconnu ou message sans la forme attendue : message enregistré, jamais d'exception", () => {
    expect(timelineLabel(ev("dispatch.search", "Recherche — rayon 4 km (vague 1)"))).toBe("Recherche — rayon 4 km (vague 1)");
    expect(timelineLabel(ev("alert.kept", "Autre forme de message"))).toBe("Autre forme de message");
    expect(timelineLabel(ev("ride.reassigned", "Course retirée à Karim"))).toBe("Course retirée à Karim");
    expect(timelineLabel({ type: "ride.created", message: "Créée", data: null })).toBe("Créée");
    expect(timelineLabel({ type: "nouveau.type", message: "Texte" })).toBe("Texte");
  });
});
