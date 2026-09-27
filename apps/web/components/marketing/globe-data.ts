// Données du globe de la page d'accueil (globe-scene.tsx). Aucune ressource externe : tout est embarqué ici.
//
// Masque des terres : Natural Earth 1:50 000 (domaine public), échantillonné sur des lignes de latitude au pas de
// LAND_STEP degrés (nombre de points par ligne proportionnel au cosinus de la latitude : points à égale distance).
// Chaque ligne est une suite de longueurs de plages alternées mer / terre (la première est la mer, éventuellement
// vide), codées sur 1 caractère (longueur < 64) ou 2 caractères (voir decodeRun).

export const LAND_STEP = 1;

const LAND_RUNS =
  "39gmszg1od224qd41511se11218a111jf51881c1fd113121a62g1fi2113a71i1ge11111142bk173gg311135aj24116629f1818ak176jg2" +
  "61136al15117131141ag523146an1411g32a01h114555bn23k25972e3211758j1c21s7682311153121145bf4a41x121014j2152112369g" +
  "821291B024l1712111348ja2P044t644771b8122a1H212x636565b4142W6A21136583b51$&18w216364m52$*17x41213184m52$%15117y" +
  "83b3n52$%35331391p84c1o6231!336947n9421z7311Z21319c2811l8512u152132#929c1119n88u37211111Za39b1ep68w162113$%a49" +
  "rr4av2724$%b4ast1dt112a11$)b3bs21r2er2224$?92ct11t2es2141$]1181dxt1ex22$|81ex11G11w13$~11nzC62A%112nBE43w%7qCE" +
  "62y%521pDEIm13183WtDF12Gm22174XuEE12J92a31362!41qEEJ224122229863Y53pFDK9411237a53W63rGDL973363346211UCGCO76143" +
  "134g2Q1591tHDO7213151323h3P2121a2tICQ7c1323h4O6382uKAS6b2523h4S4272vLBT2489151121$*4263wMBZ9l$)5336wNAWel$*613" +
  "211AQwXgk$-4123DRvYk539$.81FS21rZm457$/81FT12r!o1$|PU12f3252!O2#OW11dc2ZE1c2!PW22bd2YF2c3YRY12bd2YG2d6USZ12be1" +
  "XJ2d761LT!139$:K2d329L21R$$128k1SM2j9I31S$*7d112WN3j9FZk1N7823132UO2j9h4f21$$$+86393SO3hed5d31$%n1L853e3OP3gec" +
  "8b32$%$-933d11431JP4egaab31$&$:c$*R3chabbd2T$=a$*R3ak8c21ac2T$^8$%T39l6hab2U$_9l1GV16p5hb$*$}6$%V14r5iac1U%04$" +
  "%Xa1k5h227b221R%22b121QW62o4i145d121R%328921MV16p4i153b121U%42313eL$$p211o1g121R%541h11K#q121h2o2R%812jK!u2h1o" +
  "2R%ckKe1Jv1j1f14113R%coHa5HQ2d3Z%cqV21DM233a5Z%crYBO22394#%crZAQ22277a1P%btYyT31159a1P%atYyU4693341P%awVxW3114" +
  "9912111L%9s1313SxX367235142K%9v14TvY63723e5D%9GNt!4914241312bA%8INs#3e1fay%9JLr$%1e1h851s%9JLr$&3p14971o%aILq$" +
  ")5q9w%aHMq$.1411232d332v%aGNq$=141m2a1j%aFNr%h1t%bDOq$}11191A%bBPq81$>651A%bAOr82$<662z%bANs72$/12663y%bzNs53$" +
  "-c54k1c%dwNr45$,e34w1%dvNo66$*h15w%etNn75$*nw%dtOl85$)ov%dsOk94$%te1e%crPk84#vf1d%cqQj84Zyr%aoSj84Yzq%alUj83YA" +
  "p%9kVgb1ZAo%8jWf$-Ao%7jVf$.zn%5kVe$.yn%4jWd$-yn%3jWb$.xn%2hYa$.wn%2gX9$/87gn%0gX8$.7921bo$~b13Y1$>3d12ao$|d%*a" +
  "j14${d%)8o$_d%&8k13$]c%)111m31$[9&232$@9%}1113$?6%)2i33$>7%#2i15$=5%#1h25$:7%;36$/5%/36$-6%-17$,6%;$*6%/$)5%,$" +
  "(4%)$(252%W$$3%!#211%V#3h1%z&o&j&d&8&3%|%[%;S2%fP1%dM1%a%23h3124113hG2I49neF1Db3q119B4Aa3t7A3n1124d1u6x212ho1v" +
  "3o17112eo1u3n41114cQ4g32acN4ajbK48i9J4511g9G1125e1111312E3311e512z45c21112w34d3u34b111r21D1011x0s0m0g0903";

