import { useCallback, useEffect, useState } from "react";
import type { Bootstrap, InventoryProduct, PaySource, Party, PurchaseDetails, PurchaseRow, RangePreset, SupplierDue } from "@market/core";
import { api, egp, errMsg, num, toPiastres } from "../api";
import { dateLongAr, fromPiastres } from "../fmt";
import { RANGES } from "../components/DashboardView";
import { PartyForm } from "../components/PartyForm";
import { Modal, Toast, useToast } from "../components/ui";
import { PurchaseDetail, SourceSelect, STATUS_AR } from "./Parties";

const dayMs = (v: string) => new Date(v + "T12:00:00").getTime();
const today = () => new Date().toISOString().slice(0, 10);

export function Purchases({ b }: { b: Bootstrap }) {
  const [range, setRange] = useState<RangePreset | "all">("30d");
  const [supplier, setSupplier] = useState(0);
  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [rows, setRows] = useState<PurchaseRow[]>([]);
  const [dues, setDues] = useState<SupplierDue[]>([]);
  const [form, setForm] = useState(false);
  const [det, setDet] = useState<PurchaseDetails | null>(null);
  const toast = useToast();
  const load = useCallback(() => {
    api.listParties({ type: "supplier" }).then(setSuppliers);
    api.supplierDues().then(setDues);
    api.listPurchases({ supplierId: supplier || undefined, range }).then(setRows).catch((e) => toast.fail(errMsg(e)));
  }, [range, supplier]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const owed = dues.reduce((s, d) => s + d.balance, 0), overdue = dues.reduce((s, d) => s + d.overdue, 0);

  return (
    <div className="page-wide">
      <div className="kpis">
        <div className="kpi"><span>علينا للموردين</span><b>{egp(owed)}</b><small>{num(dues.length)} مورد</small></div>
        <div className={`kpi ${overdue ? "bad" : ""}`}><span>متأخر عن الاستحقاق</span><b>{egp(overdue)}</b></div>
        <div className="kpi"><span>أقرب استحقاق</span><b>{(() => { const n = dues.map((d) => d.nextDue).filter(Boolean).sort()[0]; return n ? dateLongAr(n as number) : "—"; })()}</b></div>
      </div>
      {dues.length > 0 && (
        <div className="panel"><h3>مستحقات الموردين</h3>
          <ul className="list">{dues.slice(0, 6).map((d) => <li key={d.id}>{d.name}<span className="muted">{d.overdue > 0 ? `متأخر ${egp(d.overdue)}` : d.nextDue ? `يستحق ${dateLongAr(d.nextDue)}` : ""}</span><b>{egp(d.balance)}</b></li>)}</ul>
        </div>
      )}
      <div className="row toolbar">
        <button className="primary" onClick={() => setForm(true)}>+ فاتورة شراء جديدة</button>
        <div className="tabs">{[...RANGES, { id: "all" as const, label: "الكل" }].map((r) => <button key={r.id} className={range === r.id ? "on" : ""} onClick={() => setRange(r.id as RangePreset | "all")}>{r.label}</button>)}</div>
        <select value={supplier} onChange={(e) => setSupplier(+e.target.value)}><option value={0}>كل الموردين</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      </div>
      <div className="scroll"><table>
        <thead><tr><th>التاريخ</th><th>المورد</th><th>رقم فاتورة المورد</th><th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th><th>الاستحقاق</th><th>الحالة</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="click" onClick={() => api.purchaseDetails(r.id).then(setDet)}>
              <td>{dateLongAr(r.invoiceDate)}</td><td>{r.supplier}</td><td>{r.supplierRef}</td><td>{egp(r.total)}</td><td>{egp(r.paid)}</td><td className={r.remaining ? "down" : ""}>{egp(r.remaining)}</td>
              <td>{r.dueDate ? dateLongAr(r.dueDate) : "—"}</td><td><span className={`st st-${r.status}`}>{STATUS_AR[r.status]}</span></td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={8} className="muted">لا توجد فواتير شراء في الفترة دي.</td></tr>}
        </tbody>
      </table></div>
      {form && <PurchaseForm b={b} onClose={() => setForm(false)} onSaved={() => { setForm(false); load(); toast.ok("اتسجّلت فاتورة الشراء وزاد المخزون"); }} />}
      {det && <PurchaseDetail d={det} onClose={() => setDet(null)} onVoided={() => { setDet(null); load(); toast.ok("اتلغت الفاتورة"); }} />}
      <Toast msg={toast.msg} />
    </div>
  );
}

