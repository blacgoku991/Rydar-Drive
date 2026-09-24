import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { clientIp, userAgent } from "@/lib/request";

/** Journal d'audit applicatif (actions serveur sensibles). Ne bloque jamais l'action. */
export async function audit(entry: {
  organizationId?: string | null;
  actorUserId?: string | null;
  actorType?: "user" | "super_admin" | "api" | "system" | "booking_site";
  action: string;
  entityType?: string;
  entityId?: string;
  severity?: "info" | "warning" | "critical";
  metadata?: Record<string, unknown>;
}) {
  try {
    const admin = createAdminClient();
    const ip = await clientIp().catch(() => null);
    const ua = await userAgent().catch(() => null);
    await admin.from("audit_logs").insert({
      organization_id: entry.organizationId ?? null,
      actor_user_id: entry.actorUserId ?? null,
      actor_type: entry.actorType ?? "user",
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      severity: entry.severity ?? "info",
      ip: ip && ip !== "0.0.0.0" ? ip : null,
      user_agent: ua,
      metadata: entry.metadata ?? {},
    } as never);
  } catch (error) {
    console.error("[audit] échec d'écriture", error);
  }
}
