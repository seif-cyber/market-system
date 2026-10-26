import mock from "@mock";
import type { Analytics, RangePreset } from "@market/core";
import type { Backend, SaleRow, ShiftRow, ShopStatus, SuppliersDoc, TreasuryDoc } from "./backend";

interface Fixture { status: ShopStatus; reports: Record<RangePreset, Analytics>; sales: SaleRow[]; shifts: ShiftRow[]; treasury: TreasuryDoc; suppliers: SuppliersDoc }

/** Design-preview backend (build with `--mode mock`); never reachable in production builds. */
export function createMockBackend(): Backend {
  const f = mock as unknown as Fixture;
  const later = <T,>(cb: (v: T) => void, v: T) => { const t = setTimeout(() => cb(v), 30); return () => clearTimeout(t); };
  const params = new URLSearchParams(location.search);
  let linked = !params.has("noshops");
  const listeners: ((s: { id: string; linkedAt: number }[]) => void)[] = [];
  const push = () => setTimeout(() => listeners.forEach((l) => l(linked ? [{ id: "mock", linkedAt: 1 }] : [])), 30);
  return {
    configured: true,
    onAuth: (cb) => (params.has("loggedout") ? later(cb, null) : later(cb, { uid: "mock", email: "owner@shop.com", name: "صاحب المحل" })),
    signInGoogle: async () => {}, signInEmail: async () => {}, signUpEmail: async () => {}, resetPassword: async () => {}, logout: async () => {},
    watchShops: (_u, cb) => { listeners.push(cb); push(); return () => { listeners.splice(listeners.indexOf(cb), 1); }; },
    linkShop: async (_u, code) => { if (code.replace(/[^A-Za-z0-9]/g, "").length !== 10) throw new Error("الكود لازم يكون 10 حروف وأرقام"); linked = true; push(); return "mock"; },
    unlinkShop: async () => { linked = false; push(); },
    watchStatus: (_s, cb) => later(cb, { ...f.status, syncedAt: Date.now() - 4 * 60_000 }),
    watchReport: (_s, r, cb) => later(cb, f.reports[r]),
    watchSales: (_s, cb) => later(cb, f.sales),
    watchShifts: (_s, cb) => later(cb, f.shifts),
    watchTreasury: (_s, cb) => later(cb, f.treasury),
    watchSuppliers: (_s, cb) => later(cb, f.suppliers),
  };
}
