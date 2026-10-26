import type { Analytics, RangePreset } from "@market/core";

export interface CloudUser { uid: string; email: string }
export interface ShopStatus { brand: string; syncedAt: number; integrityOk: boolean; lastInvoice: number }
export interface SaleRow {
  no: number; createdAt: number; total: number; payMethod: string; cashier: string; customer: string;
  discount: number; items: { name: string; qty: number; unitPrice: number; discount: number }[];
}
export interface ShiftRow { id: number; cashier: string; openedAt: number; closedAt: number; openingCash: number; counted: number; expected: number }

/** Everything the site needs from the cloud; Firebase in production, a fixture for design previews. */
export interface Backend {
  configured: boolean;
  onAuth(cb: (u: CloudUser | null) => void): () => void;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  watchStatus(uid: string, cb: (s: ShopStatus | null) => void): () => void;
  watchReport(uid: string, range: RangePreset, cb: (a: Analytics | null) => void): () => void;
  watchSales(uid: string, cb: (s: SaleRow[]) => void): () => void;
  watchShifts(uid: string, cb: (s: ShiftRow[]) => void): () => void;
}
