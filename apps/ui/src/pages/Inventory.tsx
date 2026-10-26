import { useCallback, useEffect, useState } from "react";
import type { ExpiringBatch, InventoryProduct } from "@market/core";
import { api, egp, errMsg, num, toPiastres } from "../api";
import { dateLongAr, fromPiastres } from "../fmt";
import { Modal, Toast, useToast } from "../components/ui";

type Tab = "list" | "receive" | "expiry" | "import";

export function Inventory({ canEdit }: { canEdit: boolean }) {
  const [tab, setTab] = useState<Tab>("list");
  return (
    <div className="page-wide">
      <div className="tabs">
        <button className={tab === "list" ? "on" : ""} onClick={() => setTab("list")}>الأصناف</button>
        {canEdit && <button className={tab === "receive" ? "on" : ""} onClick={() => setTab("receive")}>استلام بضاعة</button>}
        {canEdit && <button className={tab === "expiry" ? "on" : ""} onClick={() => setTab("expiry")}>الصلاحية</button>}
        {canEdit && <button className={tab === "import" ? "on" : ""} onClick={() => setTab("import")}>استيراد من Excel</button>}
      </div>
      {tab === "list" && <List canEdit={canEdit} />}
      {tab === "receive" && <Receive />}
      {tab === "expiry" && <Expiry />}
      {tab === "import" && <Import />}
    </div>
  );
}

function List({ canEdit }: { canEdit: boolean }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "low" | "out">("all");
  const [rows, setRows] = useState<InventoryProduct[]>([]);
  const [edit, setEdit] = useState<Partial<InventoryProduct> | null>(null);
  const [count, setCount] = useState<InventoryProduct | null>(null);
  const toast = useToast();
  const load = useCallback(() => api.listProducts(q, filter).then(setRows).catch((e) => toast.fail(errMsg(e))), [q, filter]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <div className="row toolbar">
        <input className="grow" placeholder="ابحث بالاسم أو الباركود" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}><option value="all">كل الأصناف</option><option value="low">ناقص (تحت الحد الأدنى)</option><option value="out">نفد</option></select>
        {canEdit && <button className="primary" onClick={() => setEdit({ name: "", barcode: "", price: 0, cost: 0, minStock: 0, byWeight: false })}>+ صنف جديد</button>}
      </div>
      <table>
        <thead><tr><th>الصنف</th><th>الباركود</th><th>سعر البيع</th><th>سعر الشراء</th><th>المخزون</th><th>الحد الأدنى</th>{canEdit && <th />}</tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td>{p.name}{p.byWeight && <small className="muted"> (بالوزن)</small>}</td><td className="mono">{p.barcode}</td><td>{egp(p.price)}</td><td>{egp(p.cost)}</td>
              <td className={p.stock <= 0 ? "down" : p.minStock > 0 && p.stock <= p.minStock ? "warn" : ""}>{num(p.stock)}</td><td>{num(p.minStock)}</td>
              {canEdit && <td><div className="row"><button onClick={() => setEdit(p)}>تعديل</button><button onClick={() => setCount(p)}>جرد</button></div></td>}
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={7} className="muted">مفيش أصناف. استورد ملف Excel أو ضيف صنف.</td></tr>}
        </tbody>
      </table>
      {edit && <ProductForm initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); toast.ok("اتحفظ ✔"); }} />}
      {count && <CountDialog p={count} onClose={() => setCount(null)} onDone={(d) => { setCount(null); load(); toast.ok(d === 0 ? "الجرد مطابق" : `اتسجّل فرق ${num(d)}`); }} />}
      <Toast msg={toast.msg} />
    </>
  );
}

function ProductForm({ initial, onClose, onSaved }: { initial: Partial<InventoryProduct>; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: initial.name ?? "", barcode: initial.barcode ?? "", price: fromPiastres(initial.price ?? 0), cost: fromPiastres(initial.cost ?? 0), min: String(initial.minStock ?? 0), weight: !!initial.byWeight });
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f, v: string | boolean) => setF({ ...f, [k]: v });
  const save = () => api.saveProduct({ id: initial.id, name: f.name, barcode: f.barcode, price: toPiastres(f.price), cost: toPiastres(f.cost), minStock: parseFloat(f.min) || 0, byWeight: f.weight }).then(onSaved).catch((e) => setErr(errMsg(e)));
  return (
    <Modal title={initial.id ? "تعديل صنف" : "صنف جديد"} onClose={onClose}>
      <label>الاسم<input autoFocus value={f.name} onChange={(e) => set("name", e.target.value)} /></label>
      <label>الباركود (أو رقم PLU للميزان)<input value={f.barcode} onChange={(e) => set("barcode", e.target.value)} /></label>
      <div className="row"><label className="grow">سعر البيع (جنيه)<input type="number" min="0" step="any" value={f.price} onChange={(e) => set("price", e.target.value)} /></label>
        <label className="grow">سعر الشراء<input type="number" min="0" step="any" value={f.cost} onChange={(e) => set("cost", e.target.value)} /></label></div>
      <label>الحد الأدنى للمخزون (للتنبيه)<input type="number" min="0" value={f.min} onChange={(e) => set("min", e.target.value)} /></label>
      <label className="row"><input type="checkbox" checked={f.weight} onChange={(e) => set("weight", e.target.checked)} /> بيتباع بالوزن</label>
      {err && <div className="error">{err}</div>}
      <button className="primary" onClick={save}>حفظ</button>
    </Modal>
  );
}

