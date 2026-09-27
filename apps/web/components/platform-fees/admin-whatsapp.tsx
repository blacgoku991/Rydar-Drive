"use client";
// Super admin : numéro WhatsApp Business de Rydar, pour relancer les propriétaires de centrale (frais plateforme).
import { WHATSAPP_TEMPLATES } from "@rydar/shared";
import { removePlatformWhatsApp, savePlatformWhatsApp, testPlatformWhatsApp } from "@/app/admin/frais/actions";
import { WhatsAppCard, type WhatsAppRow } from "@/components/whatsapp/whatsapp-card";

export function PlatformWhatsAppCard({ row }: { row: WhatsAppRow | null }) {
  return (
    <WhatsAppCard
      title="WhatsApp de Rydar"
      description="Relances des frais plateforme envoyées au propriétaire de la centrale (case « Envoyer aussi par WhatsApp » de Relancer)."
      row={row}
      defaultTemplate={WHATSAPP_TEMPLATES.platform.name}
      templateText={WHATSAPP_TEMPLATES.platform.text}
      variables="3 variables : centrale, montant, échéance"
      onSave={savePlatformWhatsApp}
      onRemove={removePlatformWhatsApp}
      onTest={testPlatformWhatsApp}
    />
  );
}
