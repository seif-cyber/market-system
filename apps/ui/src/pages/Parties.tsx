import { useCallback, useEffect, useState } from "react";
import type { Bootstrap, LedgerEntry, PaySource, Party, PurchaseDetails, PurchaseRow, SupplierLedgerEntry } from "@market/core";
import { api, egp, errMsg, num, toPiastres } from "../api";
import { dateLongAr, dateTimeAr, fromPiastres } from "../fmt";
import { ImportPanel } from "../components/ImportPanel";
import { PartyForm } from "../components/PartyForm";
import { Modal, Toast, useToast } from "../components/ui";

type Type = "all" | "customer" | "supplier";
export const STATUS_AR: Record<PurchaseRow["status"], string> = { paid: "مدفوعة", partial: "جزئي", unpaid: "آجل", overdue: "متأخرة", voided: "ملغية" };
export const SOURCE_LABEL: Record<PaySource, string> = { cash: "الخزنة (كاش)", bank: "البنك", drawer: "الدرج (الوردية المفتوحة)" };

export function Parties({ b }: { b: Bootstrap }) {
  const [type, setType] = useState<Type>("all");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Party[]>([]);
  const [edit, setEdit] = useState<Partial<Party> | null>(null);
  const [sel, setSel] = useState<Party | null>(null);
  const [imp, setImp] = useState(false);
  const toast = useToast();
  const load = useCallback(() => api.listParties({ q, type }).then(setRows).catch((e) => toast.fail(errMsg(e))), [q, type]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const owedToUs = rows.reduce((s, r) => s + Math.max(0, r.receivable), 0), weOwe = rows.reduce((s, r) => s + Math.max(0, r.payable), 0);

  const exportCsv = () => {
    const head = ["الكود", "الاسم", "النوع", "التليفون", "الرقم الضريبي", "العنوان", "الإيميل", "حد الآجل", "عليه لنا", "علينا له"];
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = rows.map((r) => [r.code, r.name, r.isCustomer && r.isSupplier ? "الاتنين" : r.isSupplier ? "مورد" : "عميل", r.phone, r.taxNo, r.address, r.email, r.creditLimit / 100, r.receivable / 100, r.payable / 100].map(esc).join(","));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + [head.map(esc).join(","), ...lines].join("\n")], { type: "text/csv" })); a.download = "parties.csv"; a.click();
  };

  return (
    <div className="page-wide">
      <div className="row toolbar">
        <button onClick={load}>⟳ تحديث</button>
        <button className="primary" onClick={() => setEdit({ isCustomer: type !== "supplier", isSupplier: type === "supplier" })}>+ إضافة</button>
        <button onClick={() => setImp(true)}>⬇ استيراد</button>
        <button onClick={exportCsv}>⬆ تصدير</button>
        <input className="grow" placeholder="ابحث بالاسم أو التليفون أو الكود" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="tabs">{([["all", "الكل"], ["customer", "العملاء"], ["supplier", "الموردين"]] as [Type, string][]).map(([id, l]) => <button key={id} className={type === id ? "on" : ""} onClick={() => setType(id)}>{l}</button>)}</div>
      </div>
      <div className="row toolbar"><div className="pill">عليهم لنا: <b className="warn">{egp(owedToUs)}</b></div><div className="pill">علينا لهم: <b className={weOwe ? "down" : ""}>{egp(weOwe)}</b></div></div>
      <div className="scroll">
        <table>
          <thead><tr><th>الكود</th><th>الاسم</th><th>الرقم الضريبي</th><th>العنوان</th><th>التليفون</th><th>الإيميل</th><th>عميل</th><th>مورد</th><th>عليه لنا</th><th>علينا له</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="click" onClick={() => setSel(r)}>
                <td className="mono">{r.code}</td><td>{r.name}</td><td>{r.taxNo}</td><td>{r.address}</td><td className="mono">{r.phone}</td><td className="mono">{r.email}</td>
                <td>{r.isCustomer ? "✔" : ""}</td><td>{r.isSupplier ? "✔" : ""}</td>
                <td className={r.receivable > 0 ? "warn" : ""}>{r.isCustomer ? egp(r.receivable) : ""}</td><td className={r.payable > 0 ? "down" : ""}>{r.isSupplier ? egp(r.payable) : ""}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={10} className="muted">مفيش نتائج. اضغط «إضافة» أو «استيراد».</td></tr>}
          </tbody>
        </table>
      </div>
      {edit && <PartyForm initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); toast.ok("اتحفظ ✔"); }} />}
      {sel && <PartyDetail b={b} party={sel} onClose={() => { setSel(null); load(); }} onEdit={() => { setEdit(sel); setSel(null); }} />}
      {imp && <Modal title="استيراد عملاء وموردين" onClose={() => { setImp(false); load(); }} wide><ImportPanel kind="parties" onChanged={load} /></Modal>}
      <Toast msg={toast.msg} />
    </div>
  );
}

