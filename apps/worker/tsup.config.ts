import { defineConfig } from "tsup";

// @rydar/shared est embarqué (TypeScript source) ; pg, jose, expo-server-sdk, nodemailer restent externes.
// dist/mailer.js : expéditeur d'e-mails (service « mailer » de deploy/docker-compose.yml, même image que le worker).
// Le simulateur de flotte (src/simulator.ts, `pnpm simulate` via tsx) n'est PAS construit : jamais dans l'image de production.
export default defineConfig({
  entry: ["src/index.ts", "src/backfill-routes.ts", "src/mailer.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  splitting: false,
  noExternal: ["@rydar/shared"],
});
