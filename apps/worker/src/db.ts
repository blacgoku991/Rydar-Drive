import pg from "pg";
import { config, log } from "./config";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 8, application_name: "rydar-worker" });
pool.on("error", (e) => log("error", "pg pool error", { error: e.message }));

/** Connexion dédiée LISTEN (réveil instantané du worker). Nécessite une connexion directe (pas le pooler transactionnel). */
export async function listen(channel: string, onNotify: (payload: string | undefined) => void) {
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
      client = new pg.Client({ connectionString: config.databaseUrl, application_name: "rydar-worker-listen" });
      client.on("notification", (msg) => onNotify(msg.payload));
      client.on("error", () => undefined);
      client.on("end", () => reconnect(2000));
      await client.connect();
      await client.query(`listen ${channel}`);
      log("info", "listening", { channel });
    } catch (error) {
      log("warn", "listen failed, retrying", { error: (error as Error).message });
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
