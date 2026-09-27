import { describe, expect, it } from "vitest";
import { decodeLand, LAND_ROWS, landRows, latLonToVec, rowCount } from "./globe-data";

// Masque des terres du globe de l'accueil : une ligne mal découpée décalerait toutes les suivantes et donnerait
// un globe illisible sans aucune erreur. Ces tests vérifient le décodage et la géographie obtenue.

type Vec = readonly [number, number, number];

const points = (positions: Float32Array): Vec[] =>
  Array.from({ length: positions.length / 3 }, (_, i) => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!] as const);

const toLatLon = ([x, y, z]: Vec) => ({ lat: (Math.asin(y) * 180) / Math.PI, lon: (Math.atan2(x, z) * 180) / Math.PI });

/** Un point de la liste à moins de `deg` degrés (arc de grand cercle) de (lat, lon). */
const near = (list: Vec[], lat: number, lon: number, deg: number) => {
  const [tx, ty, tz] = latLonToVec(lat, lon);
  const min = Math.cos((deg * Math.PI) / 180);
  return list.some(([x, y, z]) => x * tx + y * ty + z * tz >= min);
};

describe("masque des terres (globe-data)", () => {
  const full = decodeLand(1);
  const land = points(full.positions);
  const france = land.filter((_, i) => full.kinds[i] === 1);

  it("lit la chaîne jusqu'au bout, chaque ligne tombant juste", () => {
    const rows = landRows();
    expect(rows).toHaveLength(LAND_ROWS);
    rows.forEach((runs, row) => {
      expect(runs.reduce((a, b) => a + b, 0)).toBe(rowCount(row));
    });
  });

  it("donne des points sur la sphère unité, une part de terres réaliste", () => {
    expect(full.count).toBe(full.kinds.length);
    expect(full.positions.length).toBe(full.count * 3);
    for (const [x, y, z] of land) expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5);
    // Points à égale distance : la part de points sur terre ≈ la part des terres émergées (29 %)
    let grid = 0;
    for (let row = 0; row < LAND_ROWS; row++) grid += rowCount(row);
    expect(full.count / grid).toBeGreaterThan(0.25);
    expect(full.count / grid).toBeLessThan(0.33);
  });

  it("place les terres et les océans au bon endroit", () => {
    const lands: [string, number, number][] = [
      ["Sahara", 23, 10],
      ["Sibérie", 62, 100],
      ["Amazonie", -8, -60],
      ["Australie", -25, 134],
      ["Grandes Plaines", 40, -100],
      ["Antarctique", -80, 30],
    ];
    for (const [name, lat, lon] of lands) expect(near(land, lat, lon, 1), name).toBe(true);
    const oceans: [string, number, number][] = [
      ["Atlantique Nord", 30, -40],
      ["Pacifique", 0, -140],
      ["océan Indien", -30, 80],
      ["Atlantique Sud", -30, -15],
    ];
    for (const [name, lat, lon] of oceans) expect(near(land, lat, lon, 1.5), name).toBe(false);
  });

  it("marque la France métropolitaine, et elle seule", () => {
    expect(france.length).toBeGreaterThanOrEqual(40);
    for (const p of france) {
      const { lat, lon } = toLatLon(p);
      expect(lat).toBeGreaterThan(41);
      expect(lat).toBeLessThan(51.5);
      expect(lon).toBeGreaterThan(-5.5);
      expect(lon).toBeLessThan(10);
    }
    // Paris (prise en charge du radar) et la Corse
    expect(near(france, 48.86, 2.35, 1.2)).toBe(true);
    expect(near(france, 42.1, 9.1, 1.2)).toBe(true);
    // Pas de France en Espagne ni en Allemagne
    expect(near(france, 40.4, -3.7, 1.5)).toBe(false);
    expect(near(france, 52.5, 13.4, 1.5)).toBe(false);
  });

  it("allège la grille sur les petits écrans (une ligne et un point sur deux)", () => {
    const light = decodeLand(2);
    expect(light.count / full.count).toBeGreaterThan(0.2);
    expect(light.count / full.count).toBeLessThan(0.3);
    expect(Array.from(light.kinds).filter((k) => k === 1).length).toBeGreaterThan(5);
  });
});
