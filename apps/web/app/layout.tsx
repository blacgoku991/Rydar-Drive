import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import { CookieNotice } from "@/components/legal/cookie-notice";
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
// déclare les siens (voir app/page.tsx).
export const metadata: Metadata = {
  metadataBase: appBaseUrl(),
  title: { default: "Rydar Drive — Dispatch VTC temps réel", template: "%s · Rydar Drive" },
  description:
    "Rydar Drive remplace les groupes WhatsApp : réservations, dispatch automatique au plus proche et suivi temps réel de votre flotte VTC.",
  applicationName: "Rydar Drive",
  icons: { icon: "/icon.svg" },
  openGraph: { type: "website", locale: "fr_FR" },
};

export const viewport: Viewport = {
  themeColor: "#07080b",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
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
