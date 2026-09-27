"use client";
// Super admin : l'erreur s'affiche dans la zone de contenu, la barre latérale (layout) reste utilisable.
import { ErrorFallback } from "@/components/errors/error-fallback";

export default function AdminError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorFallback error={error} retry={retry} />;
}
