import { NETWORK_DOCUMENTS, NETWORK_TERMS_REVIEWED } from "@rydar/shared";
import type { Metadata } from "next";
import { NETWORK_CONVENTION } from "@/components/legal/network-terms";
import { NetworkTermsDocument } from "@/components/legal/network-terms-page";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: `${NETWORK_CONVENTION.title} — Rydar Drive` },
  description: NETWORK_CONVENTION.description,
  // Texte en relecture juridique : pas d'indexation tant qu'il n'est pas relu
  ...(NETWORK_TERMS_REVIEWED ? {} : { robots: { index: false, follow: true } }),
};

/** Convention du réseau partagé (document « network », acceptée par owner / admin dans le tableau de bord). */
export default function NetworkConventionPage() {
  return <NetworkTermsDocument doc={NETWORK_CONVENTION} related={{ href: NETWORK_DOCUMENTS.network_driver.path, label: "Conditions des chauffeurs" }} />;
}
