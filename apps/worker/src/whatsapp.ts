// Envoi des relances WhatsApp (canal 'whatsapp' de public.notifications) par l'API WhatsApp Business Cloud.
// private.claim_whatsapp réserve un lot avec les identifiants de l'expéditeur (numéro de la centrale ou de Rydar) ;
// private.complete_whatsapp termine : reprises (erreurs temporaires), état de l'expéditeur, repli par l'application.
import { sendWhatsAppTemplate, type WhatsAppSendResult } from "@rydar/shared";
import { config, log } from "./config";
import { pool } from "./db";

export type ClaimedWhatsApp = {
  id: string;
  organization_id: string;
  driver_id: string | null;
  type: string;
  data: { sender?: string; to?: string; params?: unknown[] } & Record<string, unknown>;
  attempts: number;
  sender: string | null;
  phone_number_id: string | null;
  access_token: string | null;
  template: string | null;
  language: string | null;
};

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
type Send = (input: Parameters<typeof sendWhatsAppTemplate>[0]) => Promise<WhatsAppSendResult>;

/** Un message : identifiants manquants → échec définitif (repli push côté SQL), sinon envoi du modèle. */
export async function deliverWhatsApp(n: ClaimedWhatsApp, deps: { query: Query; send: Send; dryRun?: boolean; apiVersion?: string }) {
  const complete = (ok: boolean, error: string | null, messageId: string | null, retryable: boolean) =>
    deps.query("select private.complete_whatsapp($1, $2, $3, $4, $5) as r", [n.id, ok, error, messageId, retryable]);
  const to = typeof n.data?.to === "string" ? n.data.to : null;
  if (!n.phone_number_id || !n.access_token || !n.template) {
    await complete(false, n.sender === "platform" ? "WhatsApp de Rydar non configuré ou désactivé" : "WhatsApp de la centrale non configuré ou désactivé", null, false);
    return { ok: false as const, error: "NOT_CONFIGURED" };
  }
  if (!to) {
    await complete(false, "Destinataire manquant", null, false);
    return { ok: false as const, error: "NO_RECIPIENT" };
  }
  const params = Array.isArray(n.data.params) ? n.data.params.map((p) => String(p ?? "")) : [];
  const res: WhatsAppSendResult = deps.dryRun
    ? { ok: true, messageId: "dry-run" }
    : await deps.send({
        phoneNumberId: n.phone_number_id,
        token: n.access_token,
        to,
        template: n.template,
        language: n.language || "fr",
        params,
        apiVersion: deps.apiVersion,
      });
  if (res.ok) await complete(true, null, res.messageId, false);
  else await complete(false, res.error, null, res.retryable);
  return res;
}

let running = false;
let stopping = false;

/** Réserve et envoie les messages WhatsApp en file (SKIP LOCKED : plusieurs workers possibles). */
export async function processWhatsApp(): Promise<number> {
  if (running || stopping) return 0;
  running = true;
  let total = 0;
  const query: Query = (sql, params) => pool.query(sql, params);
  try {
    while (!stopping) {
      const { rows } = await pool.query<ClaimedWhatsApp>("select * from private.claim_whatsapp($1)", [config.whatsapp.batch]);
      if (!rows.length) break;
      total += rows.length;
      // Envoi séquentiel : quelques messages par passage, sans dépasser les limites de débit de Meta
      for (const n of rows) {
        const res = await deliverWhatsApp(n, { query, send: sendWhatsAppTemplate, dryRun: config.dryRun, apiVersion: config.whatsapp.apiVersion }).catch(async (error) => {
          await pool.query("select private.complete_whatsapp($1, false, $2, null, true)", [n.id, (error as Error).message]).catch(() => undefined);
          return { ok: false as const, error: (error as Error).message };
        });
        if (!res.ok) log("warn", "whatsapp not sent", { id: n.id, type: n.type, error: res.error });
      }
      if (rows.length < config.whatsapp.batch) break;
    }
    if (total) log("info", "whatsapp processed", { count: total });
  } finally {
    running = false;
  }
  return total;
}

export function stopWhatsApp() {
  stopping = true;
}
