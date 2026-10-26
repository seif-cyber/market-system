import { useCallback, useEffect, useState } from "react";
import type { Customer, LedgerEntry } from "@market/core";
import { api, egp, errMsg, num, toPiastres } from "../api";
import { dateTimeAr, fromPiastres } from "../fmt";
import { Modal, Toast, useToast } from "../components/ui";

export function Customers({ canManage }: { canManage: boolean }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Customer[]>([]);
  const [add, setAdd] = useState(false);
  const [sel, setSel] = useState<Customer | null>(null);
  const toast = useToast();
  const load = useCallback(() => api.listCustomers(q).then(setRows).catch((e) => toast.fail(errMsg(e))), [q]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const debts = rows.reduce((s, c) => s + Math.max(0, c.balance), 0);
  return (
    <div className="page-wide">
      <div className="row toolbar">
        <input className="grow" placeholder="ابحث بالاسم أو التليفون" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="pill">إجمالي الديون: <b>{egp(debts)}</b></div>
        {canManage && <button className="primary" onClick={() => setAdd(true)}>+ عميل جديد</button>}
      </div>
      <table>
        <thead><tr><th>العميل</th><th>التليفون</th><th>حد الآجل</th><th>المديونية</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="click" onClick={() => setSel(c)}>
              <td>{c.name}</td><td className="mono">{c.phone}</td><td>{c.creditLimit ? egp(c.creditLimit) : <span className="muted">ممنوع</span>}</td>
              <td className={c.balance > 0 ? "warn" : ""}>{egp(c.balance)}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={4} className="muted">مفيش عملاء لسه.</td></tr>}
        </tbody>
      </table>
      {add && <AddCustomer onClose={() => setAdd(false)} onSaved={() => { setAdd(false); load(); toast.ok("اتضاف العميل"); }} />}
      {sel && <Statement c={sel} canManage={canManage} onClose={() => { setSel(null); load(); }} />}
      <Toast msg={toast.msg} />
    </div>
  );
}

function AddCustomer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(""); const [phone, setPhone] = useState(""); const [limit, setLimit] = useState("0"); const [err, setErr] = useState("");
  return (
    <Modal title="عميل جديد" onClose={onClose}>
      <label>الاسم<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>التليفون<input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
      <label>حد الآجل (جنيه) — 0 يعني ممنوع الآجل<input type="number" min="0" value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
      {err && <div className="error">{err}</div>}
      <button className="primary" onClick={() => api.addCustomer(name, phone, toPiastres(limit)).then(onSaved).catch((e) => setErr(errMsg(e)))}>حفظ</button>
    </Modal>
  );
}

function Statement({ c, canManage, onClose }: { c: Customer; canManage: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [bal, setBal] = useState(c.balance);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "card">("cash");
  const [limit, setLimit] = useState(fromPiastres(c.creditLimit));
  const toast = useToast();
  const load = () => api.customerStatement(c.id).then((r) => { setRows(r); setBal(r.at(-1)?.balanceAfter ?? 0); });
  useEffect(() => { load(); }, []); // eslint-disable-line
  const KIND: Record<string, string> = { sale: "بيع آجل", payment: "سداد", adjust: "تسوية" };
  return (
    <Modal title={`كشف حساب: ${c.name}`} onClose={onClose} wide>
      <div className="row between"><div className="pill">المديونية: <b className={bal > 0 ? "warn" : ""}>{egp(bal)}</b></div>
        {bal > 0 && c.phone && <button className="wa" onClick={() => api.remindCustomer(c.id).catch((e) => toast.fail(errMsg(e)))}>💬 تذكير واتساب</button>}</div>
      {bal > 0 && (
        <div className="row toolbar">
          <input className="grow" type="number" min="0" placeholder="مبلغ السداد (جنيه)" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <select value={method} onChange={(e) => setMethod(e.target.value as "cash" | "card")}><option value="cash">نقدي</option><option value="card">فيزا</option></select>
          <button className="primary" disabled={!(parseFloat(amount) > 0)} onClick={() => api.receivePayment(c.id, toPiastres(amount), method).then(() => { setAmount(""); load(); toast.ok("اتسجّل السداد"); }).catch((e) => toast.fail(errMsg(e)))}>تسجيل سداد</button>
        </div>
      )}
      {canManage && <div className="row toolbar"><label className="grow">حد الآجل (جنيه)<input type="number" min="0" value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
        <button onClick={() => api.setCreditLimit(c.id, toPiastres(limit)).then(() => toast.ok("اتحفظ")).catch((e) => toast.fail(errMsg(e)))}>حفظ الحد</button></div>}
      <table className="t"><thead><tr><th>التاريخ</th><th>النوع</th><th>المبلغ</th><th>الرصيد</th></tr></thead>
        <tbody>{[...rows].reverse().map((r) => <tr key={r.id}><td>{dateTimeAr(r.createdAt)}</td><td>{KIND[r.kind] ?? r.kind}{r.note ? ` — ${r.note}` : ""}</td><td className={r.delta > 0 ? "warn" : "up"}>{r.delta > 0 ? "+" : "−"}{egp(Math.abs(r.delta))}</td><td>{egp(r.balanceAfter)}</td></tr>)}
          {!rows.length && <tr><td colSpan={4} className="muted">لا توجد حركات</td></tr>}</tbody></table>
      <p className="muted">{num(rows.length)} حركة</p>
      <Toast msg={toast.msg} />
    </Modal>
  );
}
