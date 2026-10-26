import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { calcInvoice, lineTotal } from "./money";
import { chainHash, GENESIS_HASH, verifyChain } from "./auditChain";
import { clockTampered, fingerprintFrom, issueLicense, verifyLicense } from "./license";

describe("money", () => {
  it("handles fractional weighed qty", () => {
    expect(lineTotal({ unitPrice: 8000, qty: 0.375 })).toBe(3000);
  });
  it("adds tax on top", () => {
    const t = calcInvoice([{ unitPrice: 10000, qty: 2 }], { taxRate: 0.14 });
    expect(t).toEqual({ subtotal: 20000, discount: 0, tax: 2800, total: 22800 });
  });
  it("extracts inclusive tax", () => {
    const t = calcInvoice([{ unitPrice: 11400, qty: 1 }], { taxRate: 0.14, taxInclusive: true });
    expect(t.total).toBe(11400);
    expect(t.tax).toBe(1400);
  });
  it("rejects over-discount", () => {
    expect(() => calcInvoice([{ unitPrice: 100, qty: 1 }], { invoiceDiscount: 200 })).toThrow();
  });
});

describe("audit chain", () => {
  const mk = (n: number) => {
    let prev = GENESIS_HASH;
    return Array.from({ length: n }, (_, i) => {
      const payload = { no: i + 1, total: 1000 * (i + 1) };
      const hash = chainHash(prev, payload);
      prev = hash;
      return { hash, payload };
    });
  };
  it("is intact when untouched", () => expect(verifyChain(mk(5))).toBe(-1));
  it("detects an edited row", () => {
    const rows = mk(5);
    rows[2].payload = { no: 3, total: 1 };
    expect(verifyChain(rows)).toBe(2);
  });
});

describe("license", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const fp = fingerprintFrom(["cpu", "disk", "mac"]);
  const base = { fp, customer: "Test Market", plan: "supermarket" as const, iat: Date.now() };

  it("accepts a valid license", () => {
    const t = issueLicense({ ...base, exp: Date.now() + 1e6 }, priv);
    expect(verifyLicense(t, pub, fp).ok).toBe(true);
  });
  it("rejects another machine", () => {
    const t = issueLicense({ ...base, exp: Date.now() + 1e6 }, priv);
    expect(verifyLicense(t, pub, "OTHER")).toEqual({ ok: false, reason: "wrong-machine" });
  });
  it("rejects expired", () => {
    const t = issueLicense({ ...base, exp: Date.now() - 1 }, priv);
    expect(verifyLicense(t, pub, fp)).toEqual({ ok: false, reason: "expired" });
  });
  it("rejects tampered payload", () => {
    const t = issueLicense({ ...base, exp: Date.now() + 1e6 }, priv);
    const forged = Buffer.from(JSON.stringify({ ...base, exp: 9e15 })).toString("base64url") + "." + t.split(".")[1];
    expect(verifyLicense(forged, pub, fp)).toEqual({ ok: false, reason: "bad-signature" });
  });
  it("detects clock rollback", () => {
    expect(clockTampered(Date.now() + 86_400_000)).toBe(true);
    expect(clockTampered(Date.now() - 1000)).toBe(false);
  });
});
