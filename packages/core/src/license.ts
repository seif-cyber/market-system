import { createPublicKey, createPrivateKey, sign, verify, createHash } from "node:crypto";

export interface LicensePayload {
  fp: string; // machine fingerprint
  customer: string;
  plan: "supermarket" | "restaurant" | "both";
  exp: number; // epoch ms
  iat: number;
}

export type LicenseResult =
  | { ok: true; payload: LicensePayload }
  | { ok: false; reason: "malformed" | "bad-signature" | "wrong-machine" | "expired" };

const b64u = (b: Buffer) => b.toString("base64url");

/** Used only by the vendor-side tool; the private key never ships in the app. */
export function issueLicense(payload: LicensePayload, privateKeyPem: string): string {
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const sig = sign(null, Buffer.from(body), createPrivateKey(privateKeyPem));
  return `${body}.${b64u(sig)}`;
}

export function verifyLicense(
  token: string,
  publicKeyPem: string,
  fingerprint: string,
  now = Date.now(),
): LicenseResult {
  const parts = token.trim().split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [body, sig] = parts;
  let payload: LicensePayload;
  try {
    if (!verify(null, Buffer.from(body), createPublicKey(publicKeyPem), Buffer.from(sig, "base64url")))
      return { ok: false, reason: "bad-signature" };
    payload = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload.fp !== fingerprint) return { ok: false, reason: "wrong-machine" };
  if (payload.exp < now) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/** Hash of stable machine identifiers (supplied by the desktop app), shown to the customer as the device code. */
export function fingerprintFrom(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 20).toUpperCase();
}

/** Detects the system clock being rolled back versus the last time the app saw. */
export function clockTampered(lastSeen: number, now = Date.now(), toleranceMs = 5 * 60_000): boolean {
  return now + toleranceMs < lastSeen;
}
