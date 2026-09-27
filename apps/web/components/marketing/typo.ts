const NBSP = "\u00a0";

/**
 * Typographie française : espace insécable avant « : ; ! ? », à l'intérieur des guillemets, et entre un nombre
 * et son unité (16 km, 300 m, 30 s, 59 €, 14 jours).
 */
export const fr = (s: string) =>
  s
    .replace(/ ([:;!?»])/g, `${NBSP}$1`)
    .replace(/« /g, `«${NBSP}`)
    .replace(/(\d) (km|m|min|s|h|€|jours)(?![\p{L}\d])/gu, `$1${NBSP}$2`);
