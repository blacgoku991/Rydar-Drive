// Shaders GLSL du globe de l'accueil (globe-scene.tsx). Syntaxe GLSL ES 1 convertie par three.js pour WebGL 2 ;
// éviter les mots réservés de GLSL ES 3 (active, sample, input, output, filter…).

export const VIEW_VERT = /* glsl */ `
  varying vec3 vNormalV;
  varying vec3 vPosV;
  void main() {
    vNormalV = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vPosV = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

export const BODY_FRAG = /* glsl */ `
  uniform vec3 uBase;
  uniform vec3 uRim;
  varying vec3 vNormalV;
  varying vec3 vPosV;
  void main() {
    vec3 n = normalize(vNormalV);
    vec3 v = normalize(-vPosV);
    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    float key = clamp(dot(n, normalize(vec3(-0.5, 0.55, 0.65))), 0.0, 1.0);
    gl_FragColor = vec4(uBase * (0.8 + 0.7 * key) + uRim * rim * 0.16, 1.0);
  }
`;

export const ATMOS_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uInner;
  uniform float uIntensity;
  varying vec3 vNormalV;
  varying vec3 vPosV;
  void main() {
    vec3 n = normalize(vNormalV);
    vec3 v = normalize(-vPosV);
    float t = clamp(-dot(n, v) / uInner, 0.0, 1.0);
    gl_FragColor = vec4(uColor, pow(t, 4.5) * uIntensity);
  }
`;

/** Atténuation près du limbe (commune aux points, lignes et rubans). */
const FACING = /* glsl */ `
  float facingOf(vec3 local, vec4 mv) {
    vec3 nV = normalize(normalMatrix * normalize(local));
    return dot(nV, normalize(-mv.xyz));
  }
`;

export const GRID_VERT = /* glsl */ `
  ${FACING}
  varying float vFacing;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFacing = smoothstep(0.05, 0.6, facingOf(position, mv));
    gl_Position = projectionMatrix * mv;
  }
`;

export const GRID_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying float vFacing;
  void main() {
    gl_FragColor = vec4(uColor, uAlpha * vFacing);
  }
`;

/** Repère du radar (espace du globe) : centre, tangentes, balayage, front de vague. */
const RADAR_UNIFORMS = /* glsl */ `
  uniform vec3 uCenter;
  uniform vec3 uE1;
  uniform vec3 uE2;
  uniform float uRadarR;
  uniform float uSweep;
  uniform float uFront;
  uniform float uWaveOn;
  uniform float uShow;
`;

export const LAND_VERT = /* glsl */ `
  ${RADAR_UNIFORMS}
  ${FACING}
  uniform float uPx;
  attribute float aKind;
  varying float vFacing;
  varying float vHot;
  varying float vKind;
  void main() {
    vec3 p = normalize(position);
    float d = acos(clamp(dot(p, uCenter), -1.0, 1.0)) / uRadarR;
    float inside = 1.0 - smoothstep(0.92, 1.0, d);
    float a = atan(dot(p, uE2), dot(p, uE1) + 1e-6);
    float lag = mod(a - uSweep, 6.2831853);
    float sweep = inside * exp(-lag * 1.5);
    float wave = inside * uWaveOn * (1.0 - smoothstep(0.0, 0.07, abs(d - uFront)));
    vHot = clamp(max(sweep * 0.85, wave), 0.0, 1.0) * uShow;
    vKind = aKind;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFacing = smoothstep(0.0, 0.42, facingOf(position, mv));
    gl_PointSize = uPx * (1.0 + 0.45 * vHot + 0.12 * aKind);
    gl_Position = projectionMatrix * mv;
  }
`;

export const LAND_FRAG = /* glsl */ `
  uniform vec3 uLand;
  uniform vec3 uBrand;
  varying float vFacing;
  varying float vHot;
  varying float vKind;
  void main() {
    float disc = 1.0 - smoothstep(0.3, 0.5, length(gl_PointCoord - 0.5));
    if (disc <= 0.0) discard;
    float lime = clamp(vKind * 0.7 + vHot, 0.0, 1.0);
    gl_FragColor = vec4(mix(uLand, uBrand, lime), disc * vFacing * mix(0.5, 1.0, lime));
  }
