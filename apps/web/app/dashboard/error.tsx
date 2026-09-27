"use client";
// Tableau de bord : l'erreur s'affiche dans la zone de contenu, la barre latérale (layout) reste utilisable.
import { ErrorFallback } from "@/components/errors/error-fallback";

export default function DashboardError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorFallback error={error} retry={retry} />;
}
