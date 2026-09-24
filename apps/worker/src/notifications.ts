import { config, log } from "./config";
import { pool } from "./db";
import { apnsProvider } from "./push/apns";
import { expoProvider } from "./push/expo";
import { fcmProvider } from "./push/fcm";
import type { PushProvider, PushResult, PushTarget } from "./push/types";

type Claimed = {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  priority: "high" | "normal";
  attempts: number;
  tokens: PushTarget[];
};

const providers: Partial<Record<PushTarget["provider"], PushProvider>> = { expo: expoProvider(config.expoAccessToken) };
if (config.fcmServiceAccount) providers.fcm = fcmProvider(config.fcmServiceAccount);
if (config.apns) providers.apns = apnsProvider(config.apns);

/** Agrège les résultats par notification : envoyée si au moins un appareil l'a reçue. */
export function summarize(results: PushResult[]) {
  const ok = results.find((r) => r.ok);
  const invalid = results.filter((r) => r.invalid).map((r) => r.token);
  const retryable = !ok && results.some((r) => r.retryable);
  const error = ok ? null : results.map((r) => r.error).filter(Boolean).join(" | ") || "NO_RESULT";
  return { ok: !!ok, messageId: ok?.messageId ?? null, invalid, retryable, error };
}

async function deliver(n: Claimed) {
  if (!n.tokens.length) {
    await pool.query("select private.complete_notification($1, false, 'NO_PUSH_TOKEN', null, null, false)", [n.id]);
    return;
  }
  const payload = { title: n.title, body: n.body, type: n.type, data: { ...n.data, notification_id: n.id }, priority: n.priority };
  const results: PushResult[] = [];
  const byProvider = new Map<PushTarget["provider"], PushTarget[]>();
  for (const t of n.tokens) byProvider.set(t.provider, [...(byProvider.get(t.provider) ?? []), t]);
  for (const [name, targets] of byProvider) {
    const provider = providers[name];
    if (!provider) {
      results.push(...targets.map((t) => ({ token: t.token, ok: false, error: `PROVIDER_${name.toUpperCase()}_NOT_CONFIGURED` })));
      continue;
    }
    if (config.dryRun) {
      results.push(...targets.map((t) => ({ token: t.token, ok: true, messageId: "dry-run" })));
      continue;
    }
    results.push(...(await provider.send(targets, payload)));
  }
  const s = summarize(results);
  if (s.invalid.length) await pool.query("select private.deactivate_push_tokens($1, $2)", [s.invalid, "invalid_token"]);
  await pool.query("select private.complete_notification($1, $2, $3, $4, $5, $6)", [
    n.id, s.ok, s.error, [...byProvider.keys()].join(","), s.messageId, s.retryable,
  ]);
}

let running = false;
/** Réserve un lot (SKIP LOCKED → plusieurs workers possibles) et l'envoie. */
export async function processNotifications(): Promise<number> {
  if (running) return 0;
  running = true;
  let total = 0;
  try {
    for (;;) {
      const { rows } = await pool.query<Claimed>("select * from private.claim_notifications($1)", [config.batchSize]);
      if (!rows.length) break;
      total += rows.length;
      await Promise.all(
        rows.map((n) =>
          deliver(n).catch(async (error) => {
            log("error", "delivery failed", { id: n.id, error: (error as Error).message });
            await pool.query("select private.complete_notification($1, false, $2, null, null, true)", [n.id, (error as Error).message]).catch(() => undefined);
          }),
        ),
      );
      if (rows.length < config.batchSize) break;
    }
    if (total) log("info", "notifications processed", { count: total });
  } finally {
    running = false;
  }
  return total;
}
