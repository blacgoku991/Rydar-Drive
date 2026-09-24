import { defineConfig } from "tsup";

// @rydar/shared est embarqué (TypeScript source) ; pg, jose, expo-server-sdk restent externes.
export default defineConfig({
  entry: ["src/index.ts", "src/simulator.ts", "src/backfill-routes.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  splitting: false,
  noExternal: ["@rydar/shared"],
});
