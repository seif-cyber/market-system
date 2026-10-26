import { defineConfig } from "vitest/config";

export default defineConfig({
  // cloud/rules-test needs the Firestore emulator and runs on its own (node --test); see cloud/README.md
  test: { exclude: ["**/node_modules/**", "**/dist/**", "cloud/rules-test/**"] },
});
