import type { LicenseState } from "./licenseStatus";

export type Role = "owner" | "manager" | "cashier";
export interface SessionUser { id: number; name: string; role: Role }
export interface ProductHit { id: number; name: string; price: number; stock: number }

export interface BrandSettings {
  brand_name: string;
  logo: string; // data URL ("" = none)
  address: string;
  phone: string;
  tax_no: string;
  footer: string;
  tax_rate: string; // percent, e.g. "14"
  tax_inclusive: string; // "1" | "0"
}

export interface Bootstrap {
  users: { id: number; name: string; role: Role }[];
  needsSetup: boolean;
  license: LicenseState;
  deviceCode: string;
  brand: BrandSettings;
  user: SessionUser | null;
}

export interface CheckoutInput {
  lines: { productId: number; qty: number; discount?: number }[];
  payMethod: "cash" | "card" | "mixed";
  invoiceDiscount?: number;
}

export interface CheckoutResult { no: number; total: number; receiptHtml: string }

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
  todaySummary(): Promise<{ count: number; total: number; cash: number; card: number }>;
  addUser(name: string, role: Role, pin: string): Promise<void>;
  print(html: string): Promise<void>;
}