/** France métropolitaine (Corse comprise) : [ligne, premier point, nombre de points] dans la grille ci-dessus. */
const FRANCE_RUNS: ReadonlyArray<readonly [number, number, number]> = [
  [39, 115, 2],
  [40, 117, 4],
  [41, 116, 9],
  [42, 120, 7],
  [43, 123, 5],
  [44, 125, 6],
  [45, 128, 5],
  [46, 129, 4],
  [46, 134, 2],
  [47, 134, 1],
  [47, 139, 1],
];

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&()*+,-./:;<=>?@[]^_{|}~";
const SMALL = 64;

export type LatLon = readonly [lat: number, lon: number];

/** Point de la sphère unité : longitude 0 face à +z, pôle Nord en +y. */
export function latLonToVec(lat: number, lon: number): [number, number, number] {
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
}

/** Nombre de lignes de latitude de la grille (du pôle Nord au pôle Sud). */
export const LAND_ROWS = Math.round(180 / LAND_STEP);

/** Nombre de points de la ligne `row` (même formule que le générateur). */
export function rowCount(row: number): number {
  const lat = 90 - (row + 0.5) * LAND_STEP;
  return Math.max(1, Math.round((360 / LAND_STEP) * Math.cos((lat * Math.PI) / 180)));
}

/**
 * Plages de chaque ligne (longueurs alternées mer / terre, la première est la mer), lues dans LAND_RUNS.
 * Lève une erreur si les données sont mal formées (caractère inconnu, ligne qui ne tombe pas juste, reste
 * de la chaîne non lu) : un décalage donnerait sinon un globe illisible sans aucune erreur.
 */
export function landRows(): number[][] {
  let cursor = 0;
  const digit = () => {
    const d = ALPHABET.indexOf(LAND_RUNS.charAt(cursor++));
    if (d < 0) throw new Error(`Masque des terres : caractère invalide en position ${cursor - 1}`);
    return d;
  };
  const decodeRun = () => {
    const first = digit();
    return first < SMALL ? first : (first - SMALL) * ALPHABET.length + digit();
  };
  const rows: number[][] = [];
  for (let row = 0; row < LAND_ROWS; row++) {
    const n = rowCount(row);
    const runs: number[] = [];
    let j = 0;
    while (j < n) {
      const len = decodeRun();
      runs.push(len);
      j += len;
    }
    if (j !== n) throw new Error(`Masque des terres : la ligne ${row} compte ${j} points au lieu de ${n}`);
    rows.push(runs);
  }
  if (cursor !== LAND_RUNS.length) throw new Error("Masque des terres : données en trop après la dernière ligne");
  return rows;
}

/**
 * Points des terres sur la sphère unité (x, y, z à la suite) et genre de chaque point (1 : France, 0 : ailleurs).
 * `stride` > 1 allège la grille (une ligne et un point sur `stride`) pour les petits écrans.
 */
export function decodeLand(stride = 1): { positions: Float32Array; kinds: Float32Array; count: number } {
  const france = new Map<number, Array<readonly [number, number]>>();
  for (const [row, start, len] of FRANCE_RUNS) {
    const list = france.get(row) ?? [];
    list.push([start, start + len]);
    france.set(row, list);
  }
  const pos: number[] = [];
  const kinds: number[] = [];
  landRows().forEach((runs, row) => {
    if (row % stride !== 0) return;
    const n = rowCount(row);
    const lat = 90 - (row + 0.5) * LAND_STEP;
    const frRanges = france.get(row);
    let j = 0;
    runs.forEach((len, r) => {
      // Plages impaires : terre
      if (r % 2 === 1) {
        for (let k = j; k < j + len; k++) {
          if (k % stride !== 0) continue;
          const lon = -180 + ((k + 0.5) * 360) / n;
          const [x, y, z] = latLonToVec(lat, lon);
          pos.push(x, y, z);
          kinds.push(frRanges?.some(([a, b]) => k >= a && k < b) ? 1 : 0);
        }
      }
      j += len;
    });
  });
  return { positions: new Float32Array(pos), kinds: new Float32Array(kinds), count: kinds.length };
}

/** Villes de la scène (latitude, longitude) : la prise en charge (Paris) et les destinations des courses. */
export const CITIES = {
  paris: [48.8566, 2.3522],
  lyon: [45.764, 4.8357],
  bordeaux: [44.8378, -0.5792],
  strasbourg: [48.5734, 7.7521],
  toulouse: [43.6047, 1.4442],
  marseille: [43.2965, 5.3698],
  geneve: [46.2044, 6.1432],
  nice: [43.7102, 7.262],
} as const satisfies Record<string, LatLon>;

export type CityKey = keyof typeof CITIES;

/** Centre du radar : la prise en charge. */
export const RADAR_CENTER: LatLon = CITIES.paris;

/** Destination de la course, cycle après cycle (arc lumineux parcouru par le chauffeur). */
export const DESTINATIONS: readonly CityKey[] = ["lyon", "bordeaux", "strasbourg", "toulouse", "marseille", "geneve", "nice"];
