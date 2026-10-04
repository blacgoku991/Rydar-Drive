import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Toaster } from "sonner";
import { CookieNotice } from "@/components/legal/cookie-notice";
import { COOKIE_NOTICE_SCRIPT } from "@/components/legal/cookie-notice-script";
import { env } from "@/lib/env";
import "./globals.css";

/** Base des URL absolues des métadonnées (canonical, og:image) : l'URL de l'application, localhost à défaut. */
function appBaseUrl() {
  try {
    return new URL(env.appUrl);
  } catch {
    return new URL("http://localhost:3000");
  }
}

// Pas d'image ni de nom de site Open Graph par défaut : ils seraient hérités par les pages publiques des centrales
// (mini-site /book/[slug] en marque blanche, lien d'inscription /rejoindre/[code]). Chaque page publique de Rydar
// déclare les siens (site vitrine : marketingMetadata, components/marketing/seo.ts).
export const metadata: Metadata = {
  metadataBase: appBaseUrl(),
  title: { default: "Rydar Drive — Dispatch VTC temps réel", template: "%s · Rydar Drive" },
  description:
    "Rydar Drive remplace les groupes WhatsApp : réservations, dispatch automatique au plus proche et suivi temps réel de votre flotte VTC.",
  applicationName: "Rydar Drive",
  icons: { icon: "/icon.svg" },
  openGraph: { type: "website", locale: "fr_FR" },
};

// Geist et Geist Mono (paquet « geist »), réduits aux caractères latins : latin étendu, ponctuation, monnaies,
// flèches, symboles ; ni grec ni cyrillique (un caractère absent s'affiche dans la police du système). Sans 51 Ko au
// lieu de 68, Mono 50 au lieu de 69. Mono n'est pas préchargée : rare en haut de page, chargée à son premier usage.
// Régénérer (fontTools) : subset.Subsetter, layout_features ["*"], plages U+0000-024F, U+0259, U+02B0-036F,
// U+1E00-1EFF, U+2000-20CF, U+2100-214F, U+2190-23FF, U+25A0-27BF, U+FB00-FB06, U+FEFF, U+FFFD, sortie woff2.
const GeistSans = localFont({ src: "./fonts/Geist-Variable.latin.woff2", variable: "--font-geist-sans", weight: "100 900" });
const GeistMono = localFont({
  src: "./fonts/GeistMono-Variable.latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  preload: false,
});

export const viewport: Viewport = {
  themeColor: "#07080b",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Bandeau cookies déjà fermé : masqué avant la première peinture (components/legal/cookie-notice-script.ts) */}
        <script dangerouslySetInnerHTML={{ __html: COOKIE_NOTICE_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-ink-900 text-fg antialiased">
        {children}
        <CookieNotice href="/cookies" />
        <Toaster
          theme="dark"
          position="bottom-right"
          offset={{ top: 84 }}
          toastOptions={{
            classNames: {
              toast: "!bg-ink-700 !border !border-white/10 !text-fg !rounded-xl !shadow-[0_24px_60px_-24px_rgb(0_0_0/0.9)]",
              description: "!text-fg-muted",
              success: "[&_[data-icon]]:!text-brand",
              error: "[&_[data-icon]]:!text-red",
            },
          }}
        />
      </body>
    </html>
  );
}