function CountDialog({ p, onClose, onDone }: { p: InventoryProduct; onClose: () => void; onDone: (delta: number) => void }) {
  const [v, setV] = useState(String(p.stock));
  const [err, setErr] = useState("");
  return (
    <Modal title={`جرد: ${p.name}`} onClose={onClose}>
      <p>المخزون في البرنامج: <b>{num(p.stock)}</b>. اكتب الكمية الفعلية اللي عديتها.</p>
      <label>الكمية الفعلية<input autoFocus type="number" min="0" step="any" value={v} onChange={(e) => setV(e.target.value)} /></label>
      {err && <div className="error">{err}</div>}
      <button className="primary" onClick={() => api.adjustStock(p.id, parseFloat(v) || 0).then(onDone).catch((e) => setErr(errMsg(e)))}>تسجيل الجرد</button>
    </Modal>
  );
}

function Receive() {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<InventoryProduct[]>([]);
  const [sel, setSel] = useState<InventoryProduct | null>(null);
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [expiry, setExpiry] = useState("");
  const toast = useToast();
  useEffect(() => { if (q.trim()) api.listProducts(q, "all").then((r) => setFound(r.slice(0, 8))); else setFound([]); }, [q]);
  const save = () => api.receiveStock({ productId: sel!.id, qty: parseFloat(qty), cost: cost ? toPiastres(cost) : undefined, expiry: expiry ? new Date(expiry + "T23:59:59").getTime() : undefined })
    .then(() => { toast.ok(`اتضاف ${qty} لـ ${sel!.name}`); setSel(null); setQ(""); setQty(""); setCost(""); setExpiry(""); }).catch((e) => toast.fail(errMsg(e)));
  return (
    <div className="card wide">
      <h2>استلام بضاعة</h2>
      <p className="muted">اكتب تاريخ الصلاحية وهيتنبّهك قبل ما الصنف يخلص. البيع بياخد من الأقرب انتهاءً الأول.</p>
      {!sel ? (
        <>
          <label>ابحث عن الصنف<input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="الاسم أو الباركود" /></label>
          <div className="pick">{found.map((p) => <button key={p.id} onClick={() => setSel(p)}>{p.name}<small>مخزون {num(p.stock)}</small></button>)}</div>
        </>
      ) : (
        <>
          <p>الصنف: <b>{sel.name}</b> <button onClick={() => setSel(null)}>تغيير</button></p>
          <div className="row">
            <label className="grow">الكمية<input autoFocus type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
            <label className="grow">سعر الشراء الجديد (اختياري)<input type="number" min="0" step="any" value={cost} onChange={(e) => setCost(e.target.value)} /></label>
            <label className="grow">تاريخ الصلاحية (اختياري)<input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></label>
          </div>
          <button className="primary" disabled={!(parseFloat(qty) > 0)} onClick={save}>إضافة للمخزون</button>
        </>
      )}
      <Toast msg={toast.msg} />
    </div>
  );
}

function Expiry() {
  const [rows, setRows] = useState<ExpiringBatch[]>([]);
  useEffect(() => { api.expiring(60).then(setRows); }, []);
  return (
    <table>
      <thead><tr><th>الصنف</th><th>الكمية</th><th>تاريخ الانتهاء</th><th>الحالة</th></tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}><td>{r.name}</td><td>{num(r.qty)}</td><td>{dateLongAr(r.expiry)}</td>
            <td className={r.daysLeft < 0 ? "down" : r.daysLeft <= 14 ? "warn" : ""}>{r.daysLeft < 0 ? `منتهي من ${num(-r.daysLeft)} يوم` : `باقي ${num(r.daysLeft)} يوم`}</td></tr>
        ))}
        {!rows.length && <tr><td colSpan={4} className="muted">مفيش أصناف انتهت أو هتنتهي خلال 60 يوم.</td></tr>}
      </tbody>
    </table>
  );
}

function Import() {
  const [res, setRes] = useState<{ created: number; updated: number; errors: string[] } | null>(null);
  const [err, setErr] = useState("");
  const pick = async (f?: File) => { if (!f) return; setErr(""); setRes(null); try { setRes(await api.importCsv(await f.text())); } catch (e) { setErr(errMsg(e)); } };
  const template = () => {
    const blob = new Blob(["﻿الباركود,الاسم,السعر,التكلفة,الكمية,الحد الأدنى,تاريخ الصلاحية\n6221234567890,شاي العروسة 40 جم,5.5,4.8,100,20,2027-01-31\n"], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "products-template.csv"; a.click();
  };
  return (
    <div className="card wide">
      <h2>استيراد الأصناف من ملف</h2>
      <p>من Excel: احفظ الملف كـ <b>CSV</b>. الأعمدة المطلوبة: الباركود، الاسم، السعر (بالجنيه). اختياري: التكلفة، الكمية، الحد الأدنى، تاريخ الصلاحية (مثال 2027-01-31). لو الباركود موجود الصنف بيتحدّث والكمية بتتضاف.</p>
      <button onClick={template}>نزّل ملف نموذج</button>
      <label>اختار الملف<input type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} /></label>
      {err && <div className="error">{err}</div>}
      {res && <div className="note">اتضاف {num(res.created)} صنف جديد، واتحدّث {num(res.updated)}.{res.errors.length > 0 && <ul>{res.errors.slice(0, 20).map((x) => <li key={x}>{x}</li>)}</ul>}</div>}
    </div>
  );
}
