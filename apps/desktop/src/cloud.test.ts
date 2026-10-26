import { describe, expect, it } from "vitest";
import { addProduct, createSale, createUser, openDb, openShift, setSetting } from "@market/db";
import { createCloud } from "./cloud";

function fakeFirebase() {
  const calls: { url: string; body: any }[] = [];
  let offline = false, badPassword = false;
  const f = (async (url: string, init?: RequestInit) => {
    if (offline) throw new TypeError("fetch failed");
    const body = init?.body && String(init.body).startsWith("{") ? JSON.parse(String(init.body)) : init?.body;
    calls.push({ url, body });
    const ok = (o: object) => new Response(JSON.stringify(o), { status: 200 });
    if (url.includes("signInWithPassword"))
      return badPassword ? new Response(JSON.stringify({ error: { message: "INVALID_LOGIN_CREDENTIALS" } }), { status: 400 }) : ok({ idToken: "ID1", refreshToken: "RT1", localId: "UID1", expiresIn: "3600" });
    if (url.includes("securetoken")) return ok({ id_token: "ID2", refresh_token: "RT2", expires_in: "3600" });
    return ok({});
  }) as unknown as typeof fetch;
  return { f, calls, setOffline: (v: boolean) => (offline = v), setBad: (v: boolean) => (badPassword = v) };
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

describe("cloud sync", () => {
  it("links, pushes reports + invoices under the owner's uid, then only new invoices", async () => {
    const fb = fakeFirebase(); const { db, sell } = shop();
    let t = Date.now() + 60_000;
    const cloud = createCloud({ db, config: { apiKey: "KEY", projectId: "proj" }, fetch: fb.f, now: () => t, deviceCode: "DEV" });
    sell(); sell();
    const st = await cloud.link("owner@shop.com", "secret");
    expect(st).toMatchObject({ configured: true, linked: true, email: "owner@shop.com", lastError: "" });
    const commit = fb.calls.find((c) => c.url.endsWith(":commit"))!;
    const names = commit.body.writes.map((w: any) => w.update.name.replace(/^.*shops\/UID1\//, ""));
    expect(names).toEqual(expect.arrayContaining(["reports/today", "reports/7d", "reports/30d", "reports/month", "sales/000000001", "sales/000000002", "meta/status", "meta/shifts"]));
    const report = JSON.parse(commit.body.writes.find((w: any) => w.update.name.endsWith("reports/today")).update.fields.json.stringValue);
    expect(report.kpi.invoices).toBe(2);
    expect(JSON.stringify(commit.body)).not.toContain("secret"); // password is never sent to Firestore
    expect(commit.url).toContain("projects/proj/databases");
    expect(fb.calls.find((c) => c.url.endsWith(":commit"))).toBeTruthy();

    sell(); t += 2 * 3_600_000; // token expired -> refresh
    fb.calls.length = 0;
    await cloud.syncNow();
    expect(fb.calls.some((c) => c.url.includes("securetoken"))).toBe(true);
    const second = fb.calls.find((c) => c.url.endsWith(":commit"))!.body.writes.map((w: any) => w.update.name);
    expect(second.filter((n: string) => n.includes("/sales/"))).toHaveLength(1);
  });

  it("does not store the password; reports friendly errors", async () => {
    const fb = fakeFirebase(); const { db } = shop();
    const cloud = createCloud({ db, config: { apiKey: "K", projectId: "p" }, fetch: fb.f, deviceCode: "D" });
    fb.setBad(true);
    await expect(cloud.link("a@b.c", "bad")).rejects.toThrow("الإيميل أو الباسورد غلط");
    fb.setBad(false);
    await cloud.link("a@b.c", "good");
    const dump = JSON.stringify(db.prepare("SELECT * FROM settings").all());
    expect(dump).not.toContain("good");
    fb.setOffline(true);
    await expect(cloud.syncNow()).rejects.toThrow("مفيش اتصال بالإنترنت");
    expect(cloud.status().lastError).toBe("مفيش اتصال بالإنترنت");
    fb.setOffline(false);
    await cloud.syncNow();
    expect(cloud.status().lastError).toBe("");
    expect((await cloud.unlink()).linked).toBe(false);
  });

  it("is a no-op error when the build has no Firebase config", async () => {
    const { db } = shop();
    const cloud = createCloud({ db, config: null, deviceCode: "D" });
    expect(cloud.status().configured).toBe(false);
    await expect(cloud.link("a@b.c", "x")).rejects.toThrow(/مش متاحة/);
  });
});
