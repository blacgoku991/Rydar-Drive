// Confirmation à afficher par l'écran qui reprend la main, quand un écran se ferme juste après une action (ex. conditions
// du réseau partagé acceptées : « Courses du réseau partagé activées » sur le profil ou l'accueil). Module sans dépendance
// native (testé sous Node) ; lu par useReturnFlash au retour sur l'écran.

/** Au-delà, le message n'est plus d'actualité (écran rouvert bien plus tard) : il est oublié. */
export const RETURN_FLASH_TTL_MS = 10_000;

let pending: { text: string; at: number } | null = null;

export const returnFlash = {
  /** Message à montrer au prochain écran qui reprend la main. */
  set(text: string, now = Date.now()) {
    pending = { text, at: now };
  },
  /** Message en attente (une seule fois), s'il est encore d'actualité. */
  take(now = Date.now()): string | null {
    const p = pending;
    pending = null;
    return p && now - p.at <= RETURN_FLASH_TTL_MS ? p.text : null;
  },
};