type DTab = "customer" | "supplier" | "invoices";

function PartyDetail({ b, party, onClose, onEdit }: { b: Bootstrap; party: Party; onClose: () => void; onEdit: () => void }) {
  const [p, setP] = useState(party);
  const [tab, setTab] = useState<DTab>(party.isCustomer ? "customer" : "supplier");
  const toast = useToast();
  const refresh = () => api.listParties({ includeInactive: true }).then((l) => { const f = l.find((x) => x.id === p.id); if (f) setP(f); });
  return (
    <Modal title={p.name} onClose={onClose} wide>
      <div className="row between toolbar">
        <div className="row"><div className="pill">عليه لنا: <b className={p.receivable > 0 ? "warn" : ""}>{egp(p.receivable)}</b></div><div className="pill">علينا له: <b className={p.payable > 0 ? "down" : ""}>{egp(p.payable)}</b></div>
          {p.isCustomer && p.isSupplier && <div className="pill">الصافي: <b>{egp(p.net)}</b></div>}</div>
        <div className="row">
          <button onClick={onEdit}>تعديل البيانات</button>
          <button className="danger" onClick={() => confirm(`إيقاف ${p.name}؟`) && api.setPartyActive(p.id, false).then(onClose).catch((e) => toast.fail(errMsg(e)))}>إيقاف</button>
        </div>
      </div>
      <div className="tabs">
        {p.isCustomer && <button className={tab === "customer" ? "on" : ""} onClick={() => setTab("customer")}>كشف العميل</button>}
        {p.isSupplier && <button className={tab === "supplier" ? "on" : ""} onClick={() => setTab("supplier")}>كشف المورد</button>}
        {p.isSupplier && <button className={tab === "invoices" ? "on" : ""} onClick={() => setTab("invoices")}>فواتير الشراء</button>}
      </div>
      {tab === "customer" && <CustomerTab b={b} p={p} toast={toast} onChanged={refresh} />}
      {tab === "supplier" && <SupplierTab b={b} p={p} toast={toast} onChanged={refresh} />}
      {tab === "invoices" && <InvoicesTab p={p} toast={toast} onChanged={refresh} />}
      <Toast msg={toast.msg} />
    </Modal>
  );
}
type T = ReturnType<typeof useToast>;

