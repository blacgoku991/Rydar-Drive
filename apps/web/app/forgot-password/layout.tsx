import type { Metadata } from "next";

/** Titre de la page (la page est un composant client, qui ne peut pas déclarer ses métadonnées). */
export const metadata: Metadata = { title: "Mot de passe oublié" };

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
