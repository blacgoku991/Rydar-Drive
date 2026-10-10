"use client";
// Super admin (Réglages de la plateforme) : numéro WhatsApp Business de Rydar, pour relancer par WhatsApp le
// propriétaire d'un client qui doit des frais Rydar (case « Envoyer aussi par WhatsApp » de « Relancer »).
import { WHATSAPP_TEMPLATES } from "@rydar/shared";
import { removePlatformWhatsApp, savePlatformWhatsApp, testPlatformWhatsApp } from "@/app/admin/frais/actions";
import { WhatsAppCard, type WhatsAppRow } from "@/components/whatsapp/whatsapp-card";

export function PlatformWhatsAppCard({ row }: { row: WhatsAppRow | null }) {
  return (
    <WhatsAppCard
      title="WhatsApp de Rydar"
      description={"Facultatif\u00a0: relances des frais Rydar envoyées au propriétaire du client (case «\u00a0Envoyer aussi par WhatsApp\u00a0» de «\u00a0Relancer\u00a0», dans Frais Rydar)."}
      row={row}
      defaultTemplate={WHATSAPP_TEMPLATES.platform.name}
      templateText={WHATSAPP_TEMPLATES.platform.text}
      variables={"3 variables\u00a0: nom du client, montant, échéance"}
      onSave={savePlatformWhatsApp}
      onRemove={removePlatformWhatsApp}
      onTest={testPlatformWhatsApp}
    />
  );
}
