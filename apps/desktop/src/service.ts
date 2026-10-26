import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  licenseState, parseProductsCsv, parseScaleBarcode, whatsappUrl,
  type Api, type Approval, type BrandSettings, type CloudStatus, type Role, type SessionUser,
} from "@market/core";
import {
  addCustomer, addExpense, addPayment, adjustStock, analytics, audit, closeShift, createReturn, createSale, createUser,
  currentShift, deleteExpense, expiringBatches, findByBarcode, getCustomer, getSaleForReturn, getSetting, importProducts,
  listCustomers, listExpenses, listProducts, listUsers, loginWithPin, openShift, rangeFor, receiveStock, saveProduct,
  searchProducts, setCreditLimit, setPin, setSetting, setUserActive, statement, validateBackup, type Db,
} from "@market/db";
import { buildReceiptHtml, buildShiftReportHtml } from "./receipt";

const DEFAULT_BRAND: BrandSettings = {
  brand_name: "اسم المحل", logo: "", address: "", phone: "", tax_no: "", footer: "شكراً لزيارتكم",
  tax_rate: "0", tax_inclusive: "0", scale_prefix: "20", scale_mode: "weight", scale_plu_len: "5", expiry_alert_days: "30",
};
const RANK: Record<Role, number> = { cashier: 0, manager: 1, owner: 2 };
const MAX_FAILS = 5, LOCK_MS = 60_000, KEEP_BACKUPS = 30;

export interface Cloud {
  status(): CloudStatus;
  link(email: string, password: string): Promise<CloudStatus>;
  unlink(): Promise<CloudStatus>;
  syncNow(): Promise<CloudStatus>;
}

export interface Deps {
  db: Db;
  fingerprint: string;
  publicKeyPem: string;
  print: (html: string) => Promise<void>;
  now?: () => number;
  backupDir?: string;
  pickFolder?: () => Promise<string | null>;
  pickFile?: () => Promise<string | null>;
  restoreFrom?: (file: string) => Promise<void>;
  enterDemo?: () => Promise<void>;
  exitDemo?: () => Promise<void>;
  isDemo?: () => boolean;
  openUrl?: (url: string) => Promise<void>;
  cloud?: Cloud;
}

export type Service = Api & { autoBackup(): Promise<void> };

