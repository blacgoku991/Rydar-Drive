import { Expo, type ExpoPushMessage, type ExpoPushReceipt } from "expo-server-sdk";
import { appData, presentation, type PushPayload, type PushProvider, type PushResult, type PushTarget } from "./types";

/** Sous-ensemble du client Expo utilisé ici (remplaçable en test). */
export type ExpoClient = Pick<Expo, "chunkPushNotifications" | "sendPushNotificationsAsync" | "chunkPushNotificationReceiptIds" | "getPushNotificationReceiptsAsync">;

/** Expo Push (recommandé) : relaie vers FCM (Android) et APNs (iOS). */
export function expoProvider(expo: ExpoClient = new Expo()): PushProvider {
  return {
    name: "expo",
    async send(targets: PushTarget[], payload: PushPayload): Promise<PushResult[]> {
      const p = presentation(payload);
      const valid = targets.filter((t) => Expo.isExpoPushToken(t.token));
      const results: PushResult[] = targets
        .filter((t) => !Expo.isExpoPushToken(t.token))
        .map((t) => ({ token: t.token, ok: false, error: "InvalidExpoToken", invalid: true }));
      const messages: ExpoPushMessage[] = valid.map((t) => ({
        to: t.token,
        title: payload.title,
        body: payload.body,
        data: appData(payload),
        sound: p.sound === "default" ? "default" : { name: p.sound, critical: false, volume: 1 },
        channelId: p.channelId,
        priority: payload.priority === "high" ? "high" : "default",
        categoryId: p.categoryId,
        interruptionLevel: p.interruptionLevel,
        ttl: p.ttlSeconds,
      }));
      for (const chunk of expo.chunkPushNotifications(messages)) {
        try {
          const tickets = await expo.sendPushNotificationsAsync(chunk);
          tickets.forEach((ticket, i) => {
            const token = String(chunk[i]!.to);
            // Ticket « ok » = accepté par Expo, pas encore livré : l'accusé de réception est vérifié plus tard.
            if (ticket.status === "ok") results.push({ token, ok: true, messageId: ticket.id, receiptId: ticket.id });
            else {
              const code = ticket.details?.error ?? "ExpoError";
              results.push({ token, ok: false, error: `${code}: ${ticket.message}`, invalid: code === "DeviceNotRegistered", retryable: code === "MessageRateExceeded" });
            }
          });
        } catch (error) {
          for (const m of chunk) results.push({ token: String(m.to), ok: false, error: (error as Error).message, retryable: true });
        }
      }
      return results;
    },
  };
}

// ----------------------------------------------------------------- accusés de réception

type Ticket = { id: string; token: string; notificationId: string; sentAt: number; nextCheck: number };
/** open = tickets non résolus ; canFail = faux dès qu'un appareil a (peut-être) reçu la notification. */
type Group = { open: number; canFail: boolean; errors: string[] };

