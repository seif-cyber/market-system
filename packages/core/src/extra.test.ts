import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueLicense, licenseState, parseCsv, parseProductsCsv } from "./index";

describe("licenseState", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const now = 1_700_000_000_000, day = 86_400_000;
  const base = { publicKeyPem: pub, fingerprint: "FP", trialStart: now, lastSeen: now };
  it("trial then readonly", () => {
    expect(licenseState({ ...base, now: now + 3 * day })).toEqual({ mode: "trial", daysLeft: 11 });
    expect(licenseState({ ...base, now: now + 15 * day, lastSeen: now + 14 * day })).toEqual({ mode: "readonly", reason: "trial-ended" });
  });
  it("licensed", () => {
    const token = issueLicense({ fp: "FP", customer: "c", plan: "both", iat: now, exp: now + 30 * day }, priv);
    expect(licenseState({ ...base, token, now: now + day }).mode).toBe("licensed");
  });
  it("clock rollback locks", () => {
    expect(licenseState({ ...base, lastSeen: now + 10 * day, now })).toEqual({ mode: "readonly", reason: "clock-tampered" });
  });
});

describe("csv", () => {
  it("parses quotes and semicolons", () => {
    expect(parseCsv('a;b\n"x;y";2\n')).toEqual([["a", "b"], ["x;y", "2"]]);
  });
  it("imports arabic headers, converts to piastres, reports bad rows", () => {
    const r = parseProductsCsv("﻿الباركود,الاسم,السعر,الكمية\n6221,شاي,12.5,30\n,بدون باركود,5,1\n6222,سكر,0,1\n");
    expect(r.products).toEqual([{ barcode: "6221", name: "شاي", price: 1250, cost: 0, stock: 30 }]);
    expect(r.errors).toHaveLength(2);
  });
  it("reports missing columns", () => {
    expect(parseProductsCsv("a,b\n1,2").errors[0]).toMatch(/عمود ناقص/);
  });
});
