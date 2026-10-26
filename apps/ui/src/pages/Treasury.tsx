import { useCallback, useEffect, useState } from "react";
import type { Account, RangePreset, TreasuryEntry, TreasurySnapshot } from "@market/core";
import { api, egp, errMsg, num, toPiastres } from "../api";
import { dateTimeAr } from "../fmt";
import { Modal, Toast, useToast } from "../components/ui";

const KIND: Record<string, string> = {
  sale: "بيع", sale_return: "مرتجع", customer_payment: "سداد عميل", expense: "مصروف", expense_void: "إلغاء مصروف",
  deposit: "إيداع", withdrawal: "سحب", transfer: "تحويل", count_adjust: "جرد", shift_diff: "فرق وردية",
  handover_adjust: "تعديل استلام الدرج", supplier_payment: "دفع مورد",
};
const ACC: Record<Account, string> = { cash: "كاش", bank: "بنك / فيزا" };
const RANGES: { id: RangePreset | "all"; label: string }[] = [
  { id: "today", label: "النهارده" }, { id: "7d", label: "7 أيام" }, { id: "30d", label: "30 يوم" }, { id: "month", label: "الشهر" }, { id: "all", label: "الكل" },
];
type Dlg = null | "deposit" | "withdraw" | "transfer" | "count";

export function Treasury() {
  const [snap, setSnap] = useState<TreasurySnapshot | null>(null);
  const [rows, setRows] = useState<TreasuryEntry[]>([]);
  const [account, setAccount] = useState<Account | "">("");
  const [kind, setKind] = useState("");
  const [range, setRange] = useState<RangePreset | "all">("30d");
  const [dlg, setDlg] = useState<Dlg>(null);
  const toast = useToast();

  const load = useCallback(() => {
    api.treasury().then(setSnap).catch((e) => toast.fail(errMsg(e)));
    api.treasuryEntries({ account: account || undefined, kind: kind || undefined, range }).then(setRows).catch((e) => toast.fail(errMsg(e)));
  }, [account, kind, range]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const done = (msg: string) => { setDlg(null); toast.ok(msg); load(); };

  if (!snap) return <div className="muted">...</div>;
  return (
    <div className="page-wide">
      <div className="kpis">
        <div className="kpi"><span>💵 كاش (الخزنة + الدرج)</span><b>{egp(snap.cash)}</b></div>
        <div className="kpi"><span>🏦 بنك / فيزا</span><b>{egp(snap.bank)}</b></div>
        <div className="kpi good"><span>الإجمالي المتاح</span><b>{egp(snap.total)}</b><small>كاش + بنك</small></div>
        <div className="kpi"><span>لينا عند العملاء</span><b>{egp(snap.receivables)}</b><small>ديون آجل</small></div>
        <div className="kpi"><span>علينا للموردين</span><b>{egp(snap.payables)}</b></div>
        <div className="kpi"><span>صافي الموقف</span><b>{egp(snap.net)}</b><small>الإجمالي + ديون العملاء − مستحقات الموردين</small></div>
      </div>

      {snap.check.ok ? (
        <div className="badge ok">✔ الخزنة مطابقة لسجلات المبيعات والمصاريف والورديات ({num(snap.check.checked)} حركة)</div>
      ) : (
        <div className="error" role="alert">
          <b>⚠ فيه فرق بين الخزنة والسجلات:</b>
          <ul>{snap.check.mismatches.map((m, i) => <li key={i}>{KIND[m.kind] ?? m.kind} ({ACC[m.account]}): المفروض {egp(m.expected)} والمسجّل {egp(m.actual)}</li>)}</ul>
        </div>
      )}

      <div className="row toolbar">
        <button className="primary" onClick={() => setDlg("deposit")}>+ إيداع</button>
        <button onClick={() => setDlg("withdraw")}>− سحب</button>
        <button onClick={() => setDlg("transfer")}>⇄ تحويل كاش / بنك</button>
        <button onClick={() => setDlg("count")}>🧮 جرد الخزنة</button>
      </div>

      <div className="row toolbar">
        <div className="tabs">{RANGES.map((r) => <button key={r.id} className={range === r.id ? "on" : ""} onClick={() => setRange(r.id)}>{r.label}</button>)}</div>
        <select value={account} onChange={(e) => setAccount(e.target.value as Account | "")}><option value="">كل الحسابات</option><option value="cash">كاش</option><option value="bank">بنك / فيزا</option></select>
        <select value={kind} onChange={(e) => setKind(e.target.value)}><option value="">كل الأنواع</option>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </div>

      <div className="scroll">
        <table>
          <thead><tr><th>التاريخ</th><th>الحساب</th><th>النوع</th><th>البيان</th><th>داخل</th><th>خارج</th><th>الرصيد بعده</th><th>سجّله</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{dateTimeAr(r.createdAt)}</td><td>{ACC[r.account]}</td>
                <td>{KIND[r.kind] ?? r.kind}{r.inDrawer && <small className="muted"> (درج)</small>}</td>
                <td>{r.note}{r.approvedByName && <small className="muted"> — اعتمده {r.approvedByName}</small>}</td>
                <td className="up">{r.delta > 0 ? egp(r.delta) : ""}</td><td className="down">{r.delta < 0 ? egp(-r.delta) : ""}</td>
                <td className={r.balanceAfter < 0 ? "down" : ""}>{egp(r.balanceAfter)}</td><td>{r.userName}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={8} className="muted">لا توجد حركات في الفترة دي.</td></tr>}
          </tbody>
        </table>
      </div>

      {(dlg === "deposit" || dlg === "withdraw") && <MoveDialog out={dlg === "withdraw"} snap={snap} onClose={() => setDlg(null)} onDone={done} />}
      {dlg === "transfer" && <TransferDialog snap={snap} onClose={() => setDlg(null)} onDone={done} />}
      {dlg === "count" && <CountDialog snap={snap} onClose={() => setDlg(null)} onDone={done} />}
      <Toast msg={toast.msg} />
    </div>
  );
}

