import { describe, expect, it } from "vitest";
import { addProduct, createSale, createUser, findByBarcode, getSetting, loginWithPin, openDb, setSetting } from "./index";

const fresh = () => openDb(":memory:");

describe("db", () => {
  it("stores brand settings", () => {
    const db = fresh();
    setSetting(db, "brand_name", "سوبر ماركت النور");
    setSetting(db, "brand_name", "الأمل");
    expect(getSetting(db, "brand_name")).toBe("الأمل");
  });

  it("checks PINs", () => {
    const db = fresh();
    const id = createUser(db, "أحمد", "cashier", "1234");
    expect(loginWithPin(db, id, "1234")?.role).toBe("cashier");
    expect(loginWithPin(db, id, "9999")).toBeNull();
  });

  it("sells by barcode, cuts stock, chains and locks sales", () => {
    const db = fresh();
    const uid = createUser(db, "م", "owner", "1234");
    const pid = addProduct(db, { name: "شاي", price: 5000, stock: 10, barcodes: ["6221"] });
    expect(findByBarcode(db, "6221")?.id).toBe(pid);
    const s1 = createSale(db, { userId: uid, lines: [{ productId: pid, qty: 2 }], payMethod: "cash" });
    const s2 = createSale(db, { userId: uid, lines: [{ productId: pid, qty: 1 }], payMethod: "card" });
    expect([s1.no, s2.no]).toEqual([1, 2]);
    expect(s1.total).toBe(10000);
    expect((db.prepare("SELECT stock FROM products WHERE id=?").get(pid) as any).stock).toBe(7);
    expect(() => db.prepare("DELETE FROM sales WHERE no=1").run()).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE sales SET total=1 WHERE no=1").run()).toThrow(/immutable/);
    const rows = db.prepare("SELECT prev_hash, hash FROM sales ORDER BY no").all() as any[];
    expect(rows[1].prev_hash).toBe(rows[0].hash);
  });
});