`;

export const RADAR_VERT = /* glsl */ `
  ${FACING}
  varying vec3 vLocal;
  varying float vFacing;
  void main() {
    vLocal = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFacing = smoothstep(0.0, 0.35, facingOf(position, mv));
    gl_Position = projectionMatrix * mv;
  }
`;

export const RADAR_FRAG = /* glsl */ `
  ${RADAR_UNIFORMS}
  uniform vec3 uBrand;
  uniform float uActiveRing;
  varying vec3 vLocal;
  varying float vFacing;
  void main() {
    vec3 p = normalize(vLocal);
    float d = acos(clamp(p.y, -1.0, 1.0)) / uRadarR;
    float a = atan(p.z, -p.x + 1e-6);
    float lag = mod(a - uSweep, 6.2831853);
    float inside = 1.0 - smoothstep(0.98, 1.01, d);
    float trail = exp(-lag * 2.2) * 0.3 * inside;
    float edge = exp(-lag * 60.0) * 0.6 * inside;
    // Anneaux 4, 8, 12 et 16 km
    float rd = d * 4.0;
    float ringIdx = floor(rd + 0.5);
    float aa = fwidth(rd);
    float ring = (1.0 - smoothstep(aa * 0.5, aa * 1.6, abs(rd - ringIdx))) * step(0.5, ringIdx) * step(ringIdx, 4.5);
    float lit = (1.0 - step(0.5, abs(ringIdx - uActiveRing))) * uWaveOn;
    float rings = ring * (0.3 + 0.6 * lit);
    float front = uWaveOn * (1.0 - smoothstep(0.0, 0.045, abs(d - uFront))) * 0.5;
    float veil = uWaveOn * (1.0 - smoothstep(uFront - 0.02, uFront, d)) * 0.045;
    float disk = 0.035 * (1.0 - smoothstep(0.97, 1.0, d));
    float fade = 1.0 - smoothstep(1.03, 1.08, d);
    float alpha = (disk + trail + edge + rings + front + veil) * fade * vFacing * uShow;
    gl_FragColor = vec4(uBrand, alpha);
  }
`;

export const DRIVER_VERT = /* glsl */ `
  ${FACING}
  uniform float uPx;
  uniform float uCt;
  uniform float uAfter;
  uniform float uAccepted;
  uniform float uShow;
  attribute float aReach;
  attribute float aIdx;
  varying float vOffer;
  varying float vFacing;
  varying float vAlpha;
  void main() {
    float isAccepted = 1.0 - step(0.5, abs(aIdx - uAccepted));
    vOffer = step(aReach, uCt) * (1.0 - uAfter);
    vAlpha = uShow * (1.0 - isAccepted * uAfter);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFacing = smoothstep(0.0, 0.35, facingOf(position, mv));
    gl_PointSize = uPx * (1.0 + 0.35 * vOffer);
    gl_Position = projectionMatrix * mv;
  }
`;

export const DRIVER_FRAG = /* glsl */ `
  uniform vec3 uIdle;
  uniform vec3 uOffer;
  varying float vOffer;
  varying float vFacing;
  varying float vAlpha;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    float core = 1.0 - smoothstep(0.16, 0.24, r);
    float halo = (1.0 - smoothstep(0.1, 0.5, r)) * 0.35 * vOffer;
    float a = (core * mix(0.8, 1.0, vOffer) + halo) * vFacing * vAlpha;
    if (a <= 0.004) discard;
    gl_FragColor = vec4(mix(uIdle, uOffer, vOffer), a);
  }
`;

/** Marqueur (prise en charge, chauffeur retenu, destination) : cœur, halo et onde. */
export const MARK_VERT = /* glsl */ `
  ${FACING}
  uniform float uPx;
  varying float vFacing;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFacing = smoothstep(0.0, 0.3, facingOf(position, mv));
    gl_PointSize = uPx;
    gl_Position = projectionMatrix * mv;
  }
`;

export const MARK_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uCore;
  uniform float uPulse;
  varying float vFacing;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float core = 1.0 - smoothstep(uCore * 0.75, uCore, r);
    float halo = (1.0 - smoothstep(uCore, 0.62, r)) * 0.28;
    float ringR = mix(uCore, 1.0, uPulse);
    float ring = (1.0 - smoothstep(0.0, 0.06, abs(r - ringR))) * (1.0 - uPulse) * 0.8;
    float a = (core + halo + ring) * uAlpha * vFacing;
    if (a <= 0.004) discard;
    gl_FragColor = vec4(uColor, min(a, 1.0));
  }
`;

