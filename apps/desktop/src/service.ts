import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  applyPromotions, licenseState, parsePartiesCsv, parseProductsCsv, parseScaleBarcode, SUPPORT_CONTACTS, whatsappUrl,
  type Api, type Approval, type BrandSettings, type CloudStatus, type PaySource, type PromotionRow, type RangePreset, type ReportFilters, type Role, type SessionUser,
} from "@market/core";
import {
  addCategory, addSupplierOpening, beginImport, createPurchase, deleteCategory, getParty, importParties, listActivePromotions, listCategories, listImports,
  listParties, listPromotions, listPurchases, listReports, paySupplier, purchaseItems, renameCategory, runReport as dbRunReport,
  saveParty, savePromotion, seedDefaultCategories, setPartyActive, setPromotionActive, supplierDues, supplierStatement, toParams, totalPayables,
  undoImport, voidPurchase,
  addCustomer, addExpense, addPayment, adjustStock, analytics, audit, closeShift, createReturn, createSale, createUser,
  balances, countAdjust, currentShift, deposit, lastClosedShift, listEntries, totalReceivables, transfer, verifyTreasury, voidExpense, withdraw, shiftHistory, shiftSummary, expiringBatches, findByBarcode, getCustomer, getSaleForReturn, getSetting, importProducts,
  listCustomers, listExpenses, listProducts, listUsers, loginWithPin, openShift, rangeFor, receiveStock, saveProduct,
  searchProducts, setCreditLimit, setPin, setSetting, setUserActive, statement, validateBackup, type Db,
} from "@market/db";
import { buildReceiptHtml, buildShiftReportHtml } from "./receipt";
import { reportHtml, reportXlsx } from "./exportReport";

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
  /** Save/print a report (dialogs live in the main process). Returns the saved path, or null when cancelled. */
  exportFile?: (a: { kind: "xlsx" | "pdf" | "print"; title: string; html: string; buildXlsx: () => Promise<Buffer> }) => Promise<string | null>;
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

  /** Best running promotion per cart line, computed here (never trusted from the UI). */
  const promoFor = (lines: { productId: number; qty: number }[]) => {
    const info = lines.map((l) => (db.prepare("SELECT price, category_id c FROM products WHERE id=?").get(l.productId) ?? { price: 0, c: null }) as { price: number; c: number | null });
    const res = applyPromotions(lines.map((l, k) => ({ productId: l.productId, categoryId: info[k].c, unitPrice: info[k].price, qty: l.qty })), listActivePromotions(db, now()), now());
    return res.map((r, k) => ({ ...r, gross: Math.round(info[k].price * lines[k].qty) }));
  };
  const range = (r?: RangePreset | "all") => (r && r !== "all" ? rangeFor(r, now()) : { from: 0, to: now() });
  /** A custom "to" date is the start of that day; reports include the whole day. */
  const normalize = (f: ReportFilters): ReportFilters => (f.range === "custom" && f.to ? { ...f, to: f.to + 86_400_000 - 1 } : f);
  const payAccount = (source: PaySource, u: SessionUser) => {
    if (source === "drawer") return { account: "cash" as const, inDrawer: true, shiftId: requireShift(u).id };
    return { account: source, inDrawer: false, shiftId: undefined };
  };

  const svc: Service = {
    async bootstrap() {
      const users = listUsers(db);
      return {
        users, needsSetup: users.length === 0, license: license(), deviceCode: fingerprint, brand: brand(), user,
        shift: user ? (currentShift(db, user.id) ?? null) : null, handover: lastClosedShift(db) ?? null, demo: deps.isDemo?.() ?? false,
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
      // Promotions are applied server-side; a manual line discount (already approved above) is kept and added to.
      const promos = promoFor(i.lines);
      const lines = i.lines.map((l, k) => {
        const manual = l.discount ?? 0;
        const pd = Math.min(promos[k].discount, Math.max(0, promos[k].gross - manual));
        return { productId: l.productId, qty: l.qty, discount: manual + pd, promoId: pd > 0 ? promos[k].promoId : null, promoDiscount: pd };
      });
      const sale = db.transaction(() => {
        const r = createSale(db, {
          userId: actor.id, lines, payMethod: i.payMethod, invoiceDiscount: i.invoiceDiscount, taxRate, taxInclusive,
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
      const items = db.prepare("SELECT name,qty,unit_price AS unitPrice,discount,promo_discount AS promo FROM sale_items WHERE sale_id=?").all(sale.saleId) as any[];
      const receiptHtml = buildReceiptHtml({
        brand: b, no: sale.no, cashier: actor.name, createdAt: now(), items, subtotal: sale.subtotal, discount: sale.discount,
        tax: sale.tax, total: sale.total, payMethod: i.payMethod, customerName, paid: sale.paid,
      });
      return { no: sale.no, total: sale.total, receiptHtml };
    },

    async importCsv(text, fileName) {
      const u = need("manager");
      const { products, errors } = parseProductsCsv(text);
      const batchId = products.length ? beginImport(db, "products", fileName || "ملف أصناف", u.id, now()) : null;
      const r = importProducts(db, products, now(), batchId ?? undefined);
      audit(db, u.id, "products_imported", { ...r, errors: errors.length, batchId });
      return { ...r, errors, batchId };
    },
    async listImports() {
      need("manager");
      return listImports(db);
    },
    async undoImport(id) {
      const u = need("manager");
      const r = undoImport(db, id, now());
      audit(db, u.id, "import_undone", { id, ...r });
      return r;
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
    async openShift(openingCash, approval, reason) {
      const u = need("cashier");
      const prev = lastClosedShift(db);
      let approvedBy: number | undefined;
      if (prev && openingCash !== prev.counted) {
        // Locked to the handed-over amount; changing it takes a manager and a reason (booked on the treasury).
        if (!reason?.trim()) throw new Error("اكتب سبب الاختلاف عن المبلغ المتسلّم");
        const a = authorize("manager", approval);
        approvedBy = a.approvedBy ?? a.actor.id;
      }
      const id = openShift(db, u.id, openingCash, now(), { approvedBy, reason: reason?.trim() });
      // Handover check: what the previous cashier counted vs what this one says they received.
      audit(db, u.id, "shift_opened", { id, openingCash, previousCounted: prev?.counted ?? null, mismatch: prev ? openingCash - prev.counted : 0 });
      return currentShift(db, u.id)!;
    },
    async shiftReport() {
      const u = need("cashier");
      const sh = currentShift(db, u.id);
      return sh ? { shift: sh, summary: shiftSummary(db, sh.id) } : null;
    },
    async listShifts() {
      need("manager");
      return shiftHistory(db, 100);
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
    async addExpense(category, amount, note, paidFrom, fromDrawer) {
      const u = need("manager");
      const shift = fromDrawer ? requireShift(u) : undefined;
      addExpense(db, { category, amount, note, userId: u.id, createdAt: now(), paidFrom: paidFrom ?? "cash", fromDrawer: !!fromDrawer, shiftId: shift?.id });
    },
    async listExpenses(range) {
      need("manager");
      const r = rangeFor(range, now());
      return listExpenses(db, r.from, r.to).map((e) => ({ ...e, fromDrawer: !!e.fromDrawer }));
    },
    async deleteExpense(id) {
      const u = need("owner");
      voidExpense(db, id, u.id, now());
      audit(db, u.id, "expense_voided", { id });
    },

    // ---- inventory ----
    async listProducts(q, filter, categoryId) {
      const u = need("cashier");
      const rows = listProducts(db, q, filter, 300, categoryId);
      return u.role === "cashier" ? rows.map((r) => ({ ...r, cost: 0 })) : rows; // purchase prices are for managers only
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

    // ---- customers & suppliers (one party list) ----
    async listParties(f) {
      need("manager");
      return listParties(db, f);
    },
    async saveParty(p) {
      const u = need("manager");
      const id = saveParty(db, p, now());
      audit(db, u.id, p.id ? "party_edited" : "party_added", { id, customer: p.isCustomer, supplier: p.isSupplier });
      return id;
    },
    async setPartyActive(id, active) {
      const u = need("manager");
      setPartyActive(db, id, active);
      audit(db, u.id, active ? "party_enabled" : "party_disabled", { id });
    },
    async importParties(csv, fileName) {
      const u = need("manager");
      const { parties, errors } = parsePartiesCsv(csv);
      const batchId = parties.length ? beginImport(db, "parties", fileName || "ملف عملاء وموردين", u.id, now()) : null;
      const r = importParties(db, parties, now(), batchId ?? undefined);
      audit(db, u.id, "parties_imported", { ...r, errors: errors.length, batchId });
      return { ...r, errors, batchId };
    },

    // ---- purchases & suppliers ----
    async supplierStatement(supplierId) {
      need("manager");
      return supplierStatement(db, supplierId);
    },
    async listPurchases(f) {
      need("manager");
      const r = range(f?.range);
      return listPurchases(db, { supplierId: f?.supplierId, from: r.from, to: r.to }, now());
    },
    async purchaseDetails(id) {
      need("manager");
      const invoice = listPurchases(db, { id, limit: 1 }, now())[0];
      return invoice ? { invoice, items: purchaseItems(db, id) } : null;
    },
    async createPurchase(i) {
      const u = need("manager");
      const pay = i.paid && i.paid.amount > 0 ? { amount: i.paid.amount, ...payAccount(i.paid.source, u) } : undefined;
      const r = createPurchase(db, { ...i, paid: pay, userId: u.id, createdAt: now() });
      audit(db, u.id, "purchase_created", { id: r.id, supplier: i.supplierId, total: r.total, paid: r.paid });
      return r;
    },
    async paySupplier(supplierId, amount, source, note) {
      const u = need("manager");
      const left = paySupplier(db, { supplierId, amount, ...payAccount(source, u), userId: u.id, note, createdAt: now() });
      audit(db, u.id, "supplier_paid", { supplierId, amount, source });
      return left;
    },
    async voidPurchase(id) {
      const u = need("manager");
      voidPurchase(db, id, u.id, now());
      audit(db, u.id, "purchase_voided", { id });
    },
    async addSupplierOpening(supplierId, amount, note) {
      const u = need("manager");
      addSupplierOpening(db, supplierId, amount, u.id, note || "رصيد افتتاحي", now());
      audit(db, u.id, "supplier_opening", { supplierId, amount });
    },
    async supplierDues() {
      need("manager");
      return supplierDues(db, now());
    },

    // ---- categories ----
    async listCategories() {
      need("cashier");
      return listCategories(db);
    },
    async addCategory(name) {
      const u = need("manager");
      const id = addCategory(db, name);
      audit(db, u.id, "category_added", { id, name });
      return id;
    },
    async renameCategory(id, name) {
      const u = need("manager");
      renameCategory(db, id, name);
      audit(db, u.id, "category_renamed", { id, name });
    },
    async deleteCategory(id) {
      const u = need("manager");
      deleteCategory(db, id);
      audit(db, u.id, "category_deleted", { id });
    },
    async seedCategories() {
      const u = need("manager");
      const n = seedDefaultCategories(db);
      audit(db, u.id, "categories_seeded", { n });
      return n;
    },

    // ---- promotions ----
    async listPromotions() {
      need("manager");
      const t = now();
      return listPromotions(db).map((p): PromotionRow => ({
        ...p,
        targetName: ((p.target === "product" ? db.prepare("SELECT name FROM products WHERE id=?") : db.prepare("SELECT name FROM categories WHERE id=?")).get(p.targetId) as { name: string } | undefined)?.name ?? "",
        state: !p.active ? "stopped" : p.endsAt < t ? "ended" : p.startsAt > t ? "upcoming" : "running",
      }));
    },
    async savePromotion(p) {
      const u = need("manager");
      const id = savePromotion(db, p, u.id, now());
      audit(db, u.id, p.id ? "promotion_edited" : "promotion_added", { id, name: p.name });
      return id;
    },
    async setPromotionActive(id, active) {
      const u = need("manager");
      setPromotionActive(db, id, active);
      audit(db, u.id, active ? "promotion_enabled" : "promotion_stopped", { id });
    },
    async previewCart(lines) {
      need("cashier");
      const r = lines.length ? promoFor(lines) : [];
      return { lines: lines.map((l, k) => ({ productId: l.productId, discount: r[k].discount, name: r[k].name })), total: r.reduce((s, x) => s + x.discount, 0) };
    },

    // ---- reports ----
    async reportList() {
      need("manager");
      return listReports();
    },
    async runReport(id, f) {
      need("manager");
      return dbRunReport(db, id, toParams(normalize(f), now(), rangeFor), now());
    },
    async exportReport(id, f, kind) {
      const u = need("manager");
      const report = dbRunReport(db, id, toParams(normalize(f), now(), rangeFor), now());
      const b = brand();
      const path = await deps.exportFile?.({ kind, title: report.title, html: reportHtml(report, b, now()), buildXlsx: () => reportXlsx(report, b.brand_name) });
      audit(db, u.id, "report_exported", { id, kind });
      return path ?? null;
    },

    // ---- treasury (owner and manager) ----
    async treasury() {
      need("manager");
      const b = balances(db);
      const receivables = totalReceivables(db), payables = totalPayables(db);
      return { ...b, receivables, payables, net: b.total + receivables - payables, check: verifyTreasury(db) };
    },
    async treasuryEntries(f) {
      need("manager");
      const range = f?.range && f.range !== "all" ? rangeFor(f.range, now()) : undefined;
      return listEntries(db, { account: f?.account, kind: f?.kind, from: range?.from, to: range?.to, limit: 400 });
    },
    async treasuryDeposit(account, amount, note) {
      const u = need("manager");
      deposit(db, { account, amount, userId: u.id, note, createdAt: now() });
      audit(db, u.id, "treasury_deposit", { account, amount });
    },
    async treasuryWithdraw(account, amount, note) {
      const u = need("manager");
      withdraw(db, { account, amount, userId: u.id, note, createdAt: now() });
      audit(db, u.id, "treasury_withdraw", { account, amount });
    },
    async treasuryTransfer(from, to, amount, note) {
      const u = need("manager");
      transfer(db, { from, to, amount, userId: u.id, note, createdAt: now() });
      audit(db, u.id, "treasury_transfer", { from, to, amount });
    },
    async treasuryCount(account, counted, note) {
      const u = need("manager");
      const diff = countAdjust(db, { account, counted, userId: u.id, note, createdAt: now() });
      audit(db, u.id, "treasury_count", { account, counted, diff });
      return diff;
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
    async contactSupport(who, message) {
      const contact = SUPPORT_CONTACTS.find((c) => c.id === who) ?? SUPPORT_CONTACTS[0];
      const text = message ?? `السلام عليكم ${contact.name}، محتاج مساعدة في برنامج الكاشير.\nالمحل: ${brand().brand_name}\nكود الجهاز: ${fingerprint}`;
      await deps.openUrl?.(whatsappUrl(text, contact.phone));
    },

    async remindCustomer(customerId) {
      const u = need("cashier");
      const c = getCustomer(db, customerId);
      if (!c) throw new Error("العميل غير موجود");
      const digits = c.phone.replace(/\D/g, "");
      if (digits.length < 10) throw new Error("رقم تليفون العميل مش مسجّل");
      const intl = digits.startsWith("20") ? digits : digits.replace(/^0/, "20");
      const text = `السلام عليكم ${c.name}، مديونيتكم عند ${brand().brand_name} هي ${(c.balance / 100).toFixed(2)} جنيه. شكراً لتعاملكم معنا.`;
      audit(db, u.id, "debt_reminder", { customerId });
      await deps.openUrl?.(`https://wa.me/${intl}?text=${encodeURIComponent(text)}`);
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
