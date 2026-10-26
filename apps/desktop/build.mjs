import { build } from "esbuild";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";

const keyPath = new URL("../../keys/public.pem", import.meta.url);
const publicKey = process.env.LICENSE_PUBLIC_KEY || (existsSync(keyPath) ? readFileSync(keyPath, "utf8") : "");
if (!publicKey) {
  console.error("Missing license public key: set LICENSE_PUBLIC_KEY or create keys/public.pem (tsx tools/license.ts keygen)");
  process.exit(1);
}

const common = { bundle: true, platform: "node", format: "cjs", target: "node20", sourcemap: false, minify: true, logLevel: "info" };
await build({
  ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.cjs",
  external: ["electron", "better-sqlite3"],
  define: { __LICENSE_PUBLIC_KEY__: JSON.stringify(publicKey) },
});
await build({ ...common, entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs", external: ["electron"] });

rmSync("ui", { recursive: true, force: true });
cpSync("../ui/dist", "ui", { recursive: true });