function CustomerTab({ p, toast, onChanged }: { b: Bootstrap; p: Party; toast: T; onChanged: () => void }) {
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [amount, setAmount] = useState(""); const [method, setMethod] = useState<"cash" | "card">("cash"); const [limit, setLimit] = useState(fromPiastres(p.creditLimit));
  const load = () => api.customerStatement(p.id).then(setRows);
  useEffect(() => { load(); }, [p.id]); // eslint-disable-line
  const KIND: Record<string, string> = { sale: "بيع آجل", payment: "سداد", adjust: "تسوية" };
  return (
    <>
      {p.receivable > 0 && (
        <div className="row toolbar">
          <input className="grow" type="number" min="0" placeholder="مبلغ السداد (جنيه)" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <select value={method} onChange={(e) => setMethod(e.target.value as "cash" | "card")}><option value="cash">نقدي</option><option value="card">فيزا</option></select>
          <button className="primary" disabled={!(parseFloat(amount) > 0)} onClick={() => api.receivePayment(p.id, toPiastres(amount), method).then(() => { setAmount(""); load(); onChanged(); toast.ok("اتسجّل السداد"); }).catch((e) => toast.fail(errMsg(e)))}>تسجيل سداد</button>
          {p.phone && <button className="wa" onClick={() => api.remindCustomer(p.id).catch((e) => toast.fail(errMsg(e)))}>💬 تذكير واتساب</button>}
        </div>
      )}
      <div className="row toolbar"><label className="grow">حد الآجل (جنيه) — 0 يعني ممنوع<input type="number" min="0" value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
        <button onClick={() => api.setCreditLimit(p.id, toPiastres(limit)).then(() => { toast.ok("اتحفظ"); onChanged(); }).catch((e) => toast.fail(errMsg(e)))}>حفظ الحد</button></div>
      <div className="scroll"><table className="t"><thead><tr><th>التاريخ</th><th>النوع</th><th>المبلغ</th><th>الرصيد</th></tr></thead>
        <tbody>{[...rows].reverse().map((r) => <tr key={r.id}><td>{dateTimeAr(r.createdAt)}</td><td>{KIND[r.kind] ?? r.kind}{r.note ? ` — ${r.note}` : ""}</td><td className={r.delta > 0 ? "warn" : "up"}>{r.delta > 0 ? "+" : "−"}{egp(Math.abs(r.delta))}</td><td>{egp(r.balanceAfter)}</td></tr>)}
          {!rows.length && <tr><td colSpan={4} className="muted">لا توجد حركات</td></tr>}</tbody></table></div>
    </>
  );
}

export function SourceSelect({ b, value, onChange }: { b: Bootstrap; value: PaySource; onChange: (s: PaySource) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as PaySource)}>
      <option value="cash">{SOURCE_LABEL.cash}</option><option value="bank">{SOURCE_LABEL.bank}</option>{b.shift && <option value="drawer">{SOURCE_LABEL.drawer}</option>}
    </select>
  );
}

function SupplierTab({ b, p, toast, onChanged }: { b: Bootstrap; p: Party; toast: T; onChanged: () => void }) {
  const [rows, setRows] = useState<SupplierLedgerEntry[]>([]);
  const [amount, setAmount] = useState(""); const [source, setSource] = useState<PaySource>("cash"); const [opening, setOpening] = useState("");
  const load = () => api.supplierStatement(p.id).then(setRows);
  useEffect(() => { load(); }, [p.id]); // eslint-disable-line
  const KIND: Record<string, string> = { purchase: "فاتورة شراء", payment: "دفعة", void: "إلغاء فاتورة", adjust: "رصيد افتتاحي" };
  const done = (m: string) => { toast.ok(m); setAmount(""); setOpening(""); load(); onChanged(); };
  return (
    <>
      {p.payable > 0 && (
        <div className="row toolbar">
          <input className="grow" type="number" min="0" placeholder={`مبلغ الدفع (المستحق ${egp(p.payable)})`} value={amount} onChange={(e) => setAmount(e.target.value)} />
          <SourceSelect b={b} value={source} onChange={setSource} />
          <button onClick={() => setAmount(String(p.payable / 100))}>الكل</button>
          <button className="primary" disabled={!(parseFloat(amount) > 0)} onClick={() => api.paySupplier(p.id, toPiastres(amount), source).then(() => done("اتسجّلت الدفعة")).catch((e) => toast.fail(errMsg(e)))}>دفع للمورد</button>
        </div>
      )}
      <div className="row toolbar"><input className="grow" type="number" min="0" placeholder="رصيد افتتاحي للمورد (مستحق قبل استخدام البرنامج)" value={opening} onChange={(e) => setOpening(e.target.value)} />
        <button disabled={!(parseFloat(opening) > 0)} onClick={() => api.addSupplierOpening(p.id, toPiastres(opening), "رصيد افتتاحي").then(() => done("اتسجّل الرصيد")).catch((e) => toast.fail(errMsg(e)))}>تسجيل رصيد افتتاحي</button></div>
      <div className="scroll"><table className="t"><thead><tr><th>التاريخ</th><th>البيان</th><th>المبلغ</th><th>الرصيد (علينا)</th></tr></thead>
        <tbody>{[...rows].reverse().map((r) => <tr key={r.id}><td>{dateTimeAr(r.createdAt)}</td><td>{KIND[r.kind] ?? r.kind}{r.supplierRef ? ` ${r.supplierRef}` : ""}{r.note && r.kind !== "adjust" ? ` — ${r.note}` : ""}</td>
          <td className={r.delta > 0 ? "down" : "up"}>{r.delta > 0 ? "+" : "−"}{egp(Math.abs(r.delta))}</td><td>{egp(r.balanceAfter)}</td></tr>)}
          {!rows.length && <tr><td colSpan={4} className="muted">لا توجد حركات</td></tr>}</tbody></table></div>
    </>
  );
}

