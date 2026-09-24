// Variables d'environnement — les clés privées ne quittent JAMAIS le serveur.
export const env = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  rootDomain: process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "rydar.app",
  mapStyleUrl:
    process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
};

export function serverEnv() {
  if (typeof window !== "undefined") throw new Error("serverEnv() est réservé au serveur");
  return {
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY ?? "",
    apiKeyPepper: process.env.API_KEY_PEPPER ?? "",
    redisUrl: process.env.REDIS_URL ?? "",
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    geocoder: (process.env.GEOCODER_PROVIDER ?? "geopf") as "geopf" | "google" | "mapbox",
    googleMapsKey: process.env.GOOGLE_MAPS_API_KEY ?? "",
    mapboxToken: process.env.MAPBOX_TOKEN ?? "",
  };
}
