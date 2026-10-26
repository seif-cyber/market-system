import type { CloudStatus } from "@market/core";
import { analytics, getSetting, rangeFor, setSetting, type Db } from "@market/db";
import type { Cloud } from "./service";

export interface CloudConfig { apiKey: string; projectId: string }
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

const str = (v: string) => ({ stringValue: v });
const int = (v: number) => ({ integerValue: String(Math.round(v)) });
const bool = (v: boolean) => ({ booleanValue: v });

/**
 * Pushes report snapshots and recent invoices to the owner's own Firestore area (shops/{uid}/...).
 * Uses the Firebase REST API with the owner's email/password sign-in: no admin secret ships in the app.
 */
export function createCloud(d: CloudDeps): Cloud & { start(intervalMs?: number): () => void } {
  const f = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  let idToken = "", idExpires = 0, syncing: Promise<CloudStatus> | null = null;

  const get = (k: string) => getSetting(d.db, k) ?? "";
  const status = (): CloudStatus => ({
    configured: !!d.config, linked: !!get("cloud_refresh"), email: get("cloud_email"),
    lastSync: Number(get("cloud_last_sync")) || 0, lastError: get("cloud_last_error"),
  });

  async function json(res: Response) {
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    return body;
  }

  const FRIENDLY: Record<string, string> = {
    EMAIL_NOT_FOUND: "الإيميل ده مش مسجّل", INVALID_PASSWORD: "الباسورد غلط", INVALID_LOGIN_CREDENTIALS: "الإيميل أو الباسورد غلط",
    USER_DISABLED: "الحساب موقوف", TOO_MANY_ATTEMPTS_TRY_LATER: "محاولات كتير، جرّب بعد شوية", INVALID_EMAIL: "الإيميل غلط",
  };
  const explain = (e: unknown) => {
    const m = e instanceof Error ? e.message : String(e);
    if (/fetch failed|ENOTFOUND|ECONN|network|EAI_AGAIN|timeout/i.test(m)) return "مفيش اتصال بالإنترنت";
    return FRIENDLY[m.split(" ")[0]] ?? m;
  };

  async function token(): Promise<string> {
    if (idToken && idExpires - 60_000 > now()) return idToken;
    const rt = get("cloud_refresh");
    if (!rt) throw new Error("الحساب السحابي مش مربوط");
    const r = await json(await f(`https://securetoken.googleapis.com/v1/token?key=${d.config!.apiKey}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(rt)}`,
    }));
    idToken = r.id_token; idExpires = now() + Number(r.expires_in) * 1000;
    if (r.refresh_token) setSetting(d.db, "cloud_refresh", r.refresh_token);
    return idToken;
  }

  const base = () => `projects/${d.config!.projectId}/databases/(default)/documents`;

  async function commit(writes: { path: string; fields: Record<string, unknown> }[]) {
    const t = await token();
    const uid = get("cloud_uid");
    for (let i = 0; i < writes.length; i += 400) {
      const chunk = writes.slice(i, i + 400).map((w) => ({ update: { name: `${base()}/shops/${uid}/${w.path}`, fields: w.fields } }));
      await json(await f(`https://firestore.googleapis.com/v1/${base()}:commit`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t}` }, body: JSON.stringify({ writes: chunk }),
      }));
    }
  }

  async function doSync(): Promise<CloudStatus> {
    if (!d.config) throw new Error("الخدمة السحابية مش متاحة في النسخة دي");
    if (!get("cloud_refresh")) throw new Error("الحساب السحابي مش مربوط");
    const t = now();
    try {
      const writes: { path: string; fields: Record<string, unknown> }[] = [];
      const alertDays = d.alertDays?.() ?? 30;
      let integrity = true;
      for (const p of PRESETS) {
        const a = analytics(d.db, rangeFor(p, t), t, alertDays);
        integrity = a.integrity.ok;
        writes.push({ path: `reports/${p}`, fields: { json: str(JSON.stringify(a)), syncedAt: int(t) } });
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
          path: `sales/${String(s.no).padStart(9, "0")}`,
          fields: { no: int(s.no), createdAt: int(s.createdAt), total: int(s.total), payMethod: str(s.payMethod), cashier: str(s.cashier), customer: str(s.customer), json: str(JSON.stringify({ discount: s.discount, items: itemStmt.all(s.id) })) },
        });

      const shifts = d.db.prepare(
        `SELECT sh.id, u.name cashier, sh.opened_at openedAt, sh.closed_at closedAt, sh.opening_cash openingCash, sh.counted_cash counted, sh.expected_cash expected
         FROM shifts sh JOIN users u ON u.id=sh.user_id WHERE sh.closed_at IS NOT NULL ORDER BY sh.closed_at DESC LIMIT 30`,
      ).all();
      writes.push({ path: "meta/shifts", fields: { json: str(JSON.stringify(shifts)), syncedAt: int(t) } });
      writes.push({
        path: "meta/status",
        fields: { brand: str(getSetting(d.db, "brand_name") ?? ""), syncedAt: int(t), device: str(d.deviceCode), integrityOk: bool(integrity), lastInvoice: int(top) },
      });

      await commit(writes);
      if (sales.length) setSetting(d.db, "cloud_last_no", String(sales[sales.length - 1].no));
      else if (last === 0) setSetting(d.db, "cloud_last_no", String(top));
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

    async link(email, password) {
      if (!d.config) throw new Error("الخدمة السحابية مش متاحة في النسخة دي");
      try {
        const r = await json(await f(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${d.config.apiKey}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim(), password, returnSecureToken: true }),
        }));
        setSetting(d.db, "cloud_email", email.trim());
        setSetting(d.db, "cloud_refresh", r.refreshToken);
        setSetting(d.db, "cloud_uid", r.localId);
        setSetting(d.db, "cloud_last_no", "0");
        idToken = r.idToken; idExpires = now() + Number(r.expiresIn) * 1000;
      } catch (e) {
        throw new Error(explain(e));
      }
      return doSync().catch(() => status()); // linked even if the first push fails (e.g. offline); status shows the error
    },

    async unlink() {
      for (const k of ["cloud_email", "cloud_refresh", "cloud_uid", "cloud_last_no", "cloud_last_sync", "cloud_last_error"]) d.db.prepare("DELETE FROM settings WHERE key=?").run(k);
      idToken = "";
      return status();
    },

    syncNow() {
      return (syncing ??= doSync().finally(() => { syncing = null; }));
    },

    /** Background sync every few minutes while the app is open; silent when unlinked or offline. */
    start(intervalMs = 10 * 60_000) {
      const tick = () => { if (get("cloud_refresh")) this.syncNow().catch(() => {}); };
      const first = setTimeout(tick, 15_000);
      const h = setInterval(tick, intervalMs);
      return () => { clearTimeout(first); clearInterval(h); };
    },
  };
}
