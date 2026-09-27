"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  LineSegments,
  Mesh,
  PerspectiveCamera,
  Points,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
  type IUniform,
} from "three";
import { CITIES, decodeLand, DESTINATIONS, LAND_STEP, latLonToVec, RADAR_CENTER } from "./globe-data";
import {
  ARC_FRAG,
  ARC_VERT,
  ATMOS_FRAG,
  BEAM_FRAG,
  BEAM_VERT,
  BODY_FRAG,
  DRIVER_FRAG,
  DRIVER_VERT,
  GRID_FRAG,
  GRID_VERT,
  LAND_FRAG,
  LAND_VERT,
  MARK_FRAG,
  MARK_VERT,
  RADAR_FRAG,
  RADAR_VERT,
  VIEW_VERT,
} from "./globe-shaders";

// -----------------------------------------------------------------------------
// Globe « radar » de la page d'accueil (three.js, WebGL 2), chargé à la demande par hero-visual.tsx.
// Terres en points (France en lime), radar de dispatch sur Paris : balayage, anneaux 4 → 16 km, vagues.
// Chaque cycle raconte une course : offres envoyées aux chauffeurs touchés par la vague, acceptation,
// trajet jusqu'à la prise en charge, puis course vers une autre ville.
// Aucune ressource externe, ni eval ni WebAssembly (CSP de production). Couleurs = jetons de globals.css.
// -----------------------------------------------------------------------------

type Rgb = [number, number, number];

const TAU = Math.PI * 2;
const FOV = 30;
/** Part du plus petit côté occupée par le globe. */
const GLOBE_FILL = 0.84;
/** Point du globe face à la caméra (Europe en haut, Afrique en bas). */
const VIEW = { lat: 37, lon: 5 };
/** Rayon angulaire du radar autour de la prise en charge. */
const RADAR_R = (19 * Math.PI) / 180;
/** La calotte dépasse un peu du radar pour que l'anneau extérieur (16 km) ne soit pas fondu. */
const CAP_MARGIN = 1.08;
const SWEEP_PERIOD = 4.2;
const DRIVERS_PER_RING = 6;

// Chronologie d'un cycle (secondes)
const CYCLE = 12;
/** Vague à laquelle un chauffeur accepte, cycle après cycle (1 = 4 km, 2 = 8 km…). */
const ACCEPT_WAVES = [2, 1, 3, 2];
const WAVE_GROW = 0.55;
const waveStart = (w: number) => 0.7 + (w - 1) * 1.2;
const acceptTime = (wave: number) => waveStart(wave) + 0.85;
/** Le chauffeur retenu arrive à la prise en charge, puis la course part vers la destination. */
const ARRIVE_AT = 7.15;
const RIDE_START = 7.55;
const RIDE_DURATION = 3;
/** Image figée (prefers-reduced-motion) : course en cours vers Marseille. */
const STILL_T = CYCLE * 4 + 9;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
const easeInOut = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

