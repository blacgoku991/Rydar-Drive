import pg from "pg";
import { config, dbTlsHint, log } from "./config";

/** Pool de connexions (rôle propriétaire, DATABASE_URL) ; application_name visible dans pg_stat_activity. */
export function createPool(applicationName: string, options: Omit<pg.PoolConfig, "connectionString" | "application_name"> = {}) {
  const p = new pg.Pool({ max: 8, ...options, connectionString: config.databaseUrl, application_name: applicationName });
  p.on("error", (e) => log("error", "pg pool error", { error: e.message }));
  return p;
}

export const pool = createPool("rydar-worker");

/**
 * Connexion dédiée LISTEN (réveil instantané du worker), une seule pour tous les canaux donnés (le pooler en mode
 * session de Supabase compte chaque connexion). Nécessite une connexion directe (pas le pooler transactionnel).
 */
export async function listen(
  channel: string | string[],
  onNotify: (payload: string | undefined, channel: string) => void,
  applicationName = "rydar-worker-listen",
) {
  const channels = Array.isArray(channel) ? channel : [channel];
  let client: pg.Client | null = null;
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;
  const reconnect = (ms: number) => {
    if (stopped) return;
    clearTimeout(retry);
    retry = setTimeout(connectLoop, ms);
  };
  const connectLoop = async () => {
    if (stopped) return;
    try {
      client = new pg.Client({ connectionString: config.databaseUrl, application_name: applicationName });
      client.on("notification", (msg) => onNotify(msg.payload, msg.channel));
      client.on("error", () => undefined);
      client.on("end", () => reconnect(2000));
      await client.connect();
      for (const c of channels) await client.query(`listen ${c}`);
      log("info", "listening", { channel: channels.join(",") });
    } catch (error) {
      log("warn", "listen failed, retrying", { error: (error as Error).message, ...dbTlsHint(error) });
      reconnect(5000);
    }
  };
  await connectLoop();
  /** Arrêt définitif (plus de reconnexion). */
  return async () => {
    stopped = true;
    clearTimeout(retry);
    await client?.end().catch(() => undefined);
  };
}
