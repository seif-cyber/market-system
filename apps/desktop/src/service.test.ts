import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { issueLicense } from "@market/core";
import { addProduct, openDb } from "@market/db";
import { createService } from "./service";

const keys = generateKeyPairSync("ed25519");
const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const priv = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const DAY = 86_400_000;

let t: number;
function setup() {
  t = 1_700_000_000_000;
  const db = openDb(":memory:");
  const svc = createService({ db, fingerprint: "FP1", publicKeyPem: pub, print: async () => {}, now: () => t });
  addProduct(db, { name: "شاي", price: 5000, stock: 10, barcodes: ["111"] });
  return { db, svc };
}

describe("service", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  async function ownerLogin() {
    await s.svc.setupOwner("المالك", "1234");
    const { users } = await s.svc.bootstrap();
    return s.svc.login(users[0].id, "1234");
  }

  it("requires login", async () => {
    await expect(s.svc.scan("111")).rejects.toThrow(/سجّل/);
  });

  it("locks after repeated wrong PINs", async () => {
    await s.svc.setupOwner("م", "1234");
    const id = (await s.svc.bootstrap()).users[0].id;
    for (let i = 0; i < 5; i++) await expect(s.svc.login(id, "0000")).rejects.toThrow(/غلط/);
    await expect(s.svc.login(id, "1234")).rejects.toThrow(/محاولات/);
    t += 61_000;
    await expect(s.svc.login(id, "1234")).resolves.toBeTruthy();
  });

  it("checkout builds an Arabic receipt with the saved brand and logo", async () => {
    await ownerLogin();
    await s.svc.saveSettings({ brand_name: "سوبر ماركت النور", logo: "data:image/png;base64,AAAA" });
    const r = await s.svc.checkout({ lines: [{ productId: 1, qty: 2 }], payMethod: "cash" });
    expect(r.total).toBe(10000);
    expect(r.receiptHtml).toContain("سوبر ماركت النور");
    expect(r.receiptHtml).toContain("data:image/png;base64,AAAA");
  });

  it("cashier cannot discount or change settings; manager can", async () => {
    await ownerLogin();
    await s.svc.addUser("كاشير", "cashier", "1111");
    await s.svc.logout();
    const cashier = (await s.svc.bootstrap()).users.find((u) => u.role === "cashier")!;
    await s.svc.login(cashier.id, "1111");
    await expect(s.svc.checkout({ lines: [{ productId: 1, qty: 1 }], payMethod: "cash", invoiceDiscount: 100 })).rejects.toThrow(/صلاحية/);
    await expect(s.svc.saveSettings({ brand_name: "x" })).rejects.toThrow(/صلاحية/);
    await expect(s.svc.checkout({ lines: [{ productId: 1, qty: 1 }], payMethod: "cash" })).resolves.toBeTruthy();
  });

  it("blocks selling after trial ends, until a valid key is activated", async () => {
    await ownerLogin();
    t += 15 * DAY;
    await expect(s.svc.checkout({ lines: [{ productId: 1, qty: 1 }], payMethod: "cash" })).rejects.toThrow(/الترخيص/);
    const wrong = issueLicense({ fp: "OTHER", customer: "c", plan: "both", iat: t, exp: t + 30 * DAY }, priv);
    await expect(s.svc.activate(wrong)).rejects.toThrow(/غير صالح/);
    const ok = issueLicense({ fp: "FP1", customer: "c", plan: "both", iat: t, exp: t + 30 * DAY }, priv);
    expect((await s.svc.activate(ok)).mode).toBe("licensed");
    await expect(s.svc.checkout({ lines: [{ productId: 1, qty: 1 }], payMethod: "cash" })).resolves.toBeTruthy();
  });

  it("clock rollback blocks selling", async () => {
    await ownerLogin();
    t += 2 * DAY;
    await s.svc.bootstrap();
    t -= 2 * DAY;
    await expect(s.svc.checkout({ lines: [{ productId: 1, qty: 1 }], payMethod: "cash" })).rejects.toThrow(/الترخيص/);
  });

  it("imports CSV and reports today's summary", async () => {
    await ownerLogin();
    const r = await s.svc.importCsv("barcode,name,price,stock\n222,سكر,20,5\n111,شاي,55,0\n");
    expect(r).toMatchObject({ created: 1, updated: 1 });
    await s.svc.checkout({ lines: [{ productId: 1, qty: 1 }], payMethod: "card" });
    expect(await s.svc.todaySummary()).toMatchObject({ count: 1, total: 5500, card: 5500 });
  });
});
