import { createHash } from "node:crypto";

export const GENESIS_HASH = "0".repeat(64);

/** Each sale's hash covers the previous hash, so editing/deleting any row breaks every later one. */
export function chainHash(prevHash: string, payload: unknown): string {
  return createHash("sha256")
    .update(prevHash)
    .update(JSON.stringify(payload))
    .digest("hex");
}

export function verifyChain(rows: { hash: string; payload: unknown }[]): number {
  let prev = GENESIS_HASH;
  for (let i = 0; i < rows.length; i++) {
    if (chainHash(prev, rows[i].payload) !== rows[i].hash) return i;
    prev = rows[i].hash;
  }
  return -1; // intact
}
