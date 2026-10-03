import { NETWORK_DOCUMENTS, NETWORK_TERMS_REVIEWED } from "@rydar/shared";
import type { Metadata } from "next";
import { NETWORK_DRIVER_TERMS } from "@/components/legal/network-terms";
import { NetworkTermsDocument } from "@/components/legal/network-terms-page";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: `${NETWORK_DRIVER_TERMS.title} — Rydar Drive` },
  description: NETWORK_DRIVER_TERMS.description,
  // Texte en relecture juridique : pas d'indexation tant qu'il n'est pas relu
  ...(NETWORK_TERMS_REVIEWED ? {} : { robots: { index: false, follow: true } }),
};

/** Conditions des chauffeurs (document « network_driver », acceptées dans l'application par chaque chauffeur). */
export default function NetworkDriverTermsPage() {
  return <NetworkTermsDocument doc={NETWORK_DRIVER_TERMS} related={{ href: NETWORK_DOCUMENTS.network.path, label: "Convention entre organisations" }} />;
}
