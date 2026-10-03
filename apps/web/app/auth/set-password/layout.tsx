import type { Metadata } from "next";

/** Titre de la page (la page est un composant client, qui ne peut pas déclarer ses métadonnées). */
export const metadata: Metadata = { title: "Nouveau mot de passe" };

export default function SetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
