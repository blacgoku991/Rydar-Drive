// Inscriptions / Réseau côté organisation (flotte ou centrale) : libellés et petits calculs d'affichage (textes du lien
// d'inscription selon le modèle : join-copy.ts).
// Module neutre (ni « use client » ni « server-only ») : importable par les pages serveur et les composants client.
import type { FraudReport, IdentityKind, Tone } from "@rydar/shared";
import { env } from "@/lib/env";

/** Statut d'un signalement vu par l'organisation qui l'a envoyé (textes valables pour une flotte comme une centrale). */
export const REPORT_STATUS_FOR_ORG: Record<FraudReport["status"], { label: string; tone: Tone; help: string }> = {
  open: { label: "En examen chez Rydar", tone: "amber", help: "Rydar décide d'un éventuel bannissement sur toute la plateforme." },
  platform_banned: { label: "Banni de toute la plateforme", tone: "red", help: "Ses identités sont refusées partout sur Rydar Drive." },
  dismissed: { label: "Classé par Rydar", tone: "neutral", help: "Le bannissement ne vaut que chez vous." },
  lifted: { label: "Levé par Rydar", tone: "blue", help: "Bannissement plateforme levé ; il reste banni chez vous." },
};

/** Ordre d'affichage des identités bannies. */
export const IDENTITY_ORDER: IdentityKind[] = ["phone", "email", "vtc_card", "driving_license", "identity_doc", "plate", "device"];

/** URL publique du lien d'inscription. */
export function joinUrl(code: string) {
  return `${env.appUrl.replace(/\/$/, "")}/rejoindre/${code}`;
}

/** Nom complet « Prénom Nom ». */
export const fullName = (d: { first_name: string; last_name: string }) => `${d.first_name} ${d.last_name}`.trim();
