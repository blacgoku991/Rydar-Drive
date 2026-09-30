// Suivi du chauffeur par la carte native : règles pures (testées sans carte).
//   - un geste (glisser, zoomer, tourner) suspend le suivi le temps du geste ; il reprend si le chauffeur est resté
//     près du centre (zoom, rotation, petit glissement), sinon bouton « Recentrer » ;
//   - carte déplacée ailleurs : retour automatique sur le chauffeur quand il roule et ne touche plus la carte ;
//   - carte tournée à deux doigts : bouton boussole pour remettre le nord en haut.

/** Après un geste, le suivi continue si le chauffeur est à moins de cette part du plus petit côté de la carte du centre. */
export const FOLLOW_NEAR_RATIO = 0.3;
/** Retour automatique sur le chauffeur : carte laissée sans la toucher depuis ce délai (ms)… */
export const AUTO_RECENTER_MS = 10_000;
/** …et chauffeur qui roule (m/s, 9 km/h). À l'arrêt, la carte reste où il l'a laissée. */
export const AUTO_RECENTER_SPEED = 2.5;
/**
 * Vitesse d'un point plus ancien que ce délai (ms) : périmée. À l'arrêt, la position n'est plus republiée (moins de
 * 3 m) et le dernier point garde la vitesse d'avant l'arrêt.
 */
export const SPEED_FRESH_MS = 5000;
/** Écart (°) sous lequel la carte est tenue pour orientée nord en haut (bouton boussole masqué). */
export const NORTH_TOLERANCE = 2;

/** Cap ramené dans [0, 360[. */
export const normHeading = (h: number) => (Number.isFinite(h) ? ((h % 360) + 360) % 360 : 0);

/** Écart angulaire (°, 0 à 180) entre deux caps. */
export const headingGap = (a: number, b: number) => Math.abs(((normHeading(a) - normHeading(b) + 540) % 360) - 180);

/** Carte orientée nord en haut (à NORTH_TOLERANCE près). */
export const isNorthUp = (heading: number) => headingGap(heading, 0) <= NORTH_TOLERANCE;

/** Chauffeur resté près du centre de la carte après un geste : le suivi continue (zoom et orientation gardés). */
export function nearCenter(
  point: { x: number; y: number },
  size: { width: number; height: number },
  ratio = FOLLOW_NEAR_RATIO,
) {
  if (!(size.width > 0 && size.height > 0) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  return Math.hypot(point.x - size.width / 2, point.y - size.height / 2) <= ratio * Math.min(size.width, size.height);
}

/** Chauffeur qui roule : vitesse suffisante, portée par un point récent (horodatage inconnu : vitesse seule). */
export function isDriving(me: { speed?: number | null; at?: number | null }, now: number) {
  return (me.speed ?? 0) >= AUTO_RECENTER_SPEED && (me.at == null || now - me.at <= SPEED_FRESH_MS);
}

/** Retour automatique sur le chauffeur : il roule et n'a pas touché la carte depuis AUTO_RECENTER_MS. */
export function shouldAutoRecenter(me: { speed?: number | null; at?: number | null }, lastTouchAt: number, now: number) {
  return isDriving(me, now) && now - lastTouchAt >= AUTO_RECENTER_MS;
}

/** Fin d'un geste : carte tenue pour immobile (élan compris) sans nouveau mouvement pendant ce délai (ms). */
export const SETTLE_MS = 400;
/** Doigt posé sans aucun événement depuis ce délai (fin de contact jamais reçue) : geste tenu pour terminé (ms). */
export const TOUCH_STALE_MS = 4000;
/** Même garde quand la carte ne signale pas les contacts (glissements seuls) : fin du geste plus tôt (ms). */
export const DRAG_STALE_MS = 1000;

/**
 * Gestes du chauffeur sur la carte : doigts posés, carte bougée, fin du geste (élan compris). onSettled est appelé une
 * fois la carte immobile après un geste qui l'a déplacée (glisser, zoomer, tourner) ; un simple appui ne compte pas.
 */
export class MapGestures {
  /** Au moins un doigt sur la carte */
  touching = false;
  /** Doigts levés, fin du mouvement attendue (élan de la carte) */
  settling = false;
  /** Dernier contact ou mouvement venu du chauffeur (ms) */
  lastTouchAt = 0;
  private moved = false;
  /** La carte signale les contacts (sinon, les glissements seuls en tiennent lieu) */
  private touchSeen = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onSettled: (g: MapGestures) => void;
  private readonly clock: () => number;

  constructor(onSettled: (g: MapGestures) => void, clock: () => number = Date.now) {
    this.onSettled = onSettled;
    this.clock = clock;
  }

  /** Geste en cours ou pas encore terminé : la carte ne bouge pas d'elle-même. */
  get busy() {
    return this.touching || this.settling;
  }

  touchStart() {
    this.touchSeen = true;
    this.touching = true;
    this.lastTouchAt = this.clock();
    this.clearTimer();
    // Nouveau geste pendant l'élan du précédent : un seul bilan, à la fin de celui-ci
    if (!this.settling) this.moved = false;
  }

  /** Fin d'un contact ; remaining : doigts encore posés (fin d'un zoom à deux doigts : le geste continue). */
  touchEnd(remaining: number) {
    if (remaining > 0) return;
    this.endTouch();
  }

  /** Carte glissée au doigt. */
  panDrag() {
    this.moved = true;
    this.lastTouchAt = this.clock();
    if (!this.touchSeen) this.touching = true;
  }

  /** La carte bouge ; gesture : mouvement venu du chauffeur ou de la carte elle-même, pas d'une animation de l'app. */
  regionChange(gesture: boolean) {
    if (!this.busy) return;
    if (this.touching && gesture) this.moved = true;
    this.lastTouchAt = this.clock();
    // Élan après le geste : bilan quand la carte s'arrête
    if (this.settling && !this.touching) this.schedule();
  }

  /** La carte s'est arrêtée. */
  regionChangeComplete() {
    if (this.settling && !this.touching) this.settle();
  }

  /** Appelé chaque seconde : contact resté sans fin (événement perdu) tenu pour terminé. */
  tick() {
    if (this.touching && this.clock() - this.lastTouchAt > (this.touchSeen ? TOUCH_STALE_MS : DRAG_STALE_MS)) this.endTouch();
  }

  /** Bilan en attente devenu sans objet (carte recadrée par l'app). */
  drop() {
    this.clearTimer();
    this.settling = false;
    this.moved = false;
  }

  dispose() {
    this.clearTimer();
  }

  private endTouch() {
    this.touching = false;
    this.lastTouchAt = this.clock();
    if (!this.moved) {
      this.settling = false;
      return;
    }
    this.settling = true;
    this.schedule();
  }

  private schedule() {
    this.clearTimer();
    this.timer = setTimeout(() => this.settle(), SETTLE_MS);
  }

  private settle() {
    this.clearTimer();
    if (!this.settling) return;
    this.settling = false;
    this.moved = false;
    this.lastTouchAt = this.clock();
    this.onSettled(this);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