const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export function createService(deps: Deps): Service {
  const { db, fingerprint, publicKeyPem, print } = deps;
  const now = deps.now ?? Date.now;
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

  /** PIN check with lockout, shared by login and manager approvals. */
  const checkPin = (userId: number, pin: string) => {
    const f = fails.get(userId);
    if (f && f.n >= MAX_FAILS && f.until > now()) throw new Error("محاولات كتير، استنى دقيقة");
    const u = loginWithPin(db, userId, pin);
    if (!u) {
      fails.set(userId, { n: (f && f.until > now() ? f.n : 0) + 1, until: now() + LOCK_MS });
      audit(db, userId, "pin_failed");
      throw new Error("الـ PIN غلط");
    }
    fails.delete(userId);
    return u;
  };

  /** Acts as `min` role: the logged-in user if senior enough, otherwise a manager's PIN approval. */
  const authorize = (min: Role, approval?: Approval): { actor: SessionUser; approvedBy?: number } => {
    const actor = need("cashier");
    if (RANK[actor.role] >= RANK[min]) return { actor };
    if (!approval) throw new Error("محتاج اعتماد المدير");
    const a = checkPin(approval.userId, approval.pin);
    if (RANK[a.role] < RANK[min]) throw new Error("اعتماد المدير غلط");
    audit(db, a.id, "approval_granted", { for: actor.id });
    return { actor, approvedBy: a.id };
  };

  const requireShift = (u: SessionUser) => {
    const sh = currentShift(db, u.id);
    if (!sh) throw new Error("افتح وردية الأول");
    return sh;
  };

  const backupInto = async (dir: string, tag = "market") => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${tag}-${stamp(now())}.db`);
    await db.backup(file);
    return file;
  };
  const pruneBackups = (dir: string) => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".db")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) rmSync(join(dir, f), { force: true });
  };

  const svc: Service = {
    async bootstrap() {
      const users = listUsers(db);
      return {
        users, needsSetup: users.length === 0, license: license(), deviceCode: fingerprint, brand: brand(), user,
        shift: user ? (currentShift(db, user.id) ?? null) : null, demo: deps.isDemo?.() ?? false,
      };
    },

    async setupOwner(name, pin) {
      if (listUsers(db).length) throw new Error("السيستم متظبط قبل كده");
      createUser(db, name, "owner", pin);
    },

    async login(userId, pin) {
      const u = checkPin(userId, pin);
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

    async scan(raw) {
      need("cashier");
      const code = raw.trim();
      const hit = (p: { id: number; name: string; price: number; stock: number; by_weight: number }, qty?: number) =>
        ({ id: p.id, name: p.name, price: p.price, stock: p.stock, byWeight: !!p.by_weight, ...(qty !== undefined ? { qty } : {}) });
      const direct = findByBarcode(db, code);
      if (direct) return hit(direct);
      const b = brand();
      const sc = parseScaleBarcode(code, { prefix: b.scale_prefix, pluLen: Number(b.scale_plu_len) || 5 });
      if (sc) {
        const p = findByBarcode(db, sc.plu) ?? findByBarcode(db, String(Number(sc.plu)));
        if (p) {
          const qty = b.scale_mode === "price" ? sc.value / p.price : sc.value / 1000;
          return hit(p, Math.round(qty * 1000) / 1000);
        }
      }
      return null;
    },

    async search(q) {
      need("cashier");
      return searchProducts(db, q);
    },

    async checkout(i) {
      const hasDiscount = (i.invoiceDiscount ?? 0) > 0 || i.lines.some((l) => (l.discount ?? 0) > 0);
      const { actor, approvedBy } = hasDiscount ? authorize("manager", i.approval) : { actor: need("cashier"), approvedBy: undefined };
      if (license().mode === "readonly") throw new Error("الترخيص منتهي: البيع موقوف");
      const shift = requireShift(actor);
      if (!i.lines.length) throw new Error("الفاتورة فاضية");
      const b = brand();
      const taxRate = Number(b.tax_rate) / 100, taxInclusive = b.tax_inclusive === "1";
      let customerName: string | undefined;
      if (i.payMethod === "credit") {
        const c = i.customerId ? getCustomer(db, i.customerId) : undefined;
        if (!c) throw new Error("اختار العميل للبيع الآجل");
        customerName = c.name;
      }
      const sale = db.transaction(() => {
        const r = createSale(db, {
          userId: actor.id, lines: i.lines, payMethod: i.payMethod, invoiceDiscount: i.invoiceDiscount, taxRate, taxInclusive,
          shiftId: shift.id, customerId: i.customerId, paidNow: i.paidNow, createdAt: now(),
        });
        if (i.payMethod === "credit") {
          const c = getCustomer(db, i.customerId!)!; // balance already includes this sale
          if (c.creditLimit <= 0) throw new Error("العميل ده مش مسموحله بالآجل");
          if (c.balance > c.creditLimit) throw new Error("العميل تعدّى حد الآجل");
        }
        return r;
      })();
      if (approvedBy) audit(db, approvedBy, "discount_approved", { sale: sale.no });
      const items = db.prepare("SELECT name,qty,unit_price AS unitPrice,discount FROM sale_items WHERE sale_id=?").all(sale.saleId) as any[];
      const receiptHtml = buildReceiptHtml({
        brand: b, no: sale.no, cashier: actor.name, createdAt: now(), items, subtotal: sale.subtotal, discount: sale.discount,
        tax: sale.tax, total: sale.total, payMethod: i.payMethod, customerName, paid: sale.paid,
      });
      return { no: sale.no, total: sale.total, receiptHtml };
    },

    async importCsv(text) {
      const u = need("manager");
      const { products, errors } = parseProductsCsv(text);
      const r = importProducts(db, products, now());
      audit(db, u.id, "products_imported", { ...r, errors: errors.length });
      return { ...r, errors };
    },

    async print(html) {
      need("cashier");
      await print(html);
    },

    async addUser(name, role, pin) {
      const u = need("owner");
      createUser(db, name, role, pin);
      audit(db, u.id, "user_added", { name, role });
    },
    async setUserActive(userId, active) {
      const u = need("owner");
      if (userId === u.id) throw new Error("مينفعش توقف نفسك");
      setUserActive(db, userId, active);
      audit(db, u.id, active ? "user_enabled" : "user_disabled", { userId });
    },
    async resetPin(userId, pin) {
      const u = need("owner");
      setPin(db, userId, pin);
      audit(db, u.id, "pin_reset", { userId });
    },

    // ---- shifts ----
    async openShift(openingCash) {
      const u = need("cashier");
      const id = openShift(db, u.id, openingCash, now());
      audit(db, u.id, "shift_opened", { id, openingCash });
      return currentShift(db, u.id)!;
    },
    async closeShift(countedCash) {
      const u = need("cashier");
      const sh = requireShift(u);
      const r = closeShift(db, sh.id, countedCash, now());
      audit(db, u.id, "shift_closed", { id: sh.id, difference: r.difference });
      const reportHtml = buildShiftReportHtml({ brand: brand(), cashier: u.name, openedAt: sh.openedAt, closedAt: now(), ...r });
      svc.autoBackup().catch(() => {});
      deps.cloud?.syncNow().catch(() => {});
      return { ...r, reportHtml };
    },

    // ---- held carts ----
    async holdCart(label, data) {
      const u = need("cashier");
      db.prepare("INSERT INTO held_carts(user_id,label,data,created_at) VALUES(?,?,?,?)").run(u.id, label.trim() || "فاتورة معلّقة", data, now());
    },
    async listHeld() {
      const u = need("cashier");
      return db.prepare("SELECT id,label,created_at AS createdAt,data FROM held_carts WHERE user_id=? ORDER BY id DESC").all(u.id) as any[];
    },
    async resumeHeld(id) {
      const u = need("cashier");
      const r = db.prepare("SELECT data FROM held_carts WHERE id=? AND user_id=?").get(id, u.id) as { data: string } | undefined;
      if (!r) throw new Error("الفاتورة المعلّقة مش موجودة");
      db.prepare("DELETE FROM held_carts WHERE id=?").run(id);
      return r.data;
    },
    async deleteHeld(id) {
      const u = need("cashier");
      db.prepare("DELETE FROM held_carts WHERE id=? AND user_id=?").run(id, u.id);
    },

    // ---- returns ----
    async findSale(no) {
      need("cashier");
      return getSaleForReturn(db, no);
    },
    async createReturn(i) {
      const { actor, approvedBy } = authorize("manager", i.approval);
      const sh = requireShift(actor);
      const r = createReturn(db, { saleNo: i.saleNo, userId: actor.id, approvedBy, shiftId: sh.id, lines: i.lines, refundMethod: i.refundMethod, reason: i.reason, createdAt: now() });
      audit(db, approvedBy ?? actor.id, "return_created", { sale: i.saleNo, total: r.total, by: actor.id });
      return { total: r.total, method: r.method };
    },

    // ---- customers ----
    async listCustomers(q) {
      need("cashier");
      return listCustomers(db, q ?? "");
    },
    async addCustomer(name, phone, creditLimit) {
      const u = need("manager");
      const id = addCustomer(db, { name, phone, creditLimit }, now());
      audit(db, u.id, "customer_added", { id });
      return id;
    },
    async setCreditLimit(customerId, limit) {
      const u = need("manager");
      if (limit < 0) throw new Error("الحد غلط");
      setCreditLimit(db, customerId, limit);
      audit(db, u.id, "credit_limit_changed", { customerId, limit });
    },
    async customerStatement(customerId) {
      need("cashier");
      return statement(db, customerId);
    },
    async receivePayment(customerId, amount, method) {
      const u = need("cashier");
      const shift = method === "cash" ? requireShift(u) : currentShift(db, u.id);
      const left = addPayment(db, { customerId, amount, method, shiftId: shift?.id, userId: u.id, createdAt: now() });
      audit(db, u.id, "debt_payment", { customerId, amount, method });
      return left;
    },

    // ---- expenses ----
    async addExpense(category, amount, note) {
      const u = need("manager");
      addExpense(db, { category, amount, note, userId: u.id, createdAt: now() });
    },
    async listExpenses(range) {
      need("manager");
      const r = rangeFor(range, now());
      return listExpenses(db, r.from, r.to);
    },
    async deleteExpense(id) {
      const u = need("owner");
      deleteExpense(db, id);
      audit(db, u.id, "expense_deleted", { id });
    },

    // ---- inventory ----
    async listProducts(q, filter) {
      need("cashier");
      return listProducts(db, q, filter);
    },
    async saveProduct(p) {
      const u = need("manager");
      const id = saveProduct(db, p);
      audit(db, u.id, p.id ? "product_edited" : "product_added", { id, price: p.price });
      return id;
    },
    async receiveStock(i) {
      const u = need("manager");
      receiveStock(db, { ...i, now: now() });
      audit(db, u.id, "stock_received", { productId: i.productId, qty: i.qty });
    },
    async adjustStock(productId, actual) {
      const u = need("manager");
      const delta = adjustStock(db, productId, actual, now());
      audit(db, u.id, "stock_adjusted", { productId, delta });
      return delta;
    },
    async expiring(withinDays) {
      need("manager");
      return expiringBatches(db, withinDays, now(), 200);
    },

    // ---- analytics & backups ----
    async analytics(range) {
      need("manager");
      return analytics(db, rangeFor(range, now()), now(), Number(brand().expiry_alert_days) || 30);
    },

    async backupNow() {
      need("manager");
      if (!deps.backupDir) throw new Error("النسخ الاحتياطي مش متاح");
      const f = await backupInto(deps.backupDir);
      pruneBackups(deps.backupDir);
      return f;
    },
    async backupExport() {
      const u = need("owner");
      const dir = await deps.pickFolder?.();
      if (!dir) return null;
      const f = await backupInto(dir, "market-backup");
      audit(db, u.id, "backup_exported");
      return f;
    },
    async restoreBackup() {
      const u = need("owner");
      const file = await deps.pickFile?.();
      if (!file) return false;
      const v = validateBackup(file);
      if (!v.ok) throw new Error(v.reason);
      if (deps.backupDir) await backupInto(deps.backupDir, "before-restore");
      audit(db, u.id, "backup_restored", { file });
      await deps.restoreFrom?.(file);
      return true;
    },
    async autoBackup() {
      if (!deps.backupDir) return;
      if (now() - Number(getSetting(db, "last_auto_backup") ?? 0) < 20 * 3_600_000) return;
      await backupInto(deps.backupDir);
      pruneBackups(deps.backupDir);
      setSetting(db, "last_auto_backup", String(now()));
    },

    // ---- demo, support, cloud ----
    async enterDemo() { await deps.enterDemo?.(); },
    async exitDemo() { await deps.exitDemo?.(); },
    async contactSupport(message) {
      const text = message ?? `السلام عليكم، محتاج مساعدة في برنامج الكاشير.\nالمحل: ${brand().brand_name}\nكود الجهاز: ${fingerprint}`;
      await deps.openUrl?.(whatsappUrl(text));
    },

    async cloudStatus() {
      need("manager");
      return deps.cloud?.status() ?? { configured: false, linked: false, email: "", lastSync: 0, lastError: "" };
    },
    async cloudLink(email, password) {
      const u = need("owner");
      if (!deps.cloud) throw new Error("الخدمة السحابية مش متاحة في النسخة دي");
      const s = await deps.cloud.link(email, password);
      audit(db, u.id, "cloud_linked", { email });
      return s;
    },
    async cloudUnlink() {
      const u = need("owner");
      audit(db, u.id, "cloud_unlinked");
      return deps.cloud!.unlink();
    },
    async cloudSyncNow() {
      need("manager");
      if (!deps.cloud) throw new Error("الخدمة السحابية مش متاحة في النسخة دي");
      return deps.cloud.syncNow();
    },
  };
  return svc;
}
