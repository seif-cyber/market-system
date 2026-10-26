import { useCallback, useEffect, useRef, useState } from "react";
import type { Approval, Bootstrap, CloseShiftResult, Customer, HeldCart, ProductHit, SaleForReturn, ShiftSummary } from "@market/core";
import { api, egp, errMsg, num, toPiastres } from "../api";
import { dateTimeAr, fromPiastres, PAY_LABEL } from "../fmt";
import { ApprovalFields, Modal, Toast, useToast } from "../components/ui";

interface Line { p: ProductHit; qty: number }
type Dlg = null | "credit" | "discount" | "held" | "return" | "close";

export function Pos({ b, onChange }: { b: Bootstrap; onChange: () => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [code, setCode] = useState("");
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [discount, setDiscount] = useState(0);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [tendered, setTendered] = useState("");
  const [open, setOpen] = useState(fromPiastres(b.handover?.counted ?? 0));
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const locked = b.license.mode === "readonly";
  const subtotal = lines.reduce((s, l) => s + Math.round(l.p.price * l.qty), 0);
  const total = Math.max(0, subtotal - discount);
  const validCart = lines.length > 0 && lines.every((l) => l.qty > 0);
  const change = tendered ? toPiastres(tendered) - total : null;

  const focus = useCallback(() => setTimeout(() => input.current?.focus(), 0), []);
  useEffect(() => { focus(); }, [focus, dlg, b.shift]);

  const add = (p: ProductHit, qty?: number) => {
    const q = qty ?? p.qty ?? 1;
    setLines((ls) => {
      const i = ls.findIndex((l) => l.p.id === p.id);
      return i >= 0 ? ls.map((l, j) => (j === i ? { ...l, qty: Math.round((l.qty + q) * 1000) / 1000 } : l)) : [...ls, { p, qty: q }];
    });
    setHits([]);
  };

  // A USB barcode scanner types the code fast and presses Enter.
  const submit = async () => {
    const c = code.trim(); if (!c) return;
    setCode("");
    try {
      const p = await api.scan(c);
      if (p) return add(p);
      const found = await api.search(c);
      if (found.length === 1) add(found[0]); else if (found.length) setHits(found); else toast.fail(`مفيش صنف بالكود: ${c}`);
    } catch (e) { toast.fail(errMsg(e)); }
    finally { focus(); }
  };

  const reset = () => { setLines([]); setDiscount(0); setApproval(null); setTendered(""); setHits([]); };

  const pay = async (method: "cash" | "card" | "credit", extra: { customerId?: number; paidNow?: number } = {}) => {
    if (!validCart || busy) return;
    setBusy(true);
    try {
      const r = await api.checkout({
        lines: lines.map((l) => ({ productId: l.p.id, qty: l.qty })), payMethod: method, invoiceDiscount: discount || undefined,
        approval: discount ? approval ?? undefined : undefined, ...extra,
      });
      toast.ok(`تمت الفاتورة رقم ${num(r.no)}` + (method === "cash" && change !== null && change >= 0 ? ` — الباقي ${egp(change)}` : ""));
      reset(); setDlg(null);
      api.print(r.receiptHtml).catch((e) => toast.fail(`الفاتورة اتحفظت لكن الطباعة فشلت: ${errMsg(e)}`));
    } catch (e) { toast.fail(errMsg(e)); }
    finally { setBusy(false); focus(); }
  };

  const hold = async () => {
    if (!lines.length) return;
    try { await api.holdCart(`${lines.length} صنف — ${egp(total)}`, JSON.stringify(lines)); reset(); toast.ok("اتعلّقت الفاتورة"); } catch (e) { toast.fail(errMsg(e)); }
    focus();
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (dlg || !b.shift) return;
      const m: Record<string, () => void> = { F2: () => pay("cash"), F3: () => pay("card"), F4: () => lines.length && setDlg("credit"), F6: hold, F7: () => setDlg("held"), F9: () => setDlg("return") };
      if (m[e.key]) { e.preventDefault(); m[e.key](); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  if (!b.shift) {
    const h = b.handover;
    const mismatch = h ? toPiastres(open) - h.counted : 0;
    return (
      <div className="center-box">
        <div className="card">
          <h2>استلام الدرج وفتح الوردية</h2>
          {h ? (
            <p>الكاشير السابق (<b>{h.cashier}</b>) سلّم الدرج بـ <b>{egp(h.counted)}</b> جنيه. عدّ الفلوس اللي قدامك وتأكد إنها بنفس المبلغ.</p>
          ) : <p>اكتب المبلغ اللي في الدرج دلوقتي (رصيد الافتتاح).</p>}
          <label>المبلغ اللي استلمته في الدرج (جنيه)<input type="number" min="0" value={open} onChange={(e) => setOpen(e.target.value)} autoFocus /></label>
          {h && mismatch !== 0 && <div className="error">المبلغ مختلف عن اللي اتسلّم بـ {egp(Math.abs(mismatch))} ({mismatch < 0 ? "أقل" : "أكتر"}). الاختلاف هيتسجّل ويظهر للمدير.</div>}
          <button className="primary big" onClick={() => api.openShift(toPiastres(open)).then(onChange).catch((e) => toast.fail(errMsg(e)))}>استلمت الدرج وفتح الوردية</button>
          <Toast msg={toast.msg} />
        </div>
      </div>
    );
  }

  return (
    <div className="pos">
      <section>
        <input ref={input} className="scan" placeholder="امسح الباركود أو اكتب اسم الصنف ثم Enter" value={code} aria-label="الباركود"
          onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} disabled={locked} />
        {hits.length > 0 && <div className="hits">{hits.map((h) => <button key={h.id} onClick={() => { add(h); focus(); }}>{h.name} — {egp(h.price)}</button>)}</div>}
        {lines.length === 0 ? (
          <div className="empty"><b>الفاتورة فاضية</b><span>امسح باركود أول صنف للبدء</span><small>اختصارات: F2 نقدي • F3 فيزا • F4 آجل • F6 تعليق • F7 المعلّقة • F9 مرتجع</small></div>
        ) : (
          <table>
            <thead><tr><th>الصنف</th><th>السعر</th><th>الكمية</th><th>الإجمالي</th><th /></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.p.id}>
                  <td>{l.p.name}</td><td>{egp(l.p.price)}</td>
                  <td><input className="qty" type="number" min="0.001" step="any" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: +e.target.value || 0 } : x)))} /></td>
                  <td>{egp(Math.round(l.p.price * l.qty))}</td>
                  <td><button onClick={() => { setLines(lines.filter((_, j) => j !== i)); focus(); }} aria-label="حذف">✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <aside>
        <div className="total">
          <div className="row between"><span>الإجمالي</span><span>{egp(subtotal)}</span></div>
          {discount > 0 && <div className="row between down"><span>خصم</span><span>− {egp(discount)}</span></div>}
          <div className="row between big-total"><span>المطلوب</span><b>{egp(total)}</b></div>
          <label className="mini">المبلغ المدفوع (للباقي)<input type="number" min="0" value={tendered} onChange={(e) => setTendered(e.target.value)} /></label>
          {change !== null && <div className={change >= 0 ? "up" : "down"}>{change >= 0 ? `الباقي: ${egp(change)}` : `ناقص: ${egp(-change)}`}</div>}
        </div>
        <button className="primary big" disabled={!validCart || busy || locked} onClick={() => pay("cash")}>نقدي <kbd>F2</kbd></button>
        <button className="big" disabled={!validCart || busy || locked} onClick={() => pay("card")}>فيزا <kbd>F3</kbd></button>
        <button className="big" disabled={!validCart || busy || locked} onClick={() => setDlg("credit")}>آجل <kbd>F4</kbd></button>
        <div className="row two">
          <button disabled={!lines.length} onClick={() => setDlg("discount")}>خصم</button>
          <button disabled={!lines.length} onClick={hold}>تعليق <kbd>F6</kbd></button>
          <button onClick={() => setDlg("held")}>المعلّقة <kbd>F7</kbd></button>
          <button onClick={() => setDlg("return")}>مرتجع <kbd>F9</kbd></button>
        </div>
        <button disabled={!lines.length} onClick={() => { reset(); focus(); }}>إلغاء الفاتورة</button>
        <button className="ghost" onClick={() => setDlg("close")}>إقفال الوردية</button>
      </aside>

      {dlg === "credit" && <CreditDialog total={total} onClose={() => setDlg(null)} onPay={(customerId, paidNow) => pay("credit", { customerId, paidNow })} />}
      {dlg === "discount" && <DiscountDialog b={b} subtotal={subtotal} onClose={() => setDlg(null)} onApply={(d, a) => { setDiscount(d); setApproval(a); setDlg(null); }} />}
      {dlg === "held" && <HeldDialog onClose={() => setDlg(null)} onResume={(data) => { try { setLines(JSON.parse(data)); } catch { toast.fail("تعذّر استرجاع الفاتورة"); } setDlg(null); }} />}
      {dlg === "return" && <ReturnDialog b={b} onClose={() => setDlg(null)} />}
      {dlg === "close" && <CloseShiftDialog onClose={() => setDlg(null)} onDone={onChange} />}
      <Toast msg={toast.msg} />
    </div>
  );
}

