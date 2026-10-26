import { useEffect, useState } from "react";
import type { Analytics, RangePreset } from "@market/core";
import type { Backend, CloudUser, SaleRow, ShiftRow, ShopRef, ShopStatus, SuppliersDoc, TreasuryDoc } from "./backend";
import { DashboardView } from "../../ui/src/components/DashboardView";
import { ago, dateAr, dateLongAr, dateTimeAr, egp, egp0, KIND_AR, num, PAY_LABEL } from "../../ui/src/fmt";
import { Install } from "./Install";
import { Support } from "./Support";

type Tab = "dash" | "treasury" | "suppliers" | "sales" | "shifts";
const TABS: [Tab, string, string][] = [["dash", "📊", "التحليلات"], ["treasury", "🏦", "الخزنة"], ["suppliers", "🏭", "الموردين"], ["sales", "🧾", "الفواتير"], ["shifts", "🕒", "الورديات"]];

export function Home({ be, user, shops, shopId, onPick, onAdd, isAdmin }: { be: Backend; user: CloudUser; shops: ShopRef[]; shopId: string; onPick: (id: string) => void; onAdd: () => void; isAdmin?: boolean }) {
  const [tab, setTab] = useState<Tab>("dash");
  const [range, setRange] = useState<RangePreset>("today");
  const [status, setStatus] = useState<ShopStatus | null | undefined>(undefined);
  const [report, setReport] = useState<Analytics | null | undefined>(undefined);
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [treasury, setTreasury] = useState<TreasuryDoc | null | undefined>(undefined);
  const [suppliers, setSuppliers] = useState<SuppliersDoc | null | undefined>(undefined);
  const [now, setNow] = useState(Date.now());
  const [menu, setMenu] = useState(false);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => { if (!(e.target as HTMLElement).closest(".who")) setMenu(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("click", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", esc); };
  }, [menu]);
  useEffect(() => {
    setStatus(undefined); setTreasury(undefined); setSuppliers(undefined); setSales([]); setShifts([]);
    const u = [be.watchStatus(shopId, setStatus), be.watchSales(shopId, setSales), be.watchShifts(shopId, setShifts), be.watchTreasury(shopId, setTreasury), be.watchSuppliers(shopId, setSuppliers)];
    return () => u.forEach((f) => f());
  }, [be, shopId]);
  useEffect(() => { setReport(undefined); return be.watchReport(shopId, range, setReport); }, [be, shopId, range]);

  const stale = status ? now - status.syncedAt > 60 * 60_000 : false;
  const unlink = () => { if (confirm("فك ربط المحل ده من حسابك؟ مش هتشوف بياناته تاني لحد ما تربطه بكود جديد.")) be.unlinkShop(user.uid, shopId).catch((e) => alert(e.message)); };
  return (
    <div className="app cloud">
      <header>
        <div className="brand"><img src="/icon.svg" alt="" width={30} height={30} /><b>{status?.brand || "متابعة المبيعات"}</b></div>
        <div className="who">
          <button className="menu-btn" aria-label="القائمة" aria-expanded={menu} onClick={() => setMenu(!menu)}>☰</button>
          {menu && (
            <div className="menu" role="menu">
              <div className="muted small" dir="ltr">{user.email}</div>
              {shops.length > 1 && shops.map((s, i) => <button key={s.id} role="menuitem" className={s.id === shopId ? "on" : ""} onClick={() => { onPick(s.id); setMenu(false); }}>محل {num(i + 1)}{s.id === shopId ? " ✔" : ""}</button>)}
              <button role="menuitem" onClick={() => { setMenu(false); onAdd(); }}>+ ربط محل جديد</button>
              <button role="menuitem" onClick={() => { setMenu(false); unlink(); }}>فك ربط المحل ده</button>
              {isAdmin && <button role="menuitem" onClick={() => { setMenu(false); location.hash = "#/admin"; }}>إصدار أكواد التفعيل</button>}
              <button role="menuitem" onClick={() => be.logout()}>خروج</button>
            </div>
          )}
        </div>
      </header>
      <nav className="tabbar" aria-label="الأقسام">
        {TABS.map(([id, icon, label]) => <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}><span className="ti">{icon}</span><span>{label}</span></button>)}
      </nav>
      <main>
        <Install />
        {status === null && <div className="note">لسه مفيش بيانات اتبعتت من المحل. افتح برنامج الكاشير على جهاز المحل واتأكد إن فيه إنترنت (المزامنة كل 15 دقيقة).</div>}
        {status && (
          <div className={stale ? "error" : "sync-line"} role="status">
            {stale ? `⚠ المحل مش متصل بالنت من ${ago(status.syncedAt, now).replace("من ", "")}. البيانات اللي قدامك آخر ما اتبعت.` : `🟢 آخر تحديث من المحل ${ago(status.syncedAt, now)}`}
          </div>
        )}
        {tab === "dash" && (report === undefined ? <div className="spinner" aria-label="جاري التحميل" /> : report ? <DashboardView a={report} range={range} onRange={setRange} /> : status ? <div className="muted">مفيش تقرير للفترة دي لسه.</div> : null)}
        {tab === "treasury" && <Treasury t={treasury} />}
        {tab === "suppliers" && <Suppliers s={suppliers} />}
        {tab === "sales" && <Sales rows={sales} />}
        {tab === "shifts" && <Shifts rows={shifts} />}
      </main>
      <Support floating shop={status?.brand} />
    </div>
  );
}