function MoveDialog({ out, snap, onClose, onDone }: { out: boolean; snap: TreasurySnapshot; onClose: () => void; onDone: (m: string) => void }) {
  const [account, setAccount] = useState<Account>("cash");
  const [amount, setAmount] = useState(""); const [note, setNote] = useState(""); const [err, setErr] = useState("");
  const amt = toPiastres(amount);
  const after = snap[account] + (out ? -amt : amt);
  const run = () => (out ? api.treasuryWithdraw : api.treasuryDeposit)(account, amt, note).then(() => onDone(out ? "اتسجّل السحب" : "اتسجّل الإيداع")).catch((e) => setErr(errMsg(e)));
  return (
    <Modal title={out ? "سحب من الخزنة" : "إيداع في الخزنة"} onClose={onClose}>
      <p className="muted">{out ? "مسحوبات المالك أو أي مبلغ خرج من الخزنة من غير ما يكون مصروف أو دفعة مورد." : "رأس مال أو أي فلوس دخلت الخزنة من خارج المبيعات."}</p>
      <label>الحساب<select value={account} onChange={(e) => setAccount(e.target.value as Account)}><option value="cash">كاش (الرصيد {egp(snap.cash)})</option><option value="bank">بنك / فيزا (الرصيد {egp(snap.bank)})</option></select></label>
      <label>المبلغ (جنيه)<input autoFocus type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label>البيان<input value={note} onChange={(e) => setNote(e.target.value)} placeholder={out ? "مثال: مسحوبات المالك" : "مثال: رأس مال"} /></label>
      {amt > 0 && <p>الرصيد بعد الحركة: <b className={after < 0 ? "down" : ""}>{egp(after)}</b></p>}
      {out && after < 0 && amt > 0 && <div className="error">المبلغ أكبر من الرصيد المسجّل. لو الرصيد المسجّل مش مظبوط اعمل «جرد الخزنة» الأول.</div>}
      {err && <div className="error">{err}</div>}
      <button className="primary" disabled={!(amt > 0)} onClick={run}>{out ? "تسجيل السحب" : "تسجيل الإيداع"}</button>
    </Modal>
  );
}

