import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// `--mode mock` builds a preview bundle fed by a local fixture instead of Firebase (for design checks only).
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@mock": fileURLToPath(new URL(mode === "mock" ? "./mock-data.json" : "./src/mock-stub.ts", import.meta.url)),
    },
  },
}));
