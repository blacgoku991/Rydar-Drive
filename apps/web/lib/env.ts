// Variables d'environnement — les clés privées ne quittent JAMAIS le serveur.
export const env = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "",
  appUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
  rootDomain: process.env.NEXT_PUBLIC_ROOT_DOMAIN || "rydar.app",
  mapStyleUrl:
    process.env.NEXT_PUBLIC_MAP_STYLE_URL || "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
};

export function serverEnv() {
  if (typeof window !== "undefined") throw new Error("serverEnv() est réservé au serveur");
  return {
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "",
    apiKeyPepper: process.env.API_KEY_PEPPER || "",
    redisUrl: process.env.REDIS_URL || "",
    stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
    geocoder: (process.env.GEOCODER_PROVIDER || "geopf") as "geopf" | "ban" | "google" | "mapbox",
    /** URL de base du géocodeur geopf / BAN (défaut : services publics IGN / BAN). */
    geocoderUrl: process.env.GEOCODER_URL || "",
    routing: (process.env.ROUTING_PROVIDER || "osrm") as "osrm" | "mapbox" | "google" | "none",
    /** OSRM auto-hébergé recommandé en production (le serveur public de démo est limité). */
    osrmUrl: process.env.OSRM_URL || "https://router.project-osrm.org",
    googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || "",
    mapboxToken: process.env.MAPBOX_TOKEN || "",
  };
}