function InvoicesTab({ p, toast, onChanged }: { p: Party; toast: T; onChanged: () => void }) {
  const [rows, setRows] = useState<PurchaseRow[]>([]);
  const [det, setDet] = useState<PurchaseDetails | null>(null);
  const load = () => api.listPurchases({ supplierId: p.id, range: "all" }).then(setRows);
  useEffect(() => { load(); }, [p.id]); // eslint-disable-line
  return (
    <>
      <div className="scroll"><table className="t"><thead><tr><th>التاريخ</th><th>رقم المورد</th><th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th><th>الاستحقاق</th><th>الحالة</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id} className="click" onClick={() => api.purchaseDetails(r.id).then(setDet)}><td>{dateLongAr(r.invoiceDate)}</td><td>{r.supplierRef}</td><td>{egp(r.total)}</td><td>{egp(r.paid)}</td><td>{egp(r.remaining)}</td>
          <td>{r.dueDate ? dateLongAr(r.dueDate) : "—"}</td><td><span className={`st st-${r.status}`}>{STATUS_AR[r.status]}</span></td></tr>)}
          {!rows.length && <tr><td colSpan={7} className="muted">لا توجد فواتير شراء</td></tr>}</tbody></table></div>
      {det && <PurchaseDetail d={det} onClose={() => setDet(null)} onVoided={() => { setDet(null); load(); onChanged(); toast.ok("اتلغت الفاتورة"); }} />}
    </>
  );
}

export function PurchaseDetail({ d, onClose, onVoided }: { d: PurchaseDetails; onClose: () => void; onVoided: () => void }) {
  const [err, setErr] = useState("");
  const i = d.invoice;
  return (
    <Modal title={`فاتورة شراء ${i.supplierRef || "#" + i.id} — ${i.supplier}`} onClose={onClose} wide>
      <div className="row toolbar"><div className="pill">التاريخ: {dateLongAr(i.invoiceDate)}</div><div className="pill">الإجمالي: <b>{egp(i.total)}</b></div><div className="pill">المدفوع: {egp(i.paid)}</div>
        <div className="pill">المتبقي: <b className={i.remaining ? "down" : ""}>{egp(i.remaining)}</b></div><span className={`st st-${i.status}`}>{STATUS_AR[i.status]}</span></div>
      <table className="t"><thead><tr><th>الصنف</th><th>الكمية</th><th>سعر الشراء</th><th>الإجمالي</th><th>الصلاحية</th></tr></thead>
        <tbody>{d.items.map((x, k) => <tr key={k}><td>{x.name}</td><td>{num(x.qty)}</td><td>{egp(x.unitCost)}</td><td>{egp(Math.round(x.qty * x.unitCost))}</td><td>{x.expiry ? dateLongAr(x.expiry) : "—"}</td></tr>)}</tbody></table>
      {i.note && <p className="muted">{i.note}</p>}
      {err && <div className="error">{err}</div>}
      {!i.voided && <button className="danger" onClick={() => confirm("إلغاء الفاتورة؟ المخزون هيتخصم منه، وأي مبلغ اتدفع هيرجع للخزنة.") && api.voidPurchase(i.id).then(onVoided).catch((e) => setErr(errMsg(e)))}>إلغاء الفاتورة</button>}
    </Modal>
  );
}
