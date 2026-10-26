import { describe, expect, it } from "vitest";
import { analytics, balances, listCustomers, listEntries, openDb, rangeFor, verifySalesChain, verifyTreasury } from "@market/db";
import { seedDemo } from "./demo";

describe("demo data", () => {
  it("builds a believable shop: sales history, profit, alerts, debts, intact chain", () => {
    const db = openDb(":memory:");
    const now = new Date(2026, 5, 15, 18, 0, 0).getTime();
    seedDemo(db, now);
    const a = analytics(db, rangeFor("30d", now), now);
    expect(a.kpi.invoices).toBeGreaterThan(500);
    expect(a.kpi.grossProfit).toBeGreaterThan(0);
    expect(a.kpi.netProfit).toBeLessThan(a.kpi.grossProfit); // expenses exist
    expect(a.expiring.length).toBeGreaterThan(0);
    expect(a.lowStock.length).toBeGreaterThan(0);
    expect(a.deadStock.length).toBeGreaterThan(0);
    expect(a.debts.total).toBeGreaterThan(0);
    expect(a.cashiers.length).toBeGreaterThanOrEqual(2);
    expect(a.daily.length).toBe(30);
    expect(verifySalesChain(db).ok).toBe(true);
    const t = verifyTreasury(db);
    expect(t.mismatches).toEqual([]);
    const b = balances(db);
    expect(b.cash).toBeGreaterThan(0);
    expect(b.bank).toBeGreaterThan(0);
    expect(listEntries(db, { kind: "handover_adjust" })).toHaveLength(0); // every shift opened with exactly the handed-over cash
    expect(a.position.total).toBe(b.total);
    expect(a.treasuryCheck.ok).toBe(true);
    expect(listCustomers(db).some((c) => c.balance > c.creditLimit)).toBe(false);
    console.log("demo:", { cash: b.cash / 100, bank: b.bank / 100, invoices: a.kpi.invoices, net: a.kpi.netSales / 100, profit: a.kpi.netProfit / 100, debts: a.debts.total / 100 });
  });
});
