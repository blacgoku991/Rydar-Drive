"use client";
// Pages publiques (accueil, connexion, mini-site, inscription…) et mises en page des espaces : erreur d'affichage.
import { ErrorFallback } from "@/components/errors/error-fallback";

export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorFallback error={error} retry={retry} fullScreen />;
}
