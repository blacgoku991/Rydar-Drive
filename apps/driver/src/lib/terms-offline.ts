// Conditions d'utilisation à accepter (components/terms-gate.tsx) : le chauffeur disponible sans course est passé hors
// ligne, avec de nouveaux essais tant qu'il le reste. Module sans dépendance native (terms-offline.test.ts).

/** Mise hors ligne en échec (réseau), ou sans effet (passage en ligne / hors ligne déjà en cours) : nouvel essai après ce délai. */
export const OFFLINE_RETRY_MS = 30_000;

/** Issue d'un essai (setOnline(false) de driver-context) : `presence`, présence confirmée par le serveur. */
type Attempt = { ok: boolean; presence?: string };

export type OfflineEnforcer = {
  /** Mise hors ligne voulue (conditions à accepter, chauffeur disponible sans course), ou plus voulue. */
  set: (wanted: boolean) => void;
  /** Passé hors ligne par ce biais (confirmé par le serveur) depuis le dernier appel : à remettre en ligne après « J'accepte ». */
  takeWentOffline: () => boolean;
  /** Plus aucun essai (changement de compte, écran démonté). */
  dispose: () => void;
};

/**
 * Tant que la mise hors ligne est voulue : un essai tout de suite, puis un nouvel essai toutes les `retryMs`. Un échec
 * (réseau instable, délai dépassé) ou un appel sans effet ne laisse jamais le chauffeur disponible — donc destinataire
 * d'offres — sans avoir accepté les conditions ; il ne compte « passé hors ligne » que sur confirmation du serveur.
 */
export function offlineEnforcer(goOffline: () => Promise<Attempt>, retryMs = OFFLINE_RETRY_MS): OfflineEnforcer {
  let wanted = false;
  let running = false;
  let disposed = false;
  let triedAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wentOffline = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const next = () => {
    clear();
    if (disposed || !wanted || running) return;
    const wait = triedAt == null ? 0 : triedAt + retryMs - Date.now();
    if (wait > 0) {
      timer = setTimeout(next, wait);
      return;
    }
    running = true;
    triedAt = Date.now();
    void goOffline()
      .catch(() => null)
      .then((res) => {
        if (!disposed && res?.ok && res.presence === "offline") wentOffline = true;
      })
      .finally(() => {
        running = false;
        // Toujours voulue (échec, ou rien de fait) : nouvel essai après le délai
        next();
      });
  };

  return {
    set: (w) => {
      wanted = w;
      if (w) next();
      else clear();
    },
    takeWentOffline: () => {
      const went = wentOffline;
      wentOffline = false;
      return went;
    },
    dispose: () => {
      disposed = true;
      wanted = false;
      clear();
    },
  };
}
