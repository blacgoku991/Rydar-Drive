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
/** Déplacement d'un doigt (px) au-delà duquel le chauffeur bouge la carte (glisser, pincer, tourner), pas un appui. */
export const MOVE_PX = 10;
/** Bilan sans réponse de la carte depuis ce délai (ms) : abandonné, suivi inchangé (jamais une carte bloquée). */
export const EVAL_TIMEOUT_MS = 2000;

/** Doigt sur la carte : identifiant du contact et position à l'écran. */
export type TouchPoint = { id: string; x: number; y: number };

/** Glissement signalé sans contact (la carte ne transmet pas les contacts) : doigt fictif. */
const DRAG = "drag";

/**
 * Gestes du chauffeur sur la carte : doigts posés (suivis un par un, un pouce posé ailleurs sur l'écran ne compte
 * pas), carte bougée (doigts déplacés, glissement, double appui ; Android : mouvement de la carte dû à un geste),
 * fin du geste (élan compris). onSettled(g, gen) est appelé une fois la carte immobile après un geste qui l'a bougée ;
 * un simple appui ne compte pas. Le bilan (asynchrone) reste compté dans busy jusqu'à finish(gen).
 */
export class MapGestures {
  /** Doigt posé sur la carte → position de départ */
  private fingers = new Map<string, { x: number; y: number }>();
  /** Doigts levés, fin du mouvement attendue (élan de la carte) */
  settling = false;
  /** Dernier contact ou mouvement venu du chauffeur (ms) */
  lastTouchAt = 0;
  private evaluating = false;
  private evaluatingSince = 0;
  private generation = 0;
  private moved = false;
  /** La carte signale les contacts (sinon, les glissements seuls en tiennent lieu) */
  private touchSeen = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onSettled: (g: MapGestures, gen: number) => void;
  private readonly clock: () => number;

  constructor(onSettled: (g: MapGestures, gen: number) => void, clock: () => number = Date.now) {
    this.onSettled = onSettled;
    this.clock = clock;
  }

  /** Au moins un doigt sur la carte */
  get touching() {
    return this.fingers.size > 0;
  }

  /** Geste en cours, pas encore terminé ou pas encore évalué : la carte ne bouge pas d'elle-même. */
  get busy() {
    return this.touching || this.settling || this.evaluating;
  }

  touchStart(points: TouchPoint[]) {
    this.touchSeen = true;
    if (this.evaluating) {
      // Bilan du geste précédent pas encore rendu : repris à la fin de celui-ci (la carte a bougé)
      this.evaluating = false;
      this.generation += 1;
      this.moved = true;
    } else if (!this.touching && !this.settling) {
      this.moved = false;
    }
    // Doigt ajouté pendant le geste ou pendant l'élan du précédent : un seul bilan, à la fin
    this.clearTimer();
    this.settling = false;
    for (const p of points) this.fingers.set(p.id, { x: p.x, y: p.y });
    this.lastTouchAt = this.clock();
  }

  touchMove(points: TouchPoint[]) {
    this.lastTouchAt = this.clock();
    for (const p of points) {
      const start = this.fingers.get(p.id);
      if (!start) {
        // Doigt toujours posé (contact tenu pour terminé faute d'événement) : de nouveau suivi
        this.fingers.set(p.id, { x: p.x, y: p.y });
        this.clearTimer();
        this.settling = false;
      } else if (Math.hypot(p.x - start.x, p.y - start.y) > MOVE_PX) {
        this.moved = true;
      }
    }
  }

  /** Fin (ou annulation) de contacts : plus aucun doigt → fin du geste. */
  touchEnd(ids: string[]) {
    const had = this.fingers.size;
    for (const id of ids) this.fingers.delete(id);
    this.lastTouchAt = this.clock();
    if (had > 0 && this.fingers.size === 0) this.endTouch();
  }

  /** Carte glissée au doigt. */
  panDrag() {
    this.moved = true;
    this.lastTouchAt = this.clock();
    if (!this.touchSeen && !this.fingers.has(DRAG)) {
      this.fingers.set(DRAG, { x: 0, y: 0 });
      this.clearTimer();
      this.settling = false;
    }
  }

  /** Double appui (zoom) : geste du chauffeur, la carte bouge ensuite d'elle-même. */
  doublePress() {
    this.moved = true;
    this.lastTouchAt = this.clock();
    if (!this.touching) {
      this.settling = true;
      this.schedule();
    }
  }

  /**
   * La carte bouge. user : à coup sûr à cause d'un geste (Android : isGesture), y compris sans contact signalé ou
   * après le lever des doigts (élan, double appui) ; sinon simple indice (iOS : animations de l'app comprises).
   */
  regionChange(user: boolean) {
    if (user) {
      this.moved = true;
      this.lastTouchAt = this.clock();
      if (!this.touching) {
        this.settling = true;
        this.schedule();
      }
      return;
    }
    // Élan après le geste : bilan quand la carte s'arrête
    if (this.settling && !this.touching) this.schedule();
  }

  /** La carte s'est arrêtée. */
  regionChangeComplete() {
    if (this.settling && !this.touching) this.settle();
  }

  /** Appelé chaque seconde : contact resté sans fin (événement perdu), bilan resté sans réponse. */
  tick() {
    const now = this.clock();
    if (this.touching && now - this.lastTouchAt > (this.touchSeen ? TOUCH_STALE_MS : DRAG_STALE_MS)) {
      this.fingers.clear();
      this.endTouch();
    }
    if (this.evaluating && now - this.evaluatingSince > EVAL_TIMEOUT_MS) {
      this.evaluating = false;
      this.generation += 1;
    }
  }

  /** Bilan en attente devenu sans objet (carte recadrée par l'app). */
  drop() {
    this.clearTimer();
    this.settling = false;
    this.moved = false;
    this.evaluating = false;
    this.generation += 1;
  }

  /** Bilan rendu : true s'il vaut encore (ni recadrage, ni nouveau geste, ni abandon depuis). */
  finish(gen: number) {
    if (!this.evaluating || gen !== this.generation) return false;
    this.evaluating = false;
    return true;
  }

  dispose() {
    this.clearTimer();
  }

  private endTouch() {
    this.lastTouchAt = this.clock();
    if (!this.moved) return;
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
    this.evaluating = true;
    this.evaluatingSince = this.clock();
    this.generation += 1;
    this.onSettled(this, this.generation);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
