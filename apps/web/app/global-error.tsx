"use client";
// Erreur dans la mise en page racine : remplace tout le document (ni polices Geist ni Toaster ici ; les jetons de
// globals.css restent disponibles, la police retombe sur celle du système).
import { ErrorFallback } from "@/components/errors/error-fallback";
import "./globals.css";

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="fr" style={{ colorScheme: "dark" }}>
      <body className="min-h-dvh bg-ink-900 text-fg antialiased">
        <title>Une erreur est survenue</title>
        <ErrorFallback error={error} retry={retry} fullScreen />
      </body>
    </html>
  );
}
