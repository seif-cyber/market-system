import {
  licenseState, parseProductsCsv,
  type Api, type BrandSettings, type Role, type SessionUser,
} from "@market/core";
import {
  audit, createSale, createUser, findByBarcode, getSetting, importProducts,
  listUsers, loginWithPin, searchProducts, setSetting, type Db,
} from "@market/db";
import { buildReceiptHtml } from "./receipt";

const DEFAULT_BRAND: BrandSettings = {
  brand_name: "اسم المحل", logo: "", address: "", phone: "", tax_no: "",
  footer: "شكراً لزيارتكم", tax_rate: "0", tax_inclusive: "0",
};
const RANK: Record<Role, number> = { cashier: 0, manager: 1, owner: 2 };
const MAX_FAILS = 5, LOCK_MS = 60_000;

export interface Deps {
  db: Db;
  fingerprint: string;
  publicKeyPem: string;
  print: (html: string) => Promise<void>;
  now?: () => number;
}

export function createService({ db, fingerprint, publicKeyPem, print, now = Date.now }: Deps): Api {
  let user: SessionUser | null = null;
  const fails = new Map<number, { n: number; until: number }>();

  const brand = (): BrandSettings => {
    const b = { ...DEFAULT_BRAND };
    for (const k of Object.keys(b) as (keyof BrandSettings)[]) b[k] = getSetting(db, k) ?? b[k];
    return b;
  };

  const license = () => {
    const t = now();
    if (!getSetting(db, "trial_start")) setSetting(db, "trial_start", String(t));
    const state = licenseState({
      token: getSetting(db, "license"), publicKeyPem, fingerprint,
      trialStart: Number(getSetting(db, "trial_start")),
      lastSeen: Number(getSetting(db, "last_seen") ?? 0), now: t,
    });
    // Only advance the high-water mark when the clock is sane, so rolling back can't reset it.
    if (!(state.mode === "readonly" && state.reason === "clock-tampered")) {
      if (t > Number(getSetting(db, "last_seen") ?? 0)) setSetting(db, "last_seen", String(t));
    }
    return state;
  };

  const need = (min: Role): SessionUser => {
    if (!user) throw new Error("سجّل دخول الأول");
    if (RANK[user.role] < RANK[min]) throw new Error("مفيش صلاحية لده");
    return user;
  };

  return {
    async bootstrap() {
      return { users: listUsers(db), needsSetup: listUsers(db).length === 0, license: license(), deviceCode: fingerprint, brand: brand(), user };
    },

    async setupOwner(name, pin) {
      if (listUsers(db).length) throw new Error("السيستم متظبط قبل كده");
      createUser(db, name, "owner", pin);
    },

    async login(userId, pin) {
      const f = fails.get(userId);
      if (f && f.n >= MAX_FAILS && f.until > now()) throw new Error("محاولات كتير، استنى دقيقة");
      const u = loginWithPin(db, userId, pin);
      if (!u) {
        const n = (f && f.until > now() ? f.n : 0) + 1;
        fails.set(userId, { n, until: now() + LOCK_MS });
        audit(db, userId, "login_failed");
        throw new Error("الـ PIN غلط");
      }
      fails.delete(userId);
      user = u;
      audit(db, u.id, "login");
      return u;
    },

    async logout() {
      if (user) audit(db, user.id, "logout");
      user = null;
    },

    async saveSettings(s) {
      const u = need("manager");
      for (const [k, v] of Object.entries(s)) {
        if (!(k in DEFAULT_BRAND)) continue;
        if (k === "logo" && String(v).length > 700_000) throw new Error("اللوجو كبير، صغّره");
        setSetting(db, k, String(v));
      }
      audit(db, u.id, "settings_changed", Object.keys(s));
      return brand();
    },

    async activate(token) {
      const u = need("owner");
      setSetting(db, "license", token.trim());
      const st = license();
      if (st.mode !== "licensed") { db.prepare("DELETE FROM settings WHERE key='license'").run(); throw new Error("مفتاح التفعيل غير صالح لهذا الجهاز"); }
      audit(db, u.id, "license_activated", { customer: st.payload.customer });
      return st;
    },

    async scan(code) {
      need("cashier");
      const p = findByBarcode(db, code.trim());
      return p ? { id: p.id, name: p.name, price: p.price, stock: p.stock } : null;
    },

    async search(q) {
      need("cashier");
      return searchProducts(db, q);
    },

    async checkout(i) {
      const u = need("cashier");
      const st = license();
      if (st.mode === "readonly") throw new Error("الترخيص منتهي: البيع موقوف");
      if (!i.lines.length) throw new Error("الفاتورة فاضية");
      const hasDiscount = (i.invoiceDiscount ?? 0) > 0 || i.lines.some((l) => (l.discount ?? 0) > 0);
      if (hasDiscount) need("manager");
      const b = brand();
      const sale = createSale(db, {
        userId: u.id, lines: i.lines, payMethod: i.payMethod, invoiceDiscount: i.invoiceDiscount,
        taxRate: Number(b.tax_rate) / 100, taxInclusive: b.tax_inclusive === "1",
      });
      const items = db.prepare("SELECT name,qty,unit_price AS unitPrice,discount FROM sale_items WHERE sale_id=?").all(sale.saleId) as any[];
      const receiptHtml = buildReceiptHtml({
        brand: b, no: sale.no, cashier: u.name, createdAt: now(), items,
        subtotal: sale.subtotal, discount: sale.discount, tax: sale.tax, total: sale.total, payMethod: i.payMethod,
      });
      return { no: sale.no, total: sale.total, receiptHtml };
    },

    async importCsv(text) {
      const u = need("manager");
      const { products, errors } = parseProductsCsv(text);
      const r = importProducts(db, products);
      audit(db, u.id, "products_imported", { ...r, errors: errors.length });
      return { ...r, errors };
    },

    async todaySummary() {
      need("manager");
      const d = new Date(now()); d.setHours(0, 0, 0, 0);
      const r = db.prepare(
        `SELECT COUNT(*) count, COALESCE(SUM(total),0) total,
         COALESCE(SUM(CASE WHEN pay_method='cash' THEN total END),0) cash,
         COALESCE(SUM(CASE WHEN pay_method='card' THEN total END),0) card
         FROM sales WHERE created_at>=?`,
      ).get(d.getTime()) as any;
      return r;
    },

    async addUser(name, role, pin) {
      const u = need("owner");
      createUser(db, name, role, pin);
      audit(db, u.id, "user_added", { name, role });
    },

    async print(html) {
      need("cashier");
      await print(html);
    },
  };
}
