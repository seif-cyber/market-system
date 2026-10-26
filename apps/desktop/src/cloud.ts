import { randomInt } from "node:crypto";
import type { CloudStatus } from "@market/core";
import { analytics, balances, getSetting, listEntries, listPurchases, rangeFor, setSetting, supplierDues, totalPayables, totalReceivables, type Db } from "@market/db";
import type { Cloud } from "./service";

export interface CloudConfig { apiKey: string; projectId: string; siteUrl?: string }
export interface CloudDeps {
  db: Db;
  config: CloudConfig | null;
  fetch?: typeof fetch;
  now?: () => number;
  deviceCode: string;
  alertDays?: () => number;
}

const PRESETS = ["today", "7d", "30d", "month"] as const;
const MAX_NEW_SALES = 400;
const FIRST_SYNC_SALES = 200;
const PAIRING_MS = 15 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

const str = (v: string) => ({ stringValue: v });
const int = (v: number) => ({ integerValue: String(Math.round(v)) });
const bool = (v: boolean) => ({ booleanValue: v });

type Write = { path: string; fields: Record<string, unknown>; mask?: string[] };

/**
 * Pushes report snapshots and recent invoices to Firestore under shops/{deviceUid}. The shop PC has its own anonymous Firebase
 * identity (no password anywhere); the owner claims the shop from the website with a short pairing code, and only then can read it.
 */
