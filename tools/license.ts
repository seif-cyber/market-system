// Vendor-side only. Usage:
//   tsx tools/license.ts keygen
//   tsx tools/license.ts issue <deviceCode> "<customer>" <supermarket|restaurant|both> <days>
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { issueLicense } from "@market/core";

const PRIV = "keys/private.pem";
const PUB = "keys/public.pem";
const [cmd, ...args] = process.argv.slice(2);

if (cmd === "keygen") {
  mkdirSync("keys", { recursive: true });
  if (existsSync(PRIV)) throw new Error(`${PRIV} exists; refusing to overwrite`);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(PRIV, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(PUB, publicKey.export({ type: "spki", format: "pem" }));
  console.log(`wrote ${PRIV} (KEEP SECRET, never commit) and ${PUB} (embed in the app)`);
} else if (cmd === "issue") {
  const [fp, customer, plan, days] = args;
  if (!fp || !customer || !["supermarket", "restaurant", "both"].includes(plan) || !(+days > 0))
    throw new Error('usage: issue <deviceCode> "<customer>" <supermarket|restaurant|both> <days>');
  const now = Date.now();
  console.log(issueLicense({ fp, customer, plan: plan as any, iat: now, exp: now + +days * 86_400_000 }, readFileSync(PRIV, "utf8")));
} else {
  console.log("commands: keygen | issue");
}
