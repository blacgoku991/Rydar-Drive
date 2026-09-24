import pg from "pg";
import { config, log } from "./config";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 8, application_name: "rydar-worker" });
pool.on("error", (e) => log("error", "pg pool error", { error: e.message }));

/** Connexion dédiée LISTEN (réveil instantané du worker). Nécessite une connexion directe (pas le pooler transactionnel). */
export async function listen(channel: string, onNotify: (payload: string | undefined) => void) {
  let client: pg.Client | null = null;
  const connectLoop = async () => {
    try {
      client = new pg.Client({ connectionString: config.databaseUrl, application_name: "rydar-worker-listen" });
      client.on("notification", (msg) => onNotify(msg.payload));
      client.on("error", () => undefined);
      client.on("end", () => setTimeout(connectLoop, 2000));
      await client.connect();
      await client.query(`listen ${channel}`);
      log("info", "listening", { channel });
    } catch (error) {
      log("warn", "listen failed, retrying", { error: (error as Error).message });
      setTimeout(connectLoop, 5000);
    }
  };
  await connectLoop();
  return () => client?.end().catch(() => undefined);
}