export function createCloud(d: CloudDeps): Cloud & { start(intervalMs?: number): () => void } {
  const f = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  let idToken = "", idExpires = 0, syncing: Promise<CloudStatus> | null = null;

  const get = (k: string) => getSetting(d.db, k) ?? "";
  const del = (...ks: string[]) => ks.forEach((k) => d.db.prepare("DELETE FROM settings WHERE key=?").run(k));
  const siteUrl = () => d.config?.siteUrl || `https://${d.config?.projectId}.web.app`;

  const pending = () => {
    try {
      const p = JSON.parse(get("cloud_pairing") || "null") as { code: string; expiresAt: number } | null;
      return p && p.expiresAt > now() ? { ...p, url: `${siteUrl()}/?link=${p.code}` } : null;
    } catch { return null; }
  };
  const status = (): CloudStatus => ({
    configured: !!d.config, linked: !!get("cloud_owner_uid"), email: get("cloud_owner_email"),
    lastSync: Number(get("cloud_last_sync")) || 0, lastError: get("cloud_last_error"), pending: pending(),
  });

  const explain = (e: unknown) => {
    const m = e instanceof Error ? e.message : String(e);
    if (/fetch failed|ENOTFOUND|ECONN|network|EAI_AGAIN|timeout/i.test(m)) return "مفيش اتصال بالإنترنت";
    if (/ADMIN_ONLY_OPERATION|OPERATION_NOT_ALLOWED/i.test(m)) return "فعّل Anonymous في Firebase Authentication (Sign-in method)";
    if (/PERMISSION_DENIED|Missing or insufficient/i.test(m)) return "الصلاحيات في Firebase مش مظبوطة (انشر firestore.rules)";
    return m;
  };

  async function json(res: Response) {
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(body?.error?.message ?? body?.error?.status ?? `HTTP ${res.status}`);
    return body;
  }

  /** The shop PC's own identity: an anonymous Firebase user created once and remembered. */
  async function token(): Promise<string> {
    if (idToken && idExpires - 60_000 > now()) return idToken;
    const key = d.config!.apiKey;
    const rt = get("cloud_refresh");
    if (!rt) {
      const r = await json(await f(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${key}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }),
      }));
      setSetting(d.db, "cloud_refresh", r.refreshToken);
      setSetting(d.db, "cloud_uid", r.localId);
      idToken = r.idToken; idExpires = now() + Number(r.expiresIn) * 1000;
      return idToken;
    }
    const r = await json(await f(`https://securetoken.googleapis.com/v1/token?key=${key}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(rt)}`,
    }));
    idToken = r.id_token; idExpires = now() + Number(r.expires_in) * 1000;
    if (r.refresh_token) setSetting(d.db, "cloud_refresh", r.refresh_token);
    return idToken;
  }
  const deviceUid = async () => { await token(); return get("cloud_uid"); };

  const root = () => `projects/${d.config!.projectId}/databases/(default)/documents`;
  const api = (path: string) => `https://firestore.googleapis.com/v1/${root()}/${path}`;
  const auth = async () => ({ authorization: `Bearer ${await token()}` });

  async function commit(writes: Write[]) {
    const h = await auth();
    for (let i = 0; i < writes.length; i += 400) {
      const chunk = writes.slice(i, i + 400).map((w) => ({ update: { name: `${root()}/${w.path}`, fields: w.fields }, ...(w.mask ? { updateMask: { fieldPaths: w.mask } } : {}) }));
      await json(await f(`https://firestore.googleapis.com/v1/${root()}:commit`, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ writes: chunk }) }));
    }
  }
  /** null when the document does not exist. */
  async function getDoc(path: string): Promise<Record<string, any> | null> {
    const res = await f(api(path), { headers: await auth() });
    if (res.status === 404) return null;
    return ((await json(res)) as any).fields ?? {};
  }
  async function delDoc(path: string) {
    const res = await f(api(path), { method: "DELETE", headers: await auth() });
    if (!res.ok && res.status !== 404) await json(res);
  }

  const newCode = () => Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

  async function doSync(): Promise<CloudStatus> {
    if (!d.config) throw new Error("الخدمة السحابية مش متاحة في النسخة دي");
    if (!get("cloud_owner_uid")) throw new Error("اربط حساب المالك الأول");
    const t = now();
    try {
      const uid = await deviceUid();
      // If the owner (or someone) removed the link from the other side, stop sending.
      if (!(await getDoc(`shops/${uid}/meta/owner`))) {
        del("cloud_owner_uid", "cloud_owner_email", "cloud_sig", "cloud_last_full", "cloud_last_no");
        throw new Error("المالك فك الربط من الموبايل. اربط تاني لو عايز.");
      }
      const shop = (p: string) => `shops/${uid}/${p}`;
      // Firestore bills per write, so when nothing changed since the last full push we only refresh the "last seen" heartbeat.
      const sig = JSON.stringify(d.db.prepare(
        `SELECT (SELECT MAX(id) FROM sales) s, (SELECT MAX(id) FROM returns) r, (SELECT COUNT(*) FROM expenses) e, (SELECT MAX(id) FROM expenses) e2,
                (SELECT MAX(id) FROM stock_movements) m, (SELECT MAX(id) FROM customer_ledger) l, (SELECT MAX(id) FROM shifts) h,
                (SELECT MAX(id) FROM treasury_entries) te, (SELECT MAX(id) FROM supplier_ledger) sl, (SELECT MAX(id) FROM purchase_invoices) pi,
                (SELECT COUNT(*) FROM purchase_invoices WHERE voided=1) pv, (SELECT COUNT(*) FROM promotions) pr,
                (SELECT MAX(closed_at) FROM shifts) hc, (SELECT COUNT(*) FROM batches) b, date('now','localtime') d`).get());
      const full = sig !== get("cloud_sig") || t - (Number(get("cloud_last_full")) || 0) > 6 * 3_600_000;
      if (!full) {
        await commit([{ path: shop("meta/status"), fields: { syncedAt: int(t) }, mask: ["syncedAt"] }]);
        setSetting(d.db, "cloud_last_sync", String(t));
        setSetting(d.db, "cloud_last_error", "");
        return status();
      }
      const writes: Write[] = [];
      const alertDays = d.alertDays?.() ?? 30;
      let integrity = true;
      for (const p of PRESETS) {
        const a = analytics(d.db, rangeFor(p, t), t, alertDays);
        integrity = a.integrity.ok;
        writes.push({ path: shop(`reports/${p}`), fields: { json: str(JSON.stringify(a)), syncedAt: int(t) } });
      }

      const last = Number(get("cloud_last_no")) || 0;
      const top = (d.db.prepare("SELECT COALESCE(MAX(no),0) n FROM sales").get() as { n: number }).n;
      const from = last > 0 ? last : Math.max(0, top - FIRST_SYNC_SALES);
      const sales = d.db.prepare(
        `SELECT s.id, s.no, s.created_at createdAt, s.total, s.discount, s.pay_method payMethod, u.name cashier, COALESCE(c.name,'') customer
         FROM sales s JOIN users u ON u.id=s.user_id LEFT JOIN customers c ON c.id=s.customer_id WHERE s.no>? ORDER BY s.no LIMIT ?`,
      ).all(from, MAX_NEW_SALES) as any[];
      const itemStmt = d.db.prepare("SELECT name, qty, unit_price unitPrice, discount FROM sale_items WHERE sale_id=? ORDER BY id");
      for (const s of sales)
        writes.push({
          path: shop(`sales/${String(s.no).padStart(9, "0")}`),
          fields: { no: int(s.no), createdAt: int(s.createdAt), total: int(s.total), payMethod: str(s.payMethod), cashier: str(s.cashier), customer: str(s.customer), json: str(JSON.stringify({ discount: s.discount, items: itemStmt.all(s.id) })) },
        });

      const shifts = d.db.prepare(
        `SELECT sh.id, u.name cashier, sh.opened_at openedAt, sh.closed_at closedAt, sh.opening_cash openingCash, sh.counted_cash counted, sh.expected_cash expected
         FROM shifts sh JOIN users u ON u.id=sh.user_id WHERE sh.closed_at IS NOT NULL ORDER BY sh.closed_at DESC LIMIT 30`,
      ).all();
      const bal = balances(d.db);
      writes.push({
        path: shop("meta/treasury"),
        fields: {
          json: str(JSON.stringify({
            ...bal, receivables: totalReceivables(d.db), payables: totalPayables(d.db),
            entries: listEntries(d.db, { limit: 60 }).map((e) => ({ at: e.createdAt, account: e.account, kind: e.kind, note: e.note, delta: e.delta, balance: e.balanceAfter, user: e.userName })),
          })),
          syncedAt: int(t),
        },
      });
      writes.push({
        path: shop("meta/suppliers"),
        fields: {
          json: str(JSON.stringify({
            dues: supplierDues(d.db, t),
            invoices: listPurchases(d.db, { limit: 40 }, t).filter((p) => !p.voided).map((p) => ({ id: p.id, supplier: p.supplier, ref: p.supplierRef, date: p.invoiceDate, due: p.dueDate, total: p.total, paid: p.paid, remaining: p.remaining, status: p.status })),
          })),
          syncedAt: int(t),
        },
      });
      writes.push({ path: shop("meta/shifts"), fields: { json: str(JSON.stringify(shifts)), syncedAt: int(t) } });
      writes.push({
        path: shop("meta/status"),
        fields: { brand: str(getSetting(d.db, "brand_name") ?? ""), syncedAt: int(t), device: str(d.deviceCode), integrityOk: bool(integrity), lastInvoice: int(top) },
      });

      await commit(writes);
      if (sales.length) setSetting(d.db, "cloud_last_no", String(sales[sales.length - 1].no));
      else if (last === 0) setSetting(d.db, "cloud_last_no", String(top));
      setSetting(d.db, "cloud_sig", sig);
      setSetting(d.db, "cloud_last_full", String(t));
      setSetting(d.db, "cloud_last_sync", String(t));
      setSetting(d.db, "cloud_last_error", "");
    } catch (e) {
      setSetting(d.db, "cloud_last_error", explain(e));
      throw new Error(explain(e));
    }
    return status();
  }

  return {
    status,

    /** Creates a 15-minute pairing code for the owner to enter on the website. */
    async startLink() {
      if (!d.config) throw new Error("الخدمة السحابية مش متاحة في النسخة دي");
      if (get("cloud_owner_uid")) throw new Error("المحل مربوط بحساب مالك بالفعل. فك الربط الأول لو عايز تغيّره.");
      try {
        const uid = await deviceUid();
        const old = pending();
        if (old) await delDoc(`pairings/${old.code}`).catch(() => {});
        const code = newCode(), expiresAt = now() + PAIRING_MS;
        await commit([{ path: `pairings/${code}`, fields: { deviceUid: str(uid), expiresAt: int(expiresAt), createdAt: int(now()) } }]);
        setSetting(d.db, "cloud_pairing", JSON.stringify({ code, expiresAt }));
        setSetting(d.db, "cloud_last_error", "");
      } catch (e) {
        throw new Error(explain(e));
      }
      return status();
    },

    /** Polled while the code is on screen: has the owner claimed this shop yet? */
    async checkLink() {
      if (!d.config) throw new Error("الخدمة السحابية مش متاحة في النسخة دي");
      if (get("cloud_owner_uid")) return status();
      try {
        const uid = await deviceUid();
        const owner = await getDoc(`shops/${uid}/meta/owner`);
        if (!owner) return status();
        setSetting(d.db, "cloud_owner_uid", owner.uid?.stringValue ?? "");
        setSetting(d.db, "cloud_owner_email", owner.email?.stringValue ?? "");
        setSetting(d.db, "cloud_last_no", "0");
        const p = pending();
        del("cloud_pairing");
        if (p) await delDoc(`pairings/${p.code}`).catch(() => {});
      } catch (e) {
        throw new Error(explain(e));
      }
      this.syncNow().catch(() => {});
      return status();
    },

    async unlink() {
      try {
        if (d.config && get("cloud_owner_uid")) await delDoc(`shops/${await deviceUid()}/meta/owner`);
        const p = pending();
        if (d.config && p) await delDoc(`pairings/${p.code}`).catch(() => {});
      } catch (e) {
        throw new Error(explain(e));
      }
      del("cloud_owner_uid", "cloud_owner_email", "cloud_pairing", "cloud_last_no", "cloud_last_sync", "cloud_last_error", "cloud_sig", "cloud_last_full");
      return status();
    },

    syncNow() {
      return (syncing ??= doSync().finally(() => { syncing = null; }));
    },

    /** Background sync every few minutes while the app is open; silent when unlinked or offline. */
    start(intervalMs = 15 * 60_000) {
      const tick = () => { if (get("cloud_owner_uid")) this.syncNow().catch(() => {}); };
      const first = setTimeout(tick, 15_000);
      const h = setInterval(tick, intervalMs);
      return () => { clearTimeout(first); clearInterval(h); };
    },
  };
}