const Kpi = ({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) => <div className={`kpi ${tone ?? ""}`}><span>{label}</span><b>{value}</b>{sub && <small>{sub}</small>}</div>;

function Treasury({ t }: { t: TreasuryDoc | null | undefined }) {
  if (t === undefined) return <div className="spinner" aria-label="جاري التحميل" />;
  if (!t) return <div className="muted">لسه مفيش بيانات للخزنة.</div>;
  return (
    <div className="dash">
      <div className="kpis">
        <Kpi label="💵 كاش" value={egp0(t.cash)} />
        <Kpi label="🏦 بنك / فيزا" value={egp0(t.bank)} />
        <Kpi label="الإجمالي المتاح" value={egp0(t.total)} tone="good" sub="كاش + بنك" />
        <Kpi label="لينا عند العملاء" value={egp0(t.receivables)} />
        <Kpi label="علينا للموردين" value={egp0(t.payables)} />
        <Kpi label="صافي الموقف" value={egp0(t.total + t.receivables - t.payables)} sub="الإجمالي + ديون العملاء − الموردين" />
      </div>
      <section className="panel"><h3>آخر حركات الخزنة</h3>
        <ul className="inv-list flat">
          {t.entries.map((e, i) => (
            <li key={i} className="mv">
              <div><b>{KIND_AR[e.kind] ?? e.kind}</b> <span className="muted small">• {e.account === "cash" ? "كاش" : "بنك"}{e.note ? ` • ${e.note}` : ""}</span><div className="muted small">{dateTimeAr(e.at)}{e.user ? ` • ${e.user}` : ""}</div></div>
              <div className="amt"><b className={e.delta >= 0 ? "up" : "down"}>{e.delta >= 0 ? "+" : "−"}{egp(Math.abs(e.delta))}</b><div className="muted small">الرصيد {egp(e.balance)}</div></div>
            </li>
          ))}
          {!t.entries.length && <li className="muted">لا توجد حركات</li>}
        </ul>
      </section>
    </div>
  );
}

const ST_AR: Record<string, string> = { paid: "مدفوعة", partial: "جزئي", unpaid: "آجل", overdue: "متأخرة", voided: "ملغية" };
function Suppliers({ s }: { s: SuppliersDoc | null | undefined }) {
  if (s === undefined) return <div className="spinner" aria-label="جاري التحميل" />;
  if (!s) return <div className="muted">لسه مفيش بيانات للموردين.</div>;
  const owed = s.dues.reduce((a, d) => a + d.balance, 0), late = s.dues.reduce((a, d) => a + d.overdue, 0);
  return (
    <div className="dash">
      <div className="kpis">
        <Kpi label="علينا للموردين" value={egp0(owed)} sub={`${num(s.dues.length)} مورد`} />
        <Kpi label="متأخر عن الاستحقاق" value={egp0(late)} tone={late ? "bad" : undefined} />
      </div>
      <section className="panel"><h3>مستحقات الموردين</h3>
        <ul className="list">
          {s.dues.map((d) => <li key={d.id}><span>{d.name}{d.overdue > 0 && <span className="st st-overdue">متأخر {egp0(d.overdue)}</span>}{d.overdue === 0 && d.nextDue && <small className="muted"> يستحق {dateLongAr(d.nextDue)}</small>}</span><b>{egp(d.balance)}</b></li>)}
          {!s.dues.length && <li className="muted">مفيش مستحقات 👌</li>}
        </ul>
      </section>
      <section className="panel"><h3>آخر فواتير الشراء</h3>
        <ul className="inv-list flat">
          {s.invoices.map((p) => (
            <li key={p.id} className="mv">
              <div><b>{p.supplier}</b> <span className="muted small">{p.ref && `• ${p.ref}`}</span><div className="muted small">{dateAr(p.date)}{p.due ? ` • استحقاق ${dateAr(p.due)}` : ""}</div></div>
              <div className="amt"><b>{egp(p.total)}</b><div><span className={`st st-${p.status}`}>{ST_AR[p.status] ?? p.status}</span>{p.remaining > 0 && <span className="muted small"> متبقي {egp0(p.remaining)}</span>}</div></div>
            </li>
          ))}
          {!s.invoices.length && <li className="muted">لا توجد فواتير شراء</li>}
        </ul>
      </section>
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