function TransferDialog({ snap, onClose, onDone }: { snap: TreasurySnapshot; onClose: () => void; onDone: (m: string) => void }) {
  const [dir, setDir] = useState<"cash>bank" | "bank>cash">("cash>bank");
  const [amount, setAmount] = useState(""); const [note, setNote] = useState(""); const [err, setErr] = useState("");
  const [from, to] = dir.split(">") as [Account, Account];
  const amt = toPiastres(amount);
  return (
    <Modal title="تحويل بين الكاش والبنك" onClose={onClose}>
      <p className="muted">مثلًا إيداع كاش في البنك، أو سحب من البنك للخزنة. الإجمالي المتاح مش بيتغيّر.</p>
      <label>الاتجاه<select value={dir} onChange={(e) => setDir(e.target.value as typeof dir)}><option value="cash>bank">من الكاش إلى البنك</option><option value="bank>cash">من البنك إلى الكاش</option></select></label>
      <label>المبلغ (جنيه)<input autoFocus type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label>البيان<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {amt > 0 && <p>بعد التحويل: كاش <b>{egp(snap.cash + (from === "cash" ? -amt : amt))}</b> • بنك <b>{egp(snap.bank + (from === "bank" ? -amt : amt))}</b></p>}
      {err && <div className="error">{err}</div>}
      <button className="primary" disabled={!(amt > 0)} onClick={() => api.treasuryTransfer(from, to, amt, note).then(() => onDone("اتسجّل التحويل")).catch((e) => setErr(errMsg(e)))}>تحويل</button>
    </Modal>
  );
}

function CountDialog({ snap, onClose, onDone }: { snap: TreasurySnapshot; onClose: () => void; onDone: (m: string) => void }) {
  const [account, setAccount] = useState<Account>("cash");
  const [counted, setCounted] = useState(""); const [note, setNote] = useState(""); const [err, setErr] = useState("");
  const diff = counted === "" ? null : toPiastres(counted) - snap[account];
  return (
    <Modal title="جرد الخزنة" onClose={onClose}>
      <p className="muted">عدّ الفلوس الفعلية واكتب المبلغ. البرنامج بيسجّل الفرق كحركة «جرد». استخدمه كمان أول مرة تبدأ فيها عشان تدخّل رصيد الافتتاح.</p>
      <label>الحساب<select value={account} onChange={(e) => setAccount(e.target.value as Account)}><option value="cash">كاش</option><option value="bank">بنك / فيزا (من كشف البنك)</option></select></label>
      <p>الرصيد حسب البرنامج: <b>{egp(snap[account])}</b></p>
      <label>المبلغ الفعلي (جنيه)<input autoFocus type="number" min="0" value={counted} onChange={(e) => setCounted(e.target.value)} /></label>
      {diff !== null && <div className={diff === 0 ? "note up" : "note"}>{diff === 0 ? "مطابق ✔" : diff > 0 ? `زيادة ${egp(diff)}` : `عجز ${egp(-diff)}`}</div>}
      <label>ملاحظة<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثال: رصيد افتتاحي" /></label>
      {err && <div className="error">{err}</div>}
      <button className="primary" disabled={counted === ""} onClick={() => api.treasuryCount(account, toPiastres(counted), note).then((d) => onDone(d === 0 ? "الجرد مطابق" : "اتسجّل فرق الجرد")).catch((e) => setErr(errMsg(e)))}>تسجيل الجرد</button>
    </Modal>
  );
}
