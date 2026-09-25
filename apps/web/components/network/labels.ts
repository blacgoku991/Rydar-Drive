// Mode centrale côté rattacheur : libellés et petits calculs d'affichage.
// Module neutre (ni « use client » ni « server-only ») : importable par les pages serveur et les composants client.
import type { FraudReport, IdentityKind, Tone } from "@rydar/shared";
import { env } from "@/lib/env";

/** Statut d'un signalement vu par la centrale qui l'a envoyé. */
export const REPORT_STATUS_FOR_ORG: Record<FraudReport["status"], { label: string; tone: Tone; help: string }> = {
  open: { label: "En examen chez Rydar", tone: "amber", help: "Rydar décide d'un éventuel bannissement sur toute la plateforme." },
  platform_banned: { label: "Banni de toute la plateforme", tone: "red", help: "Ses identités sont refusées dans toutes les centrales Rydar Drive." },
  dismissed: { label: "Classé par Rydar", tone: "neutral", help: "Le bannissement reste limité à votre centrale." },
  lifted: { label: "Levé par Rydar", tone: "blue", help: "Bannissement plateforme levé ; il reste banni chez vous." },
};

/** Ordre d'affichage des identités bannies. */
export const IDENTITY_ORDER: IdentityKind[] = ["phone", "email", "vtc_card", "driving_license", "identity_doc", "plate", "device"];

/** URL publique du lien d'inscription. */
export function joinUrl(code: string) {
  return `${env.appUrl.replace(/\/$/, "")}/rejoindre/${code}`;
}

/** Message prêt à coller dans un groupe WhatsApp / Telegram. */
export function joinMessage(orgName: string, url: string) {
  return `Rejoignez le réseau ${orgName} sur Rydar Drive : ${url}`;
}

/** Nom complet « Prénom Nom ». */
export const fullName = (d: { first_name: string; last_name: string }) => `${d.first_name} ${d.last_name}`.trim();
