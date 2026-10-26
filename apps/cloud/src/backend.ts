import type { Analytics, RangePreset, SupplierDue } from "@market/core";

export interface CloudUser { uid: string; email: string; name: string }
export interface ShopRef { id: string; linkedAt: number }
export interface ShopStatus { brand: string; syncedAt: number; integrityOk: boolean; lastInvoice: number }
export interface SaleRow {
  no: number; createdAt: number; total: number; payMethod: string; cashier: string; customer: string;
  discount: number; items: { name: string; qty: number; unitPrice: number; discount: number }[];
}
export interface ShiftRow { id: number; cashier: string; openedAt: number; closedAt: number; openingCash: number; counted: number; expected: number }
export interface TreasuryDoc {
  cash: number; bank: number; total: number; receivables: number; payables: number;
  entries: { at: number; account: "cash" | "bank"; kind: string; note: string | null; delta: number; balance: number; user: string | null }[];
}
export interface SuppliersDoc {
  dues: SupplierDue[];
  invoices: { id: number; supplier: string; ref: string; date: number; due: number | null; total: number; paid: number; remaining: number; status: string }[];
}

/** Everything the site needs from the cloud; Firebase in production, a fixture for design previews. */
export interface Backend {
  configured: boolean;
  onAuth(cb: (u: CloudUser | null) => void): () => void;
  signInGoogle(): Promise<void>;
  signInEmail(email: string, password: string): Promise<void>;
  signUpEmail(email: string, password: string): Promise<void>;
  resetPassword(email: string): Promise<void>;
  logout(): Promise<void>;
  watchShops(uid: string, cb: (s: ShopRef[]) => void): () => void;
  /** Claims the shop that issued this pairing code for the signed-in owner; resolves to the shop id. */
  linkShop(user: CloudUser, code: string): Promise<string>;
  unlinkShop(uid: string, shopId: string): Promise<void>;
  watchStatus(shopId: string, cb: (s: ShopStatus | null) => void): () => void;
  watchReport(shopId: string, range: RangePreset, cb: (a: Analytics | null) => void): () => void;
  watchSales(shopId: string, cb: (s: SaleRow[]) => void): () => void;
  watchShifts(shopId: string, cb: (s: ShiftRow[]) => void): () => void;
  watchTreasury(shopId: string, cb: (t: TreasuryDoc | null) => void): () => void;
  watchSuppliers(shopId: string, cb: (s: SuppliersDoc | null) => void): () => void;
}