function CreditDialog({ total, onClose, onPay }: { total: number; onClose: () => void; onPay: (customerId: number, paidNow: number) => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<Customer[]>([]);
  const [sel, setSel] = useState<Customer | null>(null);
  const [paid, setPaid] = useState("0");
  useEffect(() => { api.listCustomers(q).then(setList).catch(() => {}); }, [q]);
  const owes = total - toPiastres(paid);
  return (
    <Modal title="بيع آجل" onClose={onClose}>
      <label>ابحث عن العميل<input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="الاسم أو التليفون" /></label>
      <div className="pick">{list.map((c) => (
        <button key={c.id} className={sel?.id === c.id ? "on" : ""} onClick={() => setSel(c)}>
          {c.name}<small>مديونية {egp(c.balance)} • الحد {c.creditLimit ? egp(c.creditLimit) : "ممنوع الآجل"}</small>
        </button>))}
        {!list.length && <p className="muted">مفيش عملاء. المدير يضيفهم من صفحة العملاء.</p>}
      </div>
      <label>المدفوع دلوقتي (جنيه)<input type="number" min="0" value={paid} onChange={(e) => setPaid(e.target.value)} /></label>
      <p>هيتسجّل على العميل: <b>{egp(Math.max(0, owes))}</b></p>
      <button className="primary" disabled={!sel} onClick={() => onPay(sel!.id, toPiastres(paid))}>تأكيد البيع الآجل</button>
    </Modal>
  );
}

function DiscountDialog({ b, subtotal, onClose, onApply }: { b: Bootstrap; subtotal: number; onClose: () => void; onApply: (d: number, a: Approval | null) => void }) {
  const [v, setV] = useState("");
  const [a, setA] = useState<Approval | null>(null);
  const d = toPiastres(v);
  return (
    <Modal title="خصم على الفاتورة" onClose={onClose}>
      <label>قيمة الخصم (جنيه)<input autoFocus type="number" min="0" value={v} onChange={(e) => setV(e.target.value)} /></label>
      {d > subtotal && <div className="error">الخصم أكبر من الفاتورة</div>}
      <ApprovalFields b={b} value={a} onChange={setA} />
      <button className="primary" disabled={d <= 0 || d > subtotal || (b.user?.role === "cashier" && !a?.pin)} onClick={() => onApply(d, a)}>تطبيق الخصم</button>
    </Modal>
  );
}

function HeldDialog({ onClose, onResume }: { onClose: () => void; onResume: (data: string) => void }) {
  const [list, setList] = useState<HeldCart[]>([]);
  const load = () => api.listHeld().then(setList);
  useEffect(() => { load(); }, []);
  return (
    <Modal title="الفواتير المعلّقة" onClose={onClose}>
      {!list.length && <p className="muted">مفيش فواتير معلّقة.</p>}
      {list.map((h) => (
        <div key={h.id} className="row between item">
          <div>{h.label}<small className="muted"> • {dateTimeAr(h.createdAt)}</small></div>
          <div className="row"><button className="primary" onClick={() => api.resumeHeld(h.id).then(onResume)}>استرجاع</button><button onClick={() => api.deleteHeld(h.id).then(load)}>حذف</button></div>
        </div>
      ))}
    </Modal>
  );
}

function ReturnDialog({ b, onClose }: { b: Bootstrap; onClose: () => void }) {
  const [no, setNo] = useState("");
  const [sale, setSale] = useState<SaleForReturn | null>(null);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [method, setMethod] = useState<"cash" | "card">("cash");
  const [reason, setReason] = useState("");
  const [a, setA] = useState<Approval | null>(null);
  const [msg, setMsg] = useState("");
  const [done, setDone] = useState("");
  const find = () => api.findSale(+no).then((s) => { setSale(s); setQty({}); setMsg(s ? "" : "الفاتورة مش موجودة"); }).catch((e) => setMsg(errMsg(e)));
  const lines = sale ? sale.items.map((i) => ({ saleItemId: i.id, qty: parseFloat(qty[i.id] || "0") })).filter((l) => l.qty > 0) : [];
  const submit = () => api.createReturn({ saleNo: sale!.no, lines, refundMethod: method, reason, approval: a ?? undefined })
    .then((r) => setDone(`تم المرتجع: ${egp(r.total)} (${r.method === "credit" ? "خصم من مديونية العميل" : PAY_LABEL[r.method]})`)).catch((e) => setMsg(errMsg(e)));
  return (
    <Modal title="مرتجع" onClose={onClose} wide>
      {done ? <><div className="note">{done}</div><button className="primary" onClick={onClose}>تمام</button></> : (
        <>
          <div className="row"><label className="grow">رقم الفاتورة<input autoFocus type="number" value={no} onChange={(e) => setNo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && find()} /></label><button onClick={find}>بحث</button></div>
          {msg && <div className="error">{msg}</div>}
          {sale && (
            <>
              <p>فاتورة {num(sale.no)} — {dateTimeAr(sale.createdAt)} — {egp(sale.total)} ({PAY_LABEL[sale.payMethod] ?? sale.payMethod}{sale.customerName ? ` • ${sale.customerName}` : ""})</p>
              <table><thead><tr><th>الصنف</th><th>اتباع</th><th>اترجع</th><th>كمية المرتجع</th></tr></thead><tbody>
                {sale.items.map((i) => (<tr key={i.id}><td>{i.name}</td><td>{num(i.qty)}</td><td>{num(i.returned)}</td>
                  <td><input className="qty" type="number" min="0" max={i.qty - i.returned} step="any" disabled={i.qty - i.returned <= 0} value={qty[i.id] ?? ""} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} /></td></tr>))}
              </tbody></table>
              {sale.payMethod !== "credit" && <label>الفلوس ترجع إزاي<select value={method} onChange={(e) => setMethod(e.target.value as "cash" | "card")}><option value="cash">نقدي من الدرج</option><option value="card">على الفيزا</option></select></label>}
              <label>السبب<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
              <ApprovalFields b={b} value={a} onChange={setA} />
              <button className="primary" disabled={!lines.length || (b.user?.role === "cashier" && !a?.pin)} onClick={submit}>تنفيذ المرتجع</button>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function SummaryTable({ s }: { s: ShiftSummary }) {
  return (
    <table className="t"><tbody>
      <tr><td>استلمت الدرج بـ</td><td>{egp(s.openingCash)}</td></tr>
      <tr><td>عدد الفواتير</td><td>{num(s.invoices)}</td></tr>
      <tr><td>إجمالي ما بعته</td><td><b>{egp(s.totalSales)}</b></td></tr>
      <tr><td>— نقدي (دخل الدرج)</td><td>{egp(s.cashSales)}</td></tr>
      <tr><td>— فيزا</td><td>{egp(s.cardSales)}</td></tr>
      <tr><td>— آجل</td><td>{egp(s.creditSales)}</td></tr>
      {s.debtPayments > 0 && <tr><td>تحصيل ديون نقدي</td><td>{egp(s.debtPayments)}</td></tr>}
      {s.cashReturns > 0 && <tr><td>مرتجع دفعته نقدي</td><td>− {egp(s.cashReturns)}</td></tr>}
      <tr className="sum"><td>المفروض يكون في الدرج</td><td><b>{egp(s.expectedCash)}</b></td></tr>
    </tbody></table>
  );
}

function CloseShiftDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [counted, setCounted] = useState("");
  const [live, setLive] = useState<ShiftSummary | null>(null);
  const [res, setRes] = useState<CloseShiftResult | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.shiftReport().then((r) => setLive(r?.summary ?? null)).catch((e) => setErr(errMsg(e))); }, []);
  const close = () => api.closeShift(toPiastres(counted)).then((r) => { setRes(r); api.print(r.reportHtml).catch(() => {}); }).catch((e) => setErr(errMsg(e)));
  const done = () => { onDone(); onClose(); };
  if (res)
    return (
      <Modal title="تم تسليم الوردية" onClose={done}>
        <SummaryTable s={res.summary} />
        <table className="t"><tbody><tr><td>اللي عديته في الدرج</td><td><b>{egp(res.counted)}</b></td></tr></tbody></table>
        <div className={res.difference === 0 ? "note up" : "error"}>{res.difference === 0 ? "الدرج مظبوط ✔" : res.difference > 0 ? `زيادة ${egp(res.difference)}` : `عجز ${egp(-res.difference)}`}</div>
        <p className="muted">اتطبع تقرير التسليم. سلّم الدرج والتقرير للمدير أو الكاشير اللي بعدك.</p>
        <button className="primary" onClick={done}>تمام</button>
      </Modal>
    );
  return (
    <Modal title="تسليم الوردية" onClose={onClose}>
      {live && <SummaryTable s={live} />}
      <p>عدّ الفلوس اللي في الدرج واكتب المبلغ. البرنامج هيقارنه بالمبيعات ويطبع تقرير التسليم.</p>
      <label>المبلغ اللي عديته في الدرج (جنيه)<input autoFocus type="number" min="0" value={counted} onChange={(e) => setCounted(e.target.value)} /></label>
      {err && <div className="error">{err}</div>}
      <button className="primary" disabled={counted === ""} onClick={close}>تسليم الوردية وطباعة التقرير</button>
    </Modal>
  );
}