export type ReceiptActions = {
  deactivateTokens(tokens: string[], reason: string): Promise<unknown>;
  failNotification(notificationId: string, error: string): Promise<unknown>;
  log?(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void;
};

export type ReceiptOptions = {
  /** Première vérification après l'envoi (Expo met quelques secondes à relayer). */
  firstCheckMs?: number;
  /** Nouvel essai si l'accusé n'est pas encore disponible. */
  retryMs?: number;
  /** Au-delà, on abandonne (issue inconnue, la notification reste « sent »). */
  giveUpMs?: number;
  /** Borne mémoire : les tickets les plus anciens sont oubliés. */
  maxTickets?: number;
};

export type ReceiptStats = { checked: number; errors: number; deactivated: number; failed: number };

/**
 * Suivi des accusés de réception Expo (en mémoire, borné).
 * Un ticket « ok » signifie seulement qu'Expo a accepté le message : l'échec réel
 * (DeviceNotRegistered, identifiants FCM/APNs invalides…) n'apparaît que dans l'accusé.
 *  - DeviceNotRegistered → jeton désactivé ;
 *  - tous les accusés d'une notification en erreur → notification passée « failed ».
 */
export function expoReceiptTracker(expo: ExpoClient, actions: ReceiptActions, opts: ReceiptOptions = {}) {
  const firstCheckMs = opts.firstCheckMs ?? 15_000;
  const retryMs = opts.retryMs ?? 30_000;
  const giveUpMs = opts.giveUpMs ?? 5 * 60_000;
  const maxTickets = opts.maxTickets ?? 5000;
  const tickets = new Map<string, Ticket>(); // ordre d'insertion = du plus ancien au plus récent
  const groups = new Map<string, Group>();
  let polling: Promise<ReceiptStats> | null = null;

  /** Résout un ticket ; renvoie l'erreur à enregistrer si tous les accusés de la notification ont échoué. */
  function settle(t: Ticket, outcome: { error: string } | "ok" | "unknown"): string | null {
    tickets.delete(t.id);
    const g = groups.get(t.notificationId);
    if (!g) return null;
    g.open--;
    if (typeof outcome === "object") g.errors.push(outcome.error);
    else g.canFail = false;
    if (g.open > 0) return null;
    groups.delete(t.notificationId);
    return g.canFail && g.errors.length ? g.errors[0]! : null;
  }

  function track(notificationId: string, receipts: { token: string; id: string }[], opt: { deliveredElsewhere?: boolean } = {}, now = Date.now()) {
    const fresh = receipts.filter((r) => !tickets.has(r.id));
    if (!fresh.length) return;
    const g = groups.get(notificationId) ?? { open: 0, canFail: true, errors: [] };
    g.open += fresh.length;
    if (opt.deliveredElsewhere) g.canFail = false;
    groups.set(notificationId, g);
    for (const r of fresh) tickets.set(r.id, { id: r.id, token: r.token, notificationId, sentAt: now, nextCheck: now + firstCheckMs });
    while (tickets.size > maxTickets) {
      const oldest = tickets.values().next().value as Ticket;
      settle(oldest, "unknown");
    }
  }

  async function run(now: number): Promise<ReceiptStats> {
    const stats: ReceiptStats = { checked: 0, errors: 0, deactivated: 0, failed: 0 };
    const due = [...tickets.values()].filter((t) => t.nextCheck <= now);
    if (!due.length) return stats;
    const dead = new Set<string>();
    const failures: { id: string; error: string }[] = [];
    const later = (t: Ticket) => {
      if (now - t.sentAt >= giveUpMs) settle(t, "unknown");
      else t.nextCheck = now + retryMs;
    };

    for (const ids of expo.chunkPushNotificationReceiptIds(due.map((t) => t.id))) {
      let receipts: Record<string, ExpoPushReceipt>;
      try {
        receipts = await expo.getPushNotificationReceiptsAsync(ids);
      } catch (error) {
        actions.log?.("warn", "expo receipts fetch failed", { error: (error as Error).message, count: ids.length });
        for (const id of ids) {
          const t = tickets.get(id);
          if (t) later(t);
        }
        continue;
      }
      for (const id of ids) {
        const t = tickets.get(id);
        if (!t) continue;
        const r = receipts[id];
        if (!r) {
          later(t); // pas encore disponible
          continue;
        }
        stats.checked++;
        if (r.status === "ok") {
          settle(t, "ok");
          continue;
        }
        stats.errors++;
        const code = r.details?.error ?? "ExpoError";
        const error = `${code}: ${r.message}`;
        if (code === "DeviceNotRegistered") dead.add(t.token);
        actions.log?.(code === "InvalidCredentials" ? "error" : "warn", "expo receipt error", { notification_id: t.notificationId, error });
        const failed = settle(t, { error });
        if (failed) failures.push({ id: t.notificationId, error: failed });
      }
    }

    if (dead.size) {
      try {
        await actions.deactivateTokens([...dead], "DeviceNotRegistered");
        stats.deactivated = dead.size;
      } catch (error) {
        actions.log?.("error", "deactivate push tokens failed", { error: (error as Error).message });
      }
    }
    for (const f of failures) {
      try {
        await actions.failNotification(f.id, f.error);
        stats.failed++;
      } catch (error) {
        actions.log?.("error", "fail notification delivery failed", { id: f.id, error: (error as Error).message });
      }
    }
    return stats;
  }

  return {
    track,
    /** Vérifie les accusés dus ; un seul passage à la fois. */
    poll(now = Date.now()): Promise<ReceiptStats> {
      if (polling) return polling;
      polling = run(now).finally(() => {
        polling = null;
      });
      return polling;
    },
    size: () => tickets.size,
  };
}
