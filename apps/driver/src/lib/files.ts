// Préparation d'un justificatif (photo) pour le stockage : octets + type MIME + extension.
import type { ImagePickerAsset } from "expo-image-picker";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Base64 (ou data URL) → ArrayBuffer, sans dépendance (Hermes n'a pas toujours atob). */
export function base64ToArrayBuffer(input: string): ArrayBuffer {
  const clean = input.replace(/^data:[^,]*,/, "").replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = LOOKUP[clean.charCodeAt(i)]!;
    const b = LOOKUP[clean.charCodeAt(i + 1)]!;
    const c = i + 2 < clean.length ? LOOKUP[clean.charCodeAt(i + 2)]! : 0;
    const d = i + 3 < clean.length ? LOOKUP[clean.charCodeAt(i + 3)]! : 0;
    out[o++] = (a << 2) | (b >> 4);
    if (i + 2 < clean.length) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (i + 3 < clean.length) out[o++] = ((c & 3) << 6) | d;
  }
  return out.buffer.slice(0, o);
}

export const extensionFor = (mime: string) => (/png/i.test(mime) ? "png" : /pdf/i.test(mime) ? "pdf" : /webp/i.test(mime) ? "webp" : "jpg");

/** Octets d'une image choisie : fichier navigateur, base64 (natif), sinon lecture de l'URI. */
export async function assetBytes(asset: ImagePickerAsset): Promise<ArrayBuffer> {
  const file = (asset as ImagePickerAsset & { file?: Blob | null }).file;
  if (file && typeof file.arrayBuffer === "function") return file.arrayBuffer();
  if (asset.base64) return base64ToArrayBuffer(asset.base64);
  if (asset.uri.startsWith("data:")) return base64ToArrayBuffer(asset.uri);
  const res = await fetch(asset.uri);
  return res.arrayBuffer();
}

/** « 1203202 » → « 12/03/202 » : masque JJ/MM/AAAA pendant la saisie. */
export function maskDate(raw: string) {
  const d = raw.replace(/\D/g, "").slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

/** « 12/03/2027 » → « 2027-03-12 », null si la date n'existe pas. */
export function parseFrDate(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  if (d.getUTCFullYear() !== Number(yyyy) || d.getUTCMonth() !== Number(mm) - 1 || d.getUTCDate() !== Number(dd)) return null;
  return `${yyyy}-${mm}-${dd}`;
}

/** « 2027-03-12 » → « 12/03/2027 » */
export const formatIsoDay = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");
