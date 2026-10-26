import type { LicenseState } from "./licenseStatus";

export type Role = "owner" | "manager" | "cashier";
export interface SessionUser { id: number; name: string; role: Role }
export interface ProductHit { id: number; name: string; price: number; stock: number; qty?: number; byWeight?: boolean }
export type RangePreset = "today" | "7d" | "30d" | "month";

export interface BrandSettings {
  brand_name: string;
  logo: string; // data URL ("" = none)
  address: string;
  phone: string;
  tax_no: string;
  footer: string;
  tax_rate: string; // percent, e.g. "14"
  tax_inclusive: string; // "1" | "0"
  scale_prefix: string; // shop-scale barcode prefix, e.g. "20"
  scale_mode: string; // "weight" | "price"
  scale_plu_len: string;
  expiry_alert_days: string;
}

export interface ShiftInfo { id: number; openedAt: number; openingCash: number }
/** Cash the previous cashier counted at close: what the next cashier should find in the drawer. */
export interface Handover { counted: number; cashier: string; closedAt: number }
export interface ShiftHistoryRow {
  id: number; cashier: string; openedAt: number; closedAt: number | null; openingCash: number;
  totalSales: number; invoices: number; cashSales: number; cardSales: number; creditSales: number; returns: number;
  expected: number; counted: number | null; difference: number | null;
}

export interface Bootstrap {
  users: { id: number; name: string; role: Role }[];
  needsSetup: boolean;
  license: LicenseState;
  deviceCode: string;
  brand: BrandSettings;
  user: SessionUser | null;
  shift: ShiftInfo | null;
  handover: Handover | null;
  demo: boolean;
}

export interface Approval { userId: number; pin: string }

export interface CheckoutInput {
  lines: { productId: number; qty: number; discount?: number }[];
  payMethod: "cash" | "card" | "credit";
  invoiceDiscount?: number;
  customerId?: number;
  paidNow?: number;
  approval?: Approval;
}
export interface CheckoutResult { no: number; total: number; receiptHtml: string }

export interface ShiftSummary {
  openingCash: number; invoices: number; totalSales: number; cashSales: number; cardSales: number;
  creditSales: number; cashReturns: number; cardReturns: number; debtPayments: number; payouts: number; expectedCash: number;
}
export interface CloseShiftResult { summary: ShiftSummary; counted: number; difference: number; reportHtml: string }

export interface HeldCart { id: number; label: string; createdAt: number; data: string }

export interface SaleForReturn {
  id: number; no: number; createdAt: number; total: number; payMethod: string; customerName: string | null;
  items: { id: number; name: string; unitPrice: number; qty: number; discount: number; returned: number }[];
}
export interface ReturnInput {
  saleNo: number;
  lines: { saleItemId: number; qty: number }[];
  refundMethod?: "cash" | "card";
  reason?: string;
  approval?: Approval;
}

export interface Customer { id: number; name: string; phone: string; creditLimit: number; balance: number }
export interface LedgerEntry { id: number; delta: number; kind: string; method: string | null; note: string | null; createdAt: number; balanceAfter: number }
export interface Expense { id: number; category: string; amount: number; note: string; createdAt: number; userName: string; paidFrom: Account; fromDrawer: boolean }

export interface InventoryProduct { id: number; name: string; barcode: string; price: number; cost: number; stock: number; minStock: number; byWeight: boolean }
export interface SaveProductInput { id?: number; name: string; barcode: string; price: number; cost: number; minStock: number; byWeight: boolean }
export interface ReceiveStockInput { productId: number; qty: number; cost?: number; expiry?: number }
export interface ExpiringBatch { productId: number; name: string; qty: number; expiry: number; daysLeft: number }

export interface Analytics {
  range: { from: number; to: number };
  kpi: { sales: number; invoices: number; avgBasket: number; returns: number; netSales: number; grossProfit: number; expenses: number; netProfit: number; prevNetSales: number };
  daily: { day: string; sales: number }[];
  hourly: { hour: number; sales: number; invoices: number }[];
  topProducts: { name: string; qty: number; revenue: number; profit: number }[];
  deadStock: { name: string; stock: number; value: number }[];
  cashiers: { name: string; invoices: number; sales: number; returns: number; discounts: number; cashDiff: number }[];
  payments: { method: string; total: number }[];
  expensesByCategory: { category: string; total: number }[];
  lowStock: { id: number; name: string; stock: number; minStock: number }[];
  expiring: ExpiringBatch[];
  debts: { total: number; top: { name: string; balance: number }[] };
  integrity: { ok: boolean; checked: number; brokenAt: number | null };
  /** Money position right now (not period-based): treasury balances and what is owed to / by the shop. */
  position: { cash: number; bank: number; total: number; receivables: number; payables: number };
  treasuryCheck: { ok: boolean; mismatches: number };
}

