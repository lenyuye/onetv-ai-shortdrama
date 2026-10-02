import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const r = (p: string) => path.resolve(import.meta.dirname, p);

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "safari15",
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  resolve: {
    alias: {
      "@onetv/shared-types": r("../../packages/shared-types/src/index.ts"),
      "@onetv/node-sdk": r("../../packages/node-sdk/src/index.ts"),
      "@onetv/provider-sdk": r("../../packages/provider-sdk/src/index.ts"),
      "@onetv/agent-engine": r("../../packages/agent-engine/src/index.ts"),
      "@onetv/skill-sdk": r("../../packages/skill-sdk/src/index.ts"),
      "@": r("./src"),
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
});
