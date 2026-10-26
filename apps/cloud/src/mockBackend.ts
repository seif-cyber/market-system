import mock from "@mock";
import type { Analytics, RangePreset } from "@market/core";
import type { Backend, SaleRow, ShiftRow, ShopStatus } from "./backend";

interface Fixture { status: ShopStatus; reports: Record<RangePreset, Analytics>; sales: SaleRow[]; shifts: ShiftRow[] }

/** Design-preview backend (build with `--mode mock`); never reachable in production builds. */
export function createMockBackend(): Backend {
  const f = mock as unknown as Fixture;
  const later = <T,>(cb: (v: T) => void, v: T) => { const t = setTimeout(() => cb(v), 30); return () => clearTimeout(t); };
  return {
    configured: true,
    onAuth: (cb) => later(cb, { uid: "mock", email: "owner@shop.com" }),
    login: async () => {}, logout: async () => {},
    watchStatus: (_u, cb) => later(cb, { ...f.status, syncedAt: Date.now() - 4 * 60_000 }),
    watchReport: (_u, r, cb) => later(cb, f.reports[r]),
    watchSales: (_u, cb) => later(cb, f.sales),
    watchShifts: (_u, cb) => later(cb, f.shifts),
  };
}