/** Jeton de couleur du thème (lu sur :root, normalisé par le canvas 2D), valeur du @theme en repli. */
function themeColor(name: string, fallback: string): Rgb {
  let hex = fallback;
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const ctx = document.createElement("canvas").getContext("2d");
    if (raw && ctx) {
      ctx.fillStyle = fallback;
      ctx.fillStyle = raw;
      if (/^#[0-9a-f]{6}$/i.test(ctx.fillStyle)) hex = ctx.fillStyle;
    }
  } catch {
    // repli sur la valeur du @theme
  }
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const vec = (c: Rgb) => new Vector3(c[0], c[1], c[2]);
const toVec = ([lat, lon]: readonly [number, number]) => new Vector3(...latLonToVec(lat, lon));

/** Générateur pseudo-aléatoire déterministe (même scène à chaque visite). */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Point d'un arc : interpolation sphérique de a à b, relevé de `lift` au milieu (même formule que le shader). */
function arcPoint(a: Vector3, b: Vector3, lift: number, t: number, out: Vector3) {
  const omega = Math.acos(Math.min(1, Math.max(-1, a.dot(b))));
  if (omega < 1e-5) out.copy(a);
  else {
    const s = Math.sin(omega);
    out
      .copy(a)
      .multiplyScalar(Math.sin((1 - t) * omega) / s)
      .addScaledVector(b, Math.sin(t * omega) / s);
  }
  return out.multiplyScalar(1 + lift * Math.sin(Math.PI * t));
}

// --- Géométries -----------------------------------------------------------------

/** Ruban de `segments` tronçons : attributs aT (0 → 1) et aSide (−1 / +1). `copies` rubans à la suite. */
function ribbonGeometry(segments: number, copies = 1) {
  const n = segments + 1;
  const count = n * 2 * copies;
  const t = new Float32Array(count);
  const side = new Float32Array(count);
  const index: number[] = [];
  for (let c = 0; c < copies; c++) {
    const base = c * n * 2;
    for (let i = 0; i < n; i++) {
      t[base + i * 2] = i / segments;
      t[base + i * 2 + 1] = i / segments;
      side[base + i * 2] = -1;
      side[base + i * 2 + 1] = 1;
    }
    for (let i = 0; i < segments; i++) {
      const a = base + i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute("aT", new BufferAttribute(t, 1));
  g.setAttribute("aSide", new BufferAttribute(side, 1));
  g.setIndex(index);
  return g;
}

function graticuleGeometry() {
  const pts: number[] = [];
  const push = (lat: number, lon: number) => pts.push(...latLonToVec(lat, lon).map((v) => v * 1.0015));
  for (let lon = -180; lon < 180; lon += 15) {
    for (let lat = -75; lat < 75; lat += 3) {
      push(lat, lon);
      push(lat + 3, lon);
    }
  }
  for (let lat = -60; lat <= 60; lat += 15) {
    for (let lon = -180; lon < 180; lon += 3) {
      push(lat, lon);
      push(lat, lon + 3);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pts), 3));
  return g;
}

type Mount = {
  /** Image figée (prefers-reduced-motion : reduce). */
  reducedMotion: boolean;
  /** Première image dessinée. */
  onReady: () => void;
  /** WebGL indisponible, contexte perdu ou erreur de la scène : le parent affiche le repli. */
  onFail: () => void;
};

/**
 * Construit la scène dans `host` et lance l'animation ; renvoie la fonction de démontage. Toute erreur (création,
 * premier rendu, image suivante) libère les ressources déjà créées et appelle onFail, sans rien laisser remonter.
 */
function mountGlobe(host: HTMLDivElement, { reducedMotion, onReady, onFail }: Mount): (() => void) | undefined {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: (window.devicePixelRatio || 1) < 2, alpha: true, powerPreference: "high-performance" });
  } catch {
    onFail();
    return;
  }
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  host.appendChild(canvas);

  const disposables: Array<{ dispose: () => void }> = [];
  /** Arrêt de la boucle, observateurs et écouteurs : enregistrés au fil de la construction. */
  const teardown: Array<() => void> = [];
  let lost = false;
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    for (const t of teardown) t();
    for (const d of disposables) d.dispose();
    renderer.dispose();
    if (!lost) renderer.forceContextLoss();
    canvas.remove();
  };
  const crash = () => {
    destroy();
    onFail();
  };

  try {
    const color = {
      base: themeColor("--color-ink-800", "#111318"),
      brand: themeColor("--color-brand", "#c8f03c"),
      land: themeColor("--color-fg-muted", "#9ea5b1"),
      offer: themeColor("--color-amber", "#f5b544"),
      grid: themeColor("--color-ink-400", "#3b414c"),
    };

    const scene = new Scene();
    const camera = new PerspectiveCamera(FOV, 1, 0.1, 50);
    const tilt = new Group();
    const globe = new Group();
    tilt.add(globe);
    scene.add(tilt);
    const baseYaw = (-VIEW.lon * Math.PI) / 180;
    globe.rotation.set((VIEW.lat * Math.PI) / 180, baseYaw, 0);

    const track = <T extends { dispose: () => void }>(o: T) => {
      disposables.push(o);
      return o;
    };
    const material = (params: ConstructorParameters<typeof ShaderMaterial>[0]) => track(new ShaderMaterial(params));
    const add = <T extends Mesh | Points | LineSegments>(object: T, order: number, parent: Group = globe) => {
      object.renderOrder = order;
      object.frustumCulled = false;
      parent.add(object);
      return object;
    };
    const uniform = <T,>(value: T): IUniform<T> => ({ value });
    const brand = uniform(vec(color.brand));
    const amber = uniform(vec(color.offer));

    // Corps du globe et atmosphère (lueur lime discrète au limbe)
    const sphere = track(new SphereGeometry(1, 96, 64));
    add(new Mesh(sphere, material({ uniforms: { uBase: uniform(vec(color.base)), uRim: brand }, vertexShader: VIEW_VERT, fragmentShader: BODY_FRAG })), 0);
    const ATMOS_SCALE = 1.16;
    const atmos = add(
      new Mesh(
        sphere,
        material({
          uniforms: { uColor: brand, uInner: uniform(Math.sqrt(1 - 1 / ATMOS_SCALE ** 2)), uIntensity: uniform(0.12) },
          vertexShader: VIEW_VERT,
          fragmentShader: ATMOS_FRAG,
          side: BackSide,
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      ),
      1,
      tilt,
    );
    atmos.scale.setScalar(ATMOS_SCALE);

    // Maillage : méridiens et parallèles
    add(
      new LineSegments(
        track(graticuleGeometry()),
        material({ uniforms: { uColor: uniform(vec(color.grid)), uAlpha: uniform(0.55) }, vertexShader: GRID_VERT, fragmentShader: GRID_FRAG, transparent: true, depthWrite: false }),
      ),
      2,
    );

    // Repère du radar sur la prise en charge
    const center = toVec(RADAR_CENTER);
    const capQuat = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), center);
    const e1 = new Vector3(-1, 0, 0).applyQuaternion(capQuat);
    const e2 = new Vector3(0, 0, 1).applyQuaternion(capQuat);
    const radar = {
      uCenter: uniform(center),
      uE1: uniform(e1),
      uE2: uniform(e2),
      uRadarR: uniform(RADAR_R),
      uSweep: uniform(0),
      uFront: uniform(0),
      uWaveOn: uniform(0),
      uShow: uniform(0),
    };
    const cycleU = { uCt: uniform(0), uAfter: uniform(0) };

    // Terres en points (grille allégée sur les petits écrans)
    const landMat = material({
      uniforms: { ...radar, uPx: uniform(2), uLand: uniform(vec(color.land)), uBrand: brand },
      vertexShader: LAND_VERT,
      fragmentShader: LAND_FRAG,
      transparent: true,
      depthWrite: false,
    });
    let land: Points | null = null;
    let landStride = 0;
    const buildLand = (stride: number) => {
      if (stride === landStride) return;
      landStride = stride;
      if (land) {
        globe.remove(land);
        land.geometry.dispose();
      }
      const { positions, kinds } = decodeLand(stride);
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(positions, 3));
      g.setAttribute("aKind", new BufferAttribute(kinds, 1));
      land = add(new Points(g, landMat), 3);
      land.scale.setScalar(1.003);
    };

    // Radar : balayage, anneaux, vagues (calotte posée sur la sphère)
    const cap = add(
      new Mesh(
        track(new SphereGeometry(1.0025, 128, 48, 0, TAU, 0, RADAR_R * CAP_MARGIN)),
        material({
          uniforms: { ...radar, uBrand: brand, uActiveRing: uniform(0) },
          vertexShader: RADAR_VERT,
          fragmentShader: RADAR_FRAG,
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      ),
      4,
    );
    cap.quaternion.copy(capQuat);
    const capU = (cap.material as ShaderMaterial).uniforms;

    // Chauffeurs : six par anneau (4, 8, 12, 16 km) et quelques-uns au-delà
    const rand = prng(20260927);
    const drivers: { dir: Vector3; d: number; ring: number }[] = [];
    for (let ring = 1; ring <= 5; ring++) {
      const count = ring === 5 ? 4 : DRIVERS_PER_RING;
      for (let k = 0; k < count; k++) {
        const d = ring === 5 ? 1.08 + rand() * 0.25 : (ring - 1) / 4 + 0.05 + rand() * 0.18;
        const phi = ((k + rand() * 0.8) / count) * TAU + ring * 0.9;
        const theta = d * RADAR_R;
        const tangent = e1.clone().multiplyScalar(Math.cos(phi)).addScaledVector(e2, Math.sin(phi));
        drivers.push({ dir: center.clone().multiplyScalar(Math.cos(theta)).addScaledVector(tangent, Math.sin(theta)).normalize(), d, ring });
      }
    }
    const driverGeo = track(new BufferGeometry());
    driverGeo.setAttribute("position", new BufferAttribute(new Float32Array(drivers.flatMap((dr) => dr.dir.clone().multiplyScalar(1.006).toArray())), 3));
    driverGeo.setAttribute("aIdx", new BufferAttribute(new Float32Array(drivers.map((_, i) => i)), 1));
    const driverReach = new BufferAttribute(new Float32Array(drivers.length), 1);
    driverGeo.setAttribute("aReach", driverReach);
    const driverMat = material({
      uniforms: { ...cycleU, uShow: radar.uShow, uPx: uniform(10), uAccepted: uniform(-1), uIdle: uniform(vec(color.land)), uOffer: amber },
      vertexShader: DRIVER_VERT,
      fragmentShader: DRIVER_FRAG,
      transparent: true,
      depthWrite: false,
    });
    add(new Points(driverGeo, driverMat), 6);

    // Offres envoyées (un ruban par chauffeur du radar)
    const BEAM_SEGMENTS = 12;
    const radarDrivers = drivers.filter((dr) => dr.ring <= 4);
    const beamGeo = track(ribbonGeometry(BEAM_SEGMENTS, radarDrivers.length));
    const perBeam = (BEAM_SEGMENTS + 1) * 2;
    const beamDir = new Float32Array(radarDrivers.length * perBeam * 3);
    radarDrivers.forEach((dr, i) => {
      for (let v = 0; v < perBeam; v++) dr.dir.toArray(beamDir, (i * perBeam + v) * 3);
    });
    beamGeo.setAttribute("aDir", new BufferAttribute(beamDir, 3));
    const beamReach = new BufferAttribute(new Float32Array(radarDrivers.length * perBeam), 1);
    beamGeo.setAttribute("aReach", beamReach);
    const beamMat = material({
      uniforms: { ...cycleU, uShow: radar.uShow, uCenter: radar.uCenter, uWidth: uniform(0.003), uColor: amber },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    add(new Mesh(beamGeo, beamMat), 5);

    // Trajets lumineux : approche (chauffeur → prise en charge) et course (prise en charge → destination)
    const arcGeo = track(ribbonGeometry(64));
    const arc = (lift: number) => {
      const mesh = add(
        new Mesh(
          arcGeo,
          material({
            uniforms: {
              uA: uniform(new Vector3()),
              uB: uniform(new Vector3()),
              uLift: uniform(lift),
              uWidth: uniform(0.004),
              uColor: brand,
              uFrom: uniform(0),
              uTo: uniform(0),
              uAlpha: uniform(0),
            },
            vertexShader: ARC_VERT,
            fragmentShader: ARC_FRAG,
            transparent: true,
            depthWrite: false,
            blending: AdditiveBlending,
            side: DoubleSide,
          }),
        ),
        7,
      );
      return (mesh.material as ShaderMaterial).uniforms as Record<"uA" | "uB" | "uLift" | "uWidth" | "uFrom" | "uTo" | "uAlpha", IUniform>;
    };
    const approach = arc(0.012);
    approach.uB.value.copy(center);
    const ride = arc(0);
    ride.uA.value.copy(center);

    // Marqueurs : prise en charge, chauffeur retenu, destination
    const marker = (core: number) => {
      const g = track(new BufferGeometry());
      g.setAttribute("position", new BufferAttribute(new Float32Array(3), 3));
      const m = material({
        uniforms: { uPx: uniform(40), uColor: brand, uAlpha: uniform(0), uCore: uniform(core), uPulse: uniform(1) },
        vertexShader: MARK_VERT,
        fragmentShader: MARK_FRAG,
        transparent: true,
        depthWrite: false,
      });
      add(new Points(g, m), 8);
      const attr = g.getAttribute("position") as BufferAttribute;
      return {
        u: m.uniforms as Record<"uPx" | "uAlpha" | "uCore" | "uPulse", IUniform<number>>,
        place: (p: Vector3, scale: number) => {
          attr.setXYZ(0, p.x * scale, p.y * scale, p.z * scale);
          attr.needsUpdate = true;
        },
      };
    };
    const pickup = marker(0.14);
    pickup.place(center, 1.008);
    const car = marker(0.2);
    const dest = marker(0.16);

    // --- Cycle : chauffeur retenu, destination, instants où la vague atteint chaque chauffeur -----------
    let cycleIndex = -1;
    let acceptWave = 2;
    let accepted = drivers[0]!;
    let destination = center.clone();
    let rideLift = 0;
    const startCycle = (cycle: number) => {
      cycleIndex = cycle;
      acceptWave = ACCEPT_WAVES[cycle % ACCEPT_WAVES.length]!;
      const candidates = drivers.map((dr, i) => ({ dr, i })).filter(({ dr }) => dr.ring === acceptWave);
      const chosen = candidates[(cycle * 7 + 3) % candidates.length]!;
      accepted = chosen.dr;
      driverMat.uniforms.uAccepted!.value = chosen.i;
      approach.uA.value.copy(accepted.dir);
      destination = toVec(CITIES[DESTINATIONS[cycle % DESTINATIONS.length]!]);
      ride.uB.value.copy(destination);
      rideLift = 0.04 + Math.acos(Math.min(1, center.dot(destination))) * 1.2;
      ride.uLift.value = rideLift;
      dest.place(destination, 1.008);
      // La vague w atteint un chauffeur de l'anneau w quand son front (easeOut) passe sur lui ; au-delà : jamais
      const reach = (dr: (typeof drivers)[number]) => {
        if (dr.ring > acceptWave) return 1e4;
        const f = clamp01((dr.d - (dr.ring - 1) / 4) * 4);
        return waveStart(dr.ring) + WAVE_GROW * (1 - Math.cbrt(1 - f));
      };
      drivers.forEach((dr, i) => driverReach.setX(i, reach(dr)));
      driverReach.needsUpdate = true;
      radarDrivers.forEach((dr, i) => {
        const r = reach(dr);
        for (let v = 0; v < perBeam; v++) beamReach.setX(i * perBeam + v, r);
      });
      beamReach.needsUpdate = true;
    };

    // --- Taille, densité de pixels, qualité -------------------------------------
    let dprCap = 2;
    const resize = () => {
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      // Densité plafonnée : 2 au plus, et ~2,6 millions de pixels dessinés au plus
      const dpr = Math.min(window.devicePixelRatio || 1, dprCap, Math.sqrt(2_600_000 / (width * height)));
      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      const tanHalf = Math.tan((FOV * Math.PI) / 360) * Math.min(1, camera.aspect);
      camera.position.set(0, 0, Math.sqrt(1 + 1 / (GLOBE_FILL * tanHalf) ** 2));
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      // Rayon du globe à l'écran (px CSS) : tailles des points et largeur des traits
      const radiusPx = (Math.min(width, height) / 2) * GLOBE_FILL;
      const spacing = ((LAND_STEP * Math.PI) / 180) * radiusPx;
      const stride = spacing < 2.7 ? 2 : 1;
      buildLand(stride);
      landMat.uniforms.uPx!.value = Math.min(Math.max(spacing * stride * 0.56, 1.8), 4.6) * dpr;
      driverMat.uniforms.uPx!.value = Math.max(6, radiusPx * 0.036) * dpr;
      pickup.u.uPx.value = Math.max(30, radiusPx * 0.17) * dpr;
      car.u.uPx.value = Math.max(20, radiusPx * 0.1) * dpr;
      dest.u.uPx.value = Math.max(26, radiusPx * 0.14) * dpr;
      const px = 1 / radiusPx; // 1 px CSS en unités du monde, à la surface du globe
      approach.uWidth.value = Math.max(1.2, radiusPx * 0.008) * px;
      ride.uWidth.value = Math.max(1.3, radiusPx * 0.009) * px;
      beamMat.uniforms.uWidth!.value = Math.max(0.8, radiusPx * 0.0045) * px;
    };

    // --- Animation ----------------------------------------------------------------
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const carPos = new Vector3();
    const update = (t: number, dt: number) => {
      // Globe : arrivée en rotation, léger balancement, parallaxe du pointeur
      const intro = reducedMotion ? 1 : easeOut(t / 2.8);
      globe.rotation.y = baseYaw + (1 - intro) * 1.1 + Math.sin(t * 0.14) * 0.07 * intro;
      const k = 1 - Math.exp(-dt * 3);
      pointer.x += (pointer.tx - pointer.x) * k;
      pointer.y += (pointer.ty - pointer.y) * k;
      tilt.rotation.x = pointer.y * 0.08;
      tilt.rotation.y = pointer.x * 0.12;

      const show = reducedMotion ? 1 : smooth(1.2, 2.4, t);
      radar.uShow.value = show;
      radar.uSweep.value = -((t % SWEEP_PERIOD) / SWEEP_PERIOD) * TAU;

      const cycle = Math.floor(t / CYCLE);
      const ct = t - cycle * CYCLE;
      if (cycle !== cycleIndex) startCycle(cycle);
      const acceptAt = acceptTime(acceptWave);

      // Vagues jusqu'à l'acceptation
      let front = 0;
      let activeRing = 0;
      for (let w = 1; w <= acceptWave; w++) {
        const s = waveStart(w);
        if (ct >= s) {
          front = (w - 1) / 4 + easeOut((ct - s) / WAVE_GROW) / 4;
          activeRing = w;
        }
      }
      radar.uFront.value = front;
      radar.uWaveOn.value = smooth(0.5, 0.8, ct) * (1 - smooth(acceptAt + 0.3, acceptAt + 1.1, ct)) * show;
      capU.uActiveRing!.value = activeRing;
      const after = smooth(acceptAt, acceptAt + 0.5, ct);
      cycleU.uCt.value = ct;
      cycleU.uAfter.value = after;
      const cycleFade = smooth(0.1, 0.5, ct) * (1 - smooth(CYCLE - 0.8, CYCLE - 0.15, ct)) * show;

      // Prise en charge : ondes pendant la recherche, onde à l'arrivée du chauffeur, atténuée pendant la course
      pickup.u.uAlpha.value = cycleFade * (1 - 0.55 * smooth(RIDE_START, RIDE_START + 0.6, ct));
      pickup.u.uPulse.value = ct < acceptAt ? (ct * 0.7) % 1 : ct >= ARRIVE_AT ? clamp01((ct - ARRIVE_AT) / 0.9) : 1;

      // Approche : trajet tracé, puis parcouru jusqu'à la prise en charge
      const travel = easeInOut((ct - acceptAt - 0.8) / (ARRIVE_AT - acceptAt - 0.8));
      approach.uFrom.value = travel;
      approach.uTo.value = easeInOut((ct - acceptAt) / 0.6);
      approach.uAlpha.value = (ct >= acceptAt ? 1 : 0) * cycleFade * (1 - smooth(0.97, 1, travel));

      // Course : le chauffeur part vers la destination et laisse une traînée
      const rideHead = easeInOut((ct - RIDE_START) / RIDE_DURATION);
      ride.uTo.value = rideHead;
      ride.uFrom.value = easeInOut((ct - RIDE_START - 0.9) / RIDE_DURATION);
      ride.uAlpha.value = (ct >= RIDE_START ? 1 : 0) * cycleFade;
      const rideEnd = RIDE_START + RIDE_DURATION;
      dest.u.uAlpha.value = smooth(RIDE_START, RIDE_START + 0.5, ct) * cycleFade;
      dest.u.uPulse.value = ct >= rideEnd ? clamp01((ct - rideEnd) / 1.1) : 1;

      // Chauffeur retenu
      if (ct < RIDE_START) arcPoint(accepted.dir, center, 0.012, travel, carPos).multiplyScalar(1.007);
      else arcPoint(center, destination, rideLift, rideHead, carPos).multiplyScalar(1.007);
      car.place(carPos, 1);
      car.u.uAlpha.value = after * cycleFade;
    };

    // Boucle : ne tourne que visible à l'écran, onglet affiché et animations autorisées
    let raf = 0;
    let last = 0;
    let clock = 0;
    let inView = true;
    let firstFrame = true;
    let sampled = 0;
    let slow = 0;
    const render = () => {
      renderer.render(scene, camera);
      if (firstFrame) {
        firstFrame = false;
        onReady();
      }
    };
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
      last = now;
      clock += dt;
      try {
        // Qualité adaptative : si la moitié des 120 premières images dépassent 35 ms, densité de pixels 1
        if (dt > 0 && sampled < 120) {
          sampled++;
          if (dt > 0.035) slow++;
          if (sampled === 120 && slow > 60 && dprCap > 1) {
            dprCap = 1;
            resize();
          }
        }
        update(clock, dt);
        render();
      } catch {
        crash();
      }
    };
    const start = () => {
      if (raf) return;
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const drawStill = () => {
      update(STILL_T, 0);
      render();
    };
    const sync = () => {
      if (!reducedMotion && inView && document.visibilityState === "visible") start();
      else stop();
    };

    resize();
    if (reducedMotion) drawStill();
    else {
      update(0, 0);
      render();
    }

    teardown.push(stop);
    const ro = new ResizeObserver(() => {
      try {
        resize();
        if (reducedMotion) drawStill();
        else if (!raf) render();
      } catch {
        crash();
      }
    });
    teardown.push(() => ro.disconnect());
    ro.observe(host);
    const io = new IntersectionObserver(
      (entries) => {
        inView = entries.some((e) => e.isIntersecting);
        sync();
      },
      { rootMargin: "80px" },
    );
    io.observe(host);
    teardown.push(() => io.disconnect());
    document.addEventListener("visibilitychange", sync);
    teardown.push(() => document.removeEventListener("visibilitychange", sync));
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      pointer.tx = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.ty = (e.clientY / window.innerHeight) * 2 - 1;
    };
    if (!reducedMotion) {
      window.addEventListener("pointermove", onPointer, { passive: true });
      teardown.push(() => window.removeEventListener("pointermove", onPointer));
    }
    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
      stop();
      onFail();
    };
    canvas.addEventListener("webglcontextlost", onLost);
    teardown.push(() => canvas.removeEventListener("webglcontextlost", onLost));
    teardown.push(() => land?.geometry.dispose());
    sync();
  } catch {
    crash();
    return;
  }
  return destroy;
}

type Props = { reducedMotion: boolean; onReady?: () => void; onFail?: () => void };

export default function GlobeScene({ reducedMotion, onReady, onFail }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ready = useEffectEvent(() => onReady?.());
  const fail = useEffectEvent(() => onFail?.());

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    return mountGlobe(host, { reducedMotion, onReady: () => ready(), onFail: () => fail() });
  }, [reducedMotion]);

  return <div ref={hostRef} aria-hidden className="absolute inset-0" />;
}
