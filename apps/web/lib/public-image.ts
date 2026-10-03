import { env } from "@/lib/env";

/** Origine d'une adresse (« https://hote:port »), ou null si elle est invalide. */
function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Image choisie par une centrale (logo, photo de fond) affichée sur une page publique (mini-site, /rejoindre) :
 * seulement si elle est servie par la plateforme elle-même (stockage de l'installation Supabase, ou domaine de
 * l'application). Une image chargée chez un tiers lui transmettrait l'adresse IP du visiteur, et ce site pourrait y
 * déposer ses cookies : /cookies (« aucun traceur d'un tiers ») et docs/SECURITY.md (« aucune requête tierce » sur les
 * pages publiques) l'interdisent. Autre adresse : null (la page affiche l'initiale à la place).
 */
export function platformImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const origin = originOf(url);
  if (!origin) return null;
  const storage = originOf(env.supabaseUrl);
  if (storage && origin === storage) return new URL(url).pathname.startsWith("/storage/v1/object/public/") ? url : null;
  return origin === originOf(env.appUrl) ? url : null;
}
