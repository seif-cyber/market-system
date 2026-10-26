import { useEffect, useState } from "react";
import type { Analytics, RangePreset } from "@market/core";
import type { Backend, CloudUser, SaleRow, ShiftRow, ShopStatus } from "./backend";
import { DashboardView } from "../../ui/src/components/DashboardView";
import { ago, dateTimeAr, egp, num, PAY_LABEL } from "../../ui/src/fmt";
import { Install } from "./Install";
import { Support } from "./Support";

type Tab = "dash" | "sales" | "shifts";

export function Home({ be, user }: { be: Backend; user: CloudUser }) {
  const [tab, setTab] = useState<Tab>("dash");
  const [range, setRange] = useState<RangePreset>("today");
  const [status, setStatus] = useState<ShopStatus | null | undefined>(undefined);
  const [report, setReport] = useState<Analytics | null | undefined>(undefined);
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { const u = [be.watchStatus(user.uid, setStatus), be.watchSales(user.uid, setSales), be.watchShifts(user.uid, setShifts)]; return () => u.forEach((f) => f()); }, [be, user.uid]);
  useEffect(() => { setReport(undefined); return be.watchReport(user.uid, range, setReport); }, [be, user.uid, range]);

  const stale = status ? now - status.syncedAt > 60 * 60_000 : false;
  return (
    <div className="app cloud">
      <header>
        <div className="brand"><img src="/icon.svg" alt="" width={30} height={30} /><b>{status?.brand || "متابعة المبيعات"}</b></div>
        <div className="who"><span className="muted small" dir="ltr">{user.email}</span><button onClick={() => be.logout()}>خروج</button></div>
      </header>
      <nav className="tabbar" aria-label="الأقسام">
        <button className={tab === "dash" ? "on" : ""} onClick={() => setTab("dash")}>📊 التحليلات</button>
        <button className={tab === "sales" ? "on" : ""} onClick={() => setTab("sales")}>🧾 الفواتير</button>
        <button className={tab === "shifts" ? "on" : ""} onClick={() => setTab("shifts")}>🕒 الورديات</button>
      </nav>
      <main>
        <Install />
        {status === null && <div className="note">لسه مفيش بيانات اتبعتت من المحل. اربط برنامج الكاشير بالحساب ده من الإعدادات ← «متابعة المبيعات من الموبايل».</div>}
        {status && (
          <div className={stale ? "error" : "sync-line"} role="status">
            {stale ? `⚠ المحل مش متصل بالنت من ${ago(status.syncedAt, now).replace("من ", "")}. البيانات اللي قدامك آخر ما اتبعت.` : `🟢 آخر تحديث من المحل ${ago(status.syncedAt, now)}`}
          </div>
        )}
        {tab === "dash" && (report === undefined ? <div className="spinner" aria-label="جاري التحميل" /> : report ? <DashboardView a={report} range={range} onRange={setRange} /> : status ? <div className="muted">مفيش تقرير للفترة دي لسه.</div> : null)}
        {tab === "sales" && <Sales rows={sales} />}
        {tab === "shifts" && <Shifts rows={shifts} />}
      </main>
      <Support floating shop={status?.brand} />
    </div>
  );
}

function Sales({ rows }: { rows: SaleRow[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!rows.length) return <div className="muted">لا توجد فواتير.</div>;
  return (
    <ul className="inv-list">
      {rows.map((s) => (
        <li key={s.no}>
          <button className="inv" onClick={() => setOpen(open === s.no ? null : s.no)} aria-expanded={open === s.no}>
            <span className="inv-no">#{num(s.no)}</span>
            <span className="inv-meta">{dateTimeAr(s.createdAt)} • {s.cashier}{s.customer ? ` • ${s.customer}` : ""}</span>
            <span className={`tag s-${s.payMethod}-t`}>{PAY_LABEL[s.payMethod] ?? s.payMethod}</span>
            <b>{egp(s.total)}</b>
          </button>
          {open === s.no && (
            <table className="t inv-items"><tbody>
              {s.items.map((i, k) => <tr key={k}><td>{i.name}</td><td>{num(i.qty)} × {egp(i.unitPrice)}</td><td>{egp(Math.round(i.unitPrice * i.qty) - i.discount)}</td></tr>)}
              {s.discount > 0 && <tr><td colSpan={2}>خصم على الفاتورة</td><td className="down">− {egp(s.discount)}</td></tr>}
            </tbody></table>
          )}
        </li>
      ))}
    </ul>
  );
}

function Shifts({ rows }: { rows: ShiftRow[] }) {
  if (!rows.length) return <div className="muted">لا توجد ورديات مقفولة.</div>;
  return (
    <ul className="inv-list">
      {rows.map((s) => {
        const diff = s.counted - s.expected;
        return (
          <li key={s.id} className="shift">
            <div className="row between"><b>{s.cashier}</b><span className={diff === 0 ? "badge ok" : diff < 0 ? "badge bad" : "badge"}>{diff === 0 ? "الدرج مظبوط ✔" : diff < 0 ? `عجز ${egp(-diff)}` : `زيادة ${egp(diff)}`}</span></div>
            <div className="muted small">{dateTimeAr(s.openedAt)} ← {dateTimeAr(s.closedAt)}</div>
            <div className="row between small"><span>افتتاح {egp(s.openingCash)}</span><span>متوقع {egp(s.expected)}</span><span>معدود {egp(s.counted)}</span></div>
          </li>
        );
      })}
    </ul>
  );
}