interface Line { p: InventoryProduct; qty: string; cost: string; expiry: string }

function PurchaseForm({ b, onClose, onSaved }: { b: Bootstrap; onClose: () => void; onSaved: () => void }) {
  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [supplierId, setSupplierId] = useState(0);
  const [ref, setRef] = useState(""); const [date, setDate] = useState(today()); const [due, setDue] = useState(""); const [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [q, setQ] = useState(""); const [found, setFound] = useState<InventoryProduct[]>([]);
  const [paid, setPaid] = useState("0"); const [source, setSource] = useState<PaySource>("cash");
  const [newParty, setNewParty] = useState(false); const [newProduct, setNewProduct] = useState(false);
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const loadSuppliers = () => api.listParties({ type: "supplier" }).then(setSuppliers);
  useEffect(() => { loadSuppliers(); }, []);
  useEffect(() => { if (q.trim()) api.listProducts(q, "all").then((r) => setFound(r.slice(0, 8))); else setFound([]); }, [q]);

  const total = lines.reduce((s, l) => s + Math.round((parseFloat(l.qty) || 0) * toPiastres(l.cost)), 0);
  const paidP = toPiastres(paid);
  const remaining = total - paidP;
  const add = (p: InventoryProduct) => { setLines((ls) => (ls.some((l) => l.p.id === p.id) ? ls : [...ls, { p, qty: "1", cost: fromPiastres(p.cost), expiry: "" }])); setQ(""); setFound([]); };
  const upd = (i: number, patch: Partial<Line>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  const save = () => {
    setBusy(true); setErr("");
    api.createPurchase({
      supplierId, supplierRef: ref, invoiceDate: dayMs(date), dueDate: due && remaining > 0 ? dayMs(due) : null, note,
      items: lines.map((l) => ({ productId: l.p.id, qty: parseFloat(l.qty), unitCost: toPiastres(l.cost), expiry: l.expiry ? dayMs(l.expiry) : undefined })),
      paid: paidP > 0 ? { amount: paidP, source } : undefined,
    }).then(onSaved).catch((e) => setErr(errMsg(e))).finally(() => setBusy(false));
  };
  const valid = supplierId > 0 && lines.length > 0 && lines.every((l) => parseFloat(l.qty) > 0 && toPiastres(l.cost) >= 0) && paidP >= 0 && paidP <= total;

  return (
    <Modal title="فاتورة شراء جديدة" onClose={onClose} wide>
      <div className="grid-form">
        <label>المورد
          <div className="row"><select className="grow" value={supplierId} onChange={(e) => setSupplierId(+e.target.value)}><option value={0}>— اختار المورد —</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            <button onClick={() => setNewParty(true)}>+ مورد</button></div></label>
        <label>رقم فاتورة المورد<input value={ref} onChange={(e) => setRef(e.target.value)} /></label>
        <label>تاريخ الفاتورة<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      </div>

      <label>ضيف صنف (الباركود أو الاسم)
        <div className="row"><input className="grow" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && found.length === 1) add(found[0]); }} placeholder="امسح الباركود أو اكتب الاسم" />
          <button onClick={() => setNewProduct(true)}>+ صنف جديد</button></div></label>
      {found.length > 0 && <div className="pick">{found.map((p) => <button key={p.id} onClick={() => add(p)}>{p.name}<small>مخزون {num(p.stock)} • آخر سعر شراء {egp(p.cost)}</small></button>)}</div>}

      <div className="scroll"><table className="t">
        <thead><tr><th>الصنف</th><th>الكمية</th><th>سعر الشراء (جنيه)</th><th>تاريخ الصلاحية</th><th>الإجمالي</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.p.id}><td>{l.p.name}</td>
              <td><input className="qty" type="number" min="0" step="any" value={l.qty} onChange={(e) => upd(i, { qty: e.target.value })} /></td>
              <td><input className="qty" type="number" min="0" step="any" value={l.cost} onChange={(e) => upd(i, { cost: e.target.value })} /></td>
              <td><input type="date" value={l.expiry} onChange={(e) => upd(i, { expiry: e.target.value })} /></td>
              <td>{egp(Math.round((parseFloat(l.qty) || 0) * toPiastres(l.cost)))}</td>
              <td><button onClick={() => setLines(lines.filter((_, k) => k !== i))}>✕</button></td></tr>
          ))}
          {!lines.length && <tr><td colSpan={6} className="muted">لسه مفيش أصناف.</td></tr>}
        </tbody>
      </table></div>

      <div className="panel">
        <div className="row between"><b>إجمالي الفاتورة</b><b className="big-num">{egp(total)}</b></div>
        <div className="row toolbar">
          <label className="grow">المدفوع دلوقتي (جنيه)<input type="number" min="0" value={paid} onChange={(e) => setPaid(e.target.value)} /></label>
          <button onClick={() => setPaid(String(total / 100))}>دفع كامل</button><button onClick={() => setPaid("0")}>آجل بالكامل</button>
          {paidP > 0 && <label>من فين<SourceSelect b={b} value={source} onChange={setSource} /></label>}
        </div>
        {paidP > total && <div className="error">المدفوع أكبر من إجمالي الفاتورة.</div>}
        {remaining > 0 && (
          <div className="row toolbar"><div className="pill">هيتسجّل علينا للمورد: <b className="down">{egp(remaining)}</b></div>
            <label className="grow">تاريخ الاستحقاق<input type="date" value={due} min={date} onChange={(e) => setDue(e.target.value)} /></label></div>
        )}
        {paidP > 0 && <p className="muted">المبلغ المدفوع هيتخصم من {source === "bank" ? "رصيد البنك" : source === "drawer" ? "الدرج (وبيتحسب على الوردية)" : "الكاش في الخزنة"}.</p>}
      </div>
      <label>ملاحظات<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {err && <div className="error">{err}</div>}
      <button className="primary" disabled={!valid || busy} onClick={save}>حفظ الفاتورة وإضافة للمخزون</button>

      {newParty && <PartyForm initial={{ isCustomer: false, isSupplier: true }} onClose={() => setNewParty(false)} onSaved={(id) => { setNewParty(false); loadSuppliers().then(() => setSupplierId(id)); }} />}
      {newProduct && <QuickProduct onClose={() => setNewProduct(false)} onSaved={(p) => { setNewProduct(false); add(p); }} />}
    </Modal>
  );
}

function QuickProduct({ onClose, onSaved }: { onClose: () => void; onSaved: (p: InventoryProduct) => void }) {
  const [name, setName] = useState(""); const [barcode, setBarcode] = useState(""); const [price, setPrice] = useState(""); const [err, setErr] = useState("");
  const save = () => api.saveProduct({ name, barcode, price: toPiastres(price), cost: 0, minStock: 0, byWeight: false })
    .then((id) => api.listProducts(name, "all").then((r) => { const p = r.find((x) => x.id === id); if (p) onSaved(p); })).catch((e) => setErr(errMsg(e)));
  return (
    <Modal title="صنف جديد" onClose={onClose}>
      <label>الاسم<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>الباركود<input value={barcode} onChange={(e) => setBarcode(e.target.value)} /></label>
      <label>سعر البيع (جنيه)<input type="number" min="0" step="any" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
      {err && <div className="error">{err}</div>}
      <button className="primary" disabled={!name.trim() || !(parseFloat(price) > 0)} onClick={save}>حفظ وإضافته للفاتورة</button>
    </Modal>
  );
}
