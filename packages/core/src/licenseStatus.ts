import { clockTampered, verifyLicense, type LicensePayload } from "./license";

export const TRIAL_DAYS = 14;

export type LicenseState =
  | { mode: "licensed"; payload: LicensePayload; daysLeft: number }
  | { mode: "trial"; daysLeft: number }
  | { mode: "readonly"; reason: "trial-ended" | "expired" | "invalid" | "clock-tampered" };

/** `readonly` = reports only; selling is refused by the main process. */
export function licenseState(i: {
  token?: string;
  publicKeyPem: string;
  fingerprint: string;
  trialStart: number;
  lastSeen: number;
  now?: number;
}): LicenseState {
  const now = i.now ?? Date.now();
  if (clockTampered(i.lastSeen, now)) return { mode: "readonly", reason: "clock-tampered" };
  if (i.token) {
    const r = verifyLicense(i.token, i.publicKeyPem, i.fingerprint, now);
    if (r.ok) return { mode: "licensed", payload: r.payload, daysLeft: Math.ceil((r.payload.exp - now) / 86_400_000) };
    return { mode: "readonly", reason: r.reason === "expired" ? "expired" : "invalid" };
  }
  const left = Math.ceil((i.trialStart + TRIAL_DAYS * 86_400_000 - now) / 86_400_000);
  return left > 0 ? { mode: "trial", daysLeft: left } : { mode: "readonly", reason: "trial-ended" };
}