/** Ruban face à la caméra le long d'un arc de a à b (largeur en unités du monde). */
const RIBBON = /* glsl */ `
  vec3 arcPoint(vec3 a, vec3 b, float lift, float t) {
    float omega = acos(clamp(dot(a, b), -1.0, 1.0));
    vec3 p = a;
    if (omega > 1e-5) {
      float s = sin(omega);
      p = (sin((1.0 - t) * omega) / s) * a + (sin(t * omega) / s) * b;
    }
    return p * (1.0 + lift * sin(3.14159265 * t));
  }
  vec4 ribbonVertex(vec3 a, vec3 b, float lift, float t, float side, float width, out float facing) {
    vec3 p0 = arcPoint(a, b, lift, t);
    vec4 v0 = modelViewMatrix * vec4(p0, 1.0);
    vec4 vPrev = modelViewMatrix * vec4(arcPoint(a, b, lift, max(t - 0.01, 0.0)), 1.0);
    vec4 vNext = modelViewMatrix * vec4(arcPoint(a, b, lift, min(t + 0.01, 1.0)), 1.0);
    vec3 dv = vNext.xyz - vPrev.xyz;
    vec3 tangent = length(dv) > 1e-7 ? normalize(dv) : vec3(1.0, 0.0, 0.0);
    v0.xyz += normalize(cross(tangent, normalize(-v0.xyz))) * side * width;
    vec3 nV = normalize(normalMatrix * normalize(p0));
    facing = smoothstep(-0.1, 0.3, dot(nV, normalize(-v0.xyz)));
    return v0;
  }
`;

export const ARC_VERT = /* glsl */ `
  ${RIBBON}
  uniform vec3 uA;
  uniform vec3 uB;
  uniform float uLift;
  uniform float uWidth;
  attribute float aT;
  attribute float aSide;
  varying float vT;
  varying float vSide;
  varying float vFacing;
  void main() {
    float facing;
    vec4 v = ribbonVertex(uA, uB, uLift, aT, aSide, uWidth, facing);
    vT = aT;
    vSide = aSide;
    vFacing = facing;
    gl_Position = projectionMatrix * v;
  }
`;

export const ARC_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uFrom;
  uniform float uTo;
  uniform float uAlpha;
  varying float vT;
  varying float vSide;
  varying float vFacing;
  void main() {
    if (vT < uFrom || vT > uTo) discard;
    float across = 1.0 - smoothstep(0.35, 1.0, abs(vSide));
    float along = (vT - uFrom) / max(uTo - uFrom, 1e-4);
    float head = exp(-(uTo - vT) * 40.0);
    float a = (mix(0.2, 0.8, along) + head) * across * uAlpha * vFacing;
    gl_FragColor = vec4(uColor, min(a, 1.0));
  }
`;

/** Offres envoyées : un trait part de la prise en charge vers chaque chauffeur atteint par la vague. */
export const BEAM_VERT = /* glsl */ `
  ${RIBBON}
  uniform vec3 uCenter;
  uniform float uWidth;
  attribute vec3 aDir;
  attribute float aT;
  attribute float aSide;
  attribute float aReach;
  varying float vT;
  varying float vSide;
  varying float vFacing;
  varying float vReach;
  void main() {
    float facing;
    vec4 v = ribbonVertex(uCenter, aDir, 0.01, aT, aSide, uWidth, facing);
    vT = aT;
    vSide = aSide;
    vFacing = facing;
    vReach = aReach;
    gl_Position = projectionMatrix * v;
  }
`;

export const BEAM_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uCt;
  uniform float uAfter;
  uniform float uShow;
  varying float vT;
  varying float vSide;
  varying float vFacing;
  varying float vReach;
  void main() {
    float age = uCt - vReach;
    if (age < 0.0 || vT > clamp(age / 0.35, 0.0, 1.0)) discard;
    float across = 1.0 - smoothstep(0.3, 1.0, abs(vSide));
    float a = exp(-age * 1.6) * (1.0 - uAfter) * across * mix(0.25, 0.9, vT) * vFacing * uShow;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;
