import { describe, expect, it } from "vitest";
import { addProduct, createSale, createUser, openDb, openShift, setSetting } from "@market/db";
import { createCloud } from "./cloud";

/** A tiny Firebase: anonymous sign-up, Firestore commit/get/delete, and an owner claiming the shop on demand. */
function fakeFirebase() {
  const calls: { url: string; method: string; body: any }[] = [];
  const docs = new Map<string, any>();
  let offline = false, signUps = 0;
  const f = (async (url: string, init?: RequestInit) => {
    if (offline) throw new TypeError("fetch failed");
    const method = init?.method ?? "GET";
    const raw = init?.body ? String(init.body) : "";
    const body = raw.startsWith("{") ? JSON.parse(raw) : raw;
    calls.push({ url, method, body });
    const ok = (o: object) => new Response(JSON.stringify(o), { status: 200 });
    if (url.includes("accounts:signUp")) { signUps++; return ok({ idToken: "ID1", refreshToken: "RT1", localId: "DEV1", expiresIn: "3600" }); }
    if (url.includes("securetoken")) return ok({ id_token: "ID2", refresh_token: "RT2", expires_in: "3600" });
    if (url.endsWith(":commit")) {
      for (const w of body.writes) docs.set(w.update.name.replace(/^.*\/documents\//, ""), w.update.fields);
      return ok({});
    }
    const path = decodeURIComponent(url.replace(/^.*\/documents\//, ""));
    if (method === "DELETE") { docs.delete(path); return ok({}); }
    if (method === "GET") return docs.has(path) ? ok({ fields: docs.get(path) }) : new Response(JSON.stringify({ error: { status: "NOT_FOUND" } }), { status: 404 });
    return ok({});
  }) as unknown as typeof fetch;
  const ownerClaims = (uid = "OWNER1", email = "owner@shop.com") => docs.set("shops/DEV1/meta/owner", { uid: { stringValue: uid }, email: { stringValue: email } });
  return { f, calls, docs, ownerClaims, ownerRemoves: () => docs.delete("shops/DEV1/meta/owner"), setOffline: (v: boolean) => (offline = v), signUps: () => signUps };
}

function shop() {
  const db = openDb(":memory:");
  const u = createUser(db, "م", "owner", "1234");
  const p = addProduct(db, { name: "شاي", price: 5000, cost: 4000, stock: 100, barcodes: ["1"] });
  const sh = openShift(db, u, 0);
  setSetting(db, "brand_name", "النور");
  const sell = () => createSale(db, { userId: u, shiftId: sh, lines: [{ productId: p, qty: 1 }], payMethod: "cash" });
  return { db, sell };
}
const cfg = { apiKey: "KEY", projectId: "proj" };

describe("linking the owner with a pairing code", () => {
  it("creates the shop's own identity once, writes a short-lived code, and shows a link to the website", async () => {
    const fb = fakeFirebase(); const { db } = shop(); let t = 1_700_000_000_000;
    const cloud = createCloud({ db, config: cfg, fetch: fb.f, now: () => t, deviceCode: "DEV" });
    const s = await cloud.startLink();
    expect(s.linked).toBe(false);
    expect(s.pending!.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect(s.pending!.url).toBe(`https://proj.web.app/?link=${s.pending!.code}`);
    expect(s.pending!.expiresAt).toBe(t + 15 * 60_000);
    const pairing = fb.docs.get(`pairings/${s.pending!.code}`)!;
    expect(pairing.deviceUid.stringValue).toBe("DEV1");
    expect(Number(pairing.expiresAt.integerValue)).toBe(t + 15 * 60_000);
    // asking for a new code replaces the old one, and the identity is not created twice
    const s2 = await cloud.startLink();
    expect(s2.pending!.code).not.toBe(s.pending!.code);
    expect(fb.docs.has(`pairings/${s.pending!.code}`)).toBe(false);
    expect(fb.signUps()).toBe(1);
    // the code stops being offered once it expired
    t += 16 * 60_000;
    expect(cloud.status().pending).toBeNull();
  });

  it("stays pending until the owner claims the shop, then links, removes the code and starts syncing under the shop id", async () => {
    const fb = fakeFirebase(); const { db, sell } = shop(); sell(); sell();
    const t = Date.now() + 60_000;
    const cloud = createCloud({ db, config: cfg, fetch: fb.f, now: () => t, deviceCode: "DEV" });
    const code = (await cloud.startLink()).pending!.code;
    expect((await cloud.checkLink()).linked).toBe(false);
    await expect(cloud.syncNow()).rejects.toThrow(/اربط حساب المالك/);               // nothing is sent before an owner is linked
    fb.ownerClaims();
    const s = await cloud.checkLink();
    expect(s).toMatchObject({ linked: true, email: "owner@shop.com", pending: null });
    expect(fb.docs.has(`pairings/${code}`)).toBe(false);
    await cloud.syncNow();
    const paths = [...fb.docs.keys()];
    expect(paths).toEqual(expect.arrayContaining(["shops/DEV1/reports/today", "shops/DEV1/sales/000000001", "shops/DEV1/sales/000000002", "shops/DEV1/meta/status", "shops/DEV1/meta/treasury", "shops/DEV1/meta/suppliers", "shops/DEV1/meta/shifts"]));
    const report = JSON.parse(fb.docs.get("shops/DEV1/reports/today")!.json.stringValue);
    expect(report.kpi.invoices).toBe(2);
    expect(await cloud.startLink().catch((e) => e.message)).toMatch(/مربوط بحساب مالك/);
  });

  it("sends only a heartbeat when idle and a full push when something changed", async () => {
    const fb = fakeFirebase(); const { db, sell } = shop(); sell();
    let t = Date.now() + 60_000;
    const cloud = createCloud({ db, config: cfg, fetch: fb.f, now: () => t, deviceCode: "DEV" });
    await cloud.startLink(); fb.ownerClaims(); await cloud.checkLink(); await cloud.syncNow();
    fb.calls.length = 0; t += 15 * 60_000;
    await cloud.syncNow();
    const idle = fb.calls.filter((c) => c.url.endsWith(":commit")).flatMap((c) => c.body.writes);
    expect(idle).toHaveLength(1);
    expect(idle[0].updateMask.fieldPaths).toEqual(["syncedAt"]);
    sell(); fb.calls.length = 0; t += 15 * 60_000;
    await cloud.syncNow();
    expect(fb.calls.filter((c) => c.url.endsWith(":commit")).flatMap((c) => c.body.writes).length).toBeGreaterThan(5);
    expect(cloud.status().lastSync).toBe(t);
  });

  it("notices when the owner unlinked from the phone, and stops sending", async () => {
    const fb = fakeFirebase(); const { db } = shop();
    const cloud = createCloud({ db, config: cfg, fetch: fb.f, deviceCode: "DEV" });
    await cloud.startLink(); fb.ownerClaims(); await cloud.checkLink(); await cloud.syncNow();
    fb.ownerRemoves();
    await expect(cloud.syncNow()).rejects.toThrow(/فك الربط/);
    expect(cloud.status()).toMatchObject({ linked: false, email: "" });
    await expect(cloud.syncNow()).rejects.toThrow(/اربط حساب المالك/);
  });

  it("unlinking from the shop removes the owner on the server and clears local state", async () => {
    const fb = fakeFirebase(); const { db } = shop();
    const cloud = createCloud({ db, config: cfg, fetch: fb.f, deviceCode: "DEV" });
    await cloud.startLink(); fb.ownerClaims(); await cloud.checkLink();
    expect((await cloud.unlink()).linked).toBe(false);
    expect(fb.docs.has("shops/DEV1/meta/owner")).toBe(false);
    expect((await cloud.startLink()).pending).not.toBeNull();            // can pair a different owner now
  });

  it("explains problems in plain Arabic and refuses to run without a Firebase config", async () => {
    const fb = fakeFirebase(); const { db } = shop();
    const cloud = createCloud({ db, config: cfg, fetch: fb.f, deviceCode: "DEV" });
    fb.setOffline(true);
    await expect(cloud.startLink()).rejects.toThrow("مفيش اتصال بالإنترنت");
    const none = createCloud({ db: shop().db, config: null, deviceCode: "D" });
    expect(none.status().configured).toBe(false);
    await expect(none.startLink()).rejects.toThrow(/مش متاحة/);
    const dump = JSON.stringify(db.prepare("SELECT * FROM settings").all());
    expect(dump).not.toMatch(/password/i);
  });
});
