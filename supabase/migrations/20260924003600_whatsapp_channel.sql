-- =============================================================================
-- Rydar Drive — Canal « whatsapp » de la file d'envoi (relances WhatsApp automatiques, 20260924003700).
-- Seul dans sa migration : une nouvelle valeur d'énumération n'est utilisable qu'une fois validée.
-- =============================================================================
alter type public.notification_channel add value if not exists 'whatsapp';
