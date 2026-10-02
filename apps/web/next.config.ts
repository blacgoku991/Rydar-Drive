import path from "node:path";
import type { NextConfig } from "next";

// Image Docker (VPS) : serveur autonome, dépendances tracées depuis la racine du monorepo
const standalone = process.env.NEXT_OUTPUT === "standalone";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseOrigin = supabaseUrl ? new URL(supabaseUrl).origin : "";
const supabaseWs = supabaseOrigin.replace(/^http/, "ws");
const mapOrigins = (process.env.NEXT_PUBLIC_MAP_CONNECT_ORIGINS || "https://*.basemaps.cartocdn.com https://basemaps.cartocdn.com https://tiles.openfreemap.org https://api.maptiler.com https://api.mapbox.com")
  .split(/\s+/)
  .filter(Boolean);

const csp = (frameAncestors: string) =>
  [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${supabaseOrigin} ${supabaseWs} https://*.supabase.co wss://*.supabase.co ${mapOrigins.join(" ")}`,
    "worker-src 'self' blob:",
    "child-src blob:",
    "frame-src 'self' https://checkout.stripe.com https://billing.stripe.com",
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'self'",
    "form-action 'self' https://checkout.stripe.com",
  ].join("; ");

const baseHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self), payment=()" },
];

const nextConfig: NextConfig = {
  output: standalone ? "standalone" : undefined,
  outputFileTracingRoot: standalone ? path.join(process.cwd(), "..", "..") : undefined,
  transpilePackages: ["@rydar/shared"],
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    // Liens universels iOS et liens d'application Android (inscription chauffeur dans l'application)
    return [
      { source: "/.well-known/apple-app-site-association", destination: "/api/app-links/apple" },
      { source: "/.well-known/assetlinks.json", destination: "/api/app-links/android" },
    ];
  },
  async headers() {
    return [
      {
        // Tuiles / polices de la carte locale (dev) : lisibles par l'aperçu web de l'app chauffeur
        source: "/dev-map/:path*",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
      {
        // Worker MapLibre, copié sous un chemin versionné (scripts/copy-maplibre.mjs) : gardé un an par le navigateur,
        // au lieu de deux revalidations l'une après l'autre (worker puis module partagé) à chaque carte ouverte
        source: "/vendor/maplibre/:version(\\d+\\.\\d+\\.\\d+[^/]*)/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/((?!book|embed).*)",
        headers: [...baseHeaders, { key: "X-Frame-Options", value: "DENY" }, { key: "Content-Security-Policy", value: csp("'none'") }],
      },
      {
        // Le mini-site peut être intégré en iframe sur le site du rattacheur
        source: "/(book|embed)/:path*",
        headers: [...baseHeaders, { key: "Content-Security-Policy", value: csp("*") }],
      },
    ];
  },
};

export default nextConfig;