export type Account = "cash" | "bank";
export interface TreasuryEntry {
  id: number; account: Account; delta: number; kind: string; refTable: string | null; refId: number | null; shiftId: number | null;
  inDrawer: boolean; userName: string | null; approvedByName: string | null; note: string | null; createdAt: number; balanceAfter: number;
}
export interface TreasurySnapshot {
  cash: number; bank: number; total: number; receivables: number; payables: number; net: number;
  check: { ok: boolean; checked: number; mismatches: { kind: string; account: Account; expected: number; actual: number }[] };
}

export interface CloudStatus {
  configured: boolean; // Firebase project settings were built into this app
  linked: boolean;
  email: string;
  lastSync: number; // epoch ms, 0 = never
  lastError: string;
}

/** Everything the UI can ask the main process to do. */
export interface Api {
  bootstrap(): Promise<Bootstrap>;
  setupOwner(name: string, pin: string): Promise<void>;
  login(userId: number, pin: string): Promise<SessionUser>;
  logout(): Promise<void>;
  saveSettings(s: Partial<BrandSettings>): Promise<BrandSettings>;
  activate(token: string): Promise<LicenseState>;
  scan(code: string): Promise<ProductHit | null>;
  search(q: string): Promise<ProductHit[]>;
  checkout(i: CheckoutInput): Promise<CheckoutResult>;
  importCsv(text: string): Promise<{ created: number; updated: number; errors: string[] }>;
  print(html: string): Promise<void>;
  addUser(name: string, role: Role, pin: string): Promise<void>;
  setUserActive(userId: number, active: boolean): Promise<void>;
  resetPin(userId: number, pin: string): Promise<void>;

  openShift(openingCash: number, approval?: Approval, reason?: string): Promise<ShiftInfo>;
  shiftReport(): Promise<{ shift: ShiftInfo; summary: ShiftSummary } | null>;
  listShifts(): Promise<ShiftHistoryRow[]>;
  closeShift(countedCash: number): Promise<CloseShiftResult>;
  holdCart(label: string, data: string): Promise<void>;
  listHeld(): Promise<HeldCart[]>;
  resumeHeld(id: number): Promise<string>;
  deleteHeld(id: number): Promise<void>;

  findSale(no: number): Promise<SaleForReturn | null>;
  createReturn(i: ReturnInput): Promise<{ total: number; method: string }>;

  listCustomers(q?: string): Promise<Customer[]>;
  addCustomer(name: string, phone: string, creditLimit: number): Promise<number>;
  setCreditLimit(customerId: number, limit: number): Promise<void>;
  customerStatement(customerId: number): Promise<LedgerEntry[]>;
  receivePayment(customerId: number, amount: number, method: "cash" | "card"): Promise<number>;

  addExpense(category: string, amount: number, note: string, paidFrom?: Account, fromDrawer?: boolean): Promise<void>;
  listExpenses(range: RangePreset): Promise<Expense[]>;
  deleteExpense(id: number): Promise<void>;

  listProducts(q: string, filter: "all" | "low" | "out"): Promise<InventoryProduct[]>;
  saveProduct(p: SaveProductInput): Promise<number>;
  receiveStock(i: ReceiveStockInput): Promise<void>;
  adjustStock(productId: number, actual: number): Promise<number>;
  expiring(withinDays: number): Promise<ExpiringBatch[]>;

  analytics(range: RangePreset): Promise<Analytics>;
  treasury(): Promise<TreasurySnapshot>;
  treasuryEntries(f?: { account?: Account; kind?: string; range?: RangePreset | "all" }): Promise<TreasuryEntry[]>;
  treasuryDeposit(account: Account, amount: number, note: string): Promise<void>;
  treasuryWithdraw(account: Account, amount: number, note: string): Promise<void>;
  treasuryTransfer(from: Account, to: Account, amount: number, note: string): Promise<void>;
  treasuryCount(account: Account, counted: number, note: string): Promise<number>;
  backupNow(): Promise<string>;
  backupExport(): Promise<string | null>;
  restoreBackup(): Promise<boolean>;

  enterDemo(): Promise<void>;
  exitDemo(): Promise<void>;
  contactSupport(who?: "primary" | "secondary", message?: string): Promise<void>;
  remindCustomer(customerId: number): Promise<void>;

  cloudStatus(): Promise<CloudStatus>;
  cloudLink(email: string, password: string): Promise<CloudStatus>;
  cloudUnlink(): Promise<CloudStatus>;
  cloudSyncNow(): Promise<CloudStatus>;
}
