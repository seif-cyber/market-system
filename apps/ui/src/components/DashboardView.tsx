import type { Analytics, RangePreset } from "@market/core";
import { ago, dateAr, egp, egp0, num, dateLongAr, PAY_LABEL } from "../fmt";

export const RANGES: { id: RangePreset; label: string }[] = [
  { id: "today", label: "النهارده" }, { id: "7d", label: "7 أيام" }, { id: "30d", label: "30 يوم" }, { id: "month", label: "الشهر الحالي" },
];

function Bars({ items, fmt, tone = "accent", labelEvery = 1 }: { items: { label: string; value: number; tip: string }[]; fmt: (v: number) => string; tone?: string; labelEvery?: number }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="bars" role="img" aria-label="رسم بياني">
      {items.map((i, k) => (
        <div key={k} className="bar" title={i.tip}>
          <div className="bar-val">{i.value > 0 && items.length <= 16 ? fmt(i.value) : ""}</div>
          <div className="bar-col"><div className={`bar-fill ${tone}`} style={{ height: `${Math.max(i.value > 0 ? 3 : 0, (i.value / max) * 100)}%` }} /></div>
          <div className="bar-label">{k % labelEvery === 0 ? i.label : ""}</div>
        </div>
      ))}
    </div>
  );
}

const Kpi = ({ label, value, sub, tone }: { label: string; value: string; sub?: React.ReactNode; tone?: string }) => (
  <div className={`kpi ${tone ?? ""}`}><span>{label}</span><b>{value}</b>{sub && <small>{sub}</small>}</div>
);

function Delta({ cur, prev }: { cur: number; prev: number }) {
  if (prev <= 0) return <span className="muted">لا توجد فترة سابقة للمقارنة</span>;
  const p = Math.round(((cur - prev) / prev) * 100);
  return <span className={p >= 0 ? "up" : "down"}>{p >= 0 ? "▲" : "▼"} {num(Math.abs(p))}٪ عن الفترة السابقة</span>;
}

const Card = ({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }) => (
  <section className={`panel ${wide ? "wide" : ""}`}><h3>{title}</h3>{children}</section>
);

export function DashboardView({ a, range, onRange, syncedAt }: { a: Analytics; range: RangePreset; onRange: (r: RangePreset) => void; syncedAt?: number }) {
  const k = a.kpi;
  const payTotal = a.payments.reduce((s, p) => s + p.total, 0) || 1;
  const expTotal = a.expensesByCategory.reduce((s, p) => s + p.total, 0) || 1;
  const long = a.daily.length > 16;
  return (
    <div className="dash">
      <div className="dash-top">
        <div className="tabs">{RANGES.map((r) => <button key={r.id} className={range === r.id ? "on" : ""} onClick={() => onRange(r.id)}>{r.label}</button>)}</div>
        <div className={a.integrity.ok ? "badge ok" : "badge bad"}>
          {a.integrity.ok ? `✔ سجل الفواتير سليم (${num(a.integrity.checked)} فاتورة)` : `⚠ تم اكتشاف تعديل في الفاتورة رقم ${num(a.integrity.brokenAt ?? 0)}`}
        </div>
        {syncedAt ? <div className="muted">آخر تحديث من المحل {ago(syncedAt)}</div> : null}
      </div>

      {a.position && (
        <div className="kpis position">
          <Kpi label="💵 كاش" value={egp0(a.position.cash)} />
          <Kpi label="🏦 بنك / فيزا" value={egp0(a.position.bank)} />
          <Kpi label="الإجمالي المتاح" value={egp0(a.position.total)} tone="good" sub={a.treasuryCheck?.ok === false ? "⚠ فيه فرق في الخزنة، راجع صفحة الخزنة" : "الخزنة مطابقة ✔"} />
          <Kpi label="لينا عند العملاء" value={egp0(a.position.receivables)} sub={a.position.payables ? `علينا للموردين ${egp0(a.position.payables)}` : undefined} />
        </div>
      )}

      <div className="kpis">
        <Kpi label="صافي المبيعات" value={egp0(k.netSales)} sub={<Delta cur={k.netSales} prev={k.prevNetSales} />} />
        <Kpi label="عدد الفواتير" value={num(k.invoices)} sub={`متوسط الفاتورة ${egp0(k.avgBasket)}`} />
        <Kpi label="إجمالي الربح" value={egp0(k.grossProfit)} sub={k.returns ? `مرتجعات ${egp0(k.returns)}` : "بعد المرتجعات"} />
        <Kpi label="المصاريف" value={egp0(k.expenses)} sub="إيجار، مرتبات، كهرباء…" />
        <Kpi label="صافي الربح" value={egp0(k.netProfit)} tone={k.netProfit >= 0 ? "good" : "bad"} sub="الربح − المصاريف" />
      </div>

      <div className="grid2">
        {a.daily.length > 1 && (
          <Card title="المبيعات اليومية" wide>
            <Bars items={a.daily.map((d) => ({ label: dateAr(Date.parse(d.day + "T12:00:00")), value: Math.max(0, d.sales), tip: `${dateLongAr(Date.parse(d.day + "T12:00:00"))}: ${egp(d.sales)}` }))} fmt={egp0} labelEvery={long ? 5 : 1} />
          </Card>
        )}
        <Card title="ساعات الذروة" wide={a.daily.length <= 1}>
          <Bars tone="alt" items={a.hourly.slice(8).map((h) => ({ label: String(h.hour), value: h.sales, tip: `الساعة ${h.hour}: ${egp(h.sales)} (${num(h.invoices)} فاتورة)` }))} fmt={() => ""} />
          <p className="muted">اعرف أزحم وقت في اليوم عشان تظبط الورديات.</p>
        </Card>
        <Card title="طرق الدفع">
          {a.payments.length === 0 ? <p className="muted">لا توجد مبيعات</p> : (
            <>
              <div className="stack">{a.payments.map((p) => <i key={p.method} className={`s-${p.method}`} style={{ width: `${(p.total / payTotal) * 100}%` }} title={PAY_LABEL[p.method]} />)}</div>
              <ul className="legend">{a.payments.map((p) => <li key={p.method}><em className={`s-${p.method}`} />{PAY_LABEL[p.method] ?? p.method}<b>{egp0(p.total)}</b><span>{num(Math.round((p.total / payTotal) * 100))}٪</span></li>)}</ul>
            </>
          )}
        </Card>
      </div>

      <div className="grid2">
        <Card title="أكتر الأصناف مبيعًا">
          <table className="t"><thead><tr><th>الصنف</th><th>الكمية</th><th>المبيعات</th><th>الربح</th></tr></thead>
            <tbody>{a.topProducts.map((p) => <tr key={p.name}><td>{p.name}</td><td>{num(p.qty)}</td><td>{egp0(p.revenue)}</td><td className={p.profit >= 0 ? "up" : "down"}>{egp0(p.profit)}</td></tr>)}
              {!a.topProducts.length && <tr><td colSpan={4} className="muted">لا توجد مبيعات</td></tr>}</tbody></table>
        </Card>
        <Card title="أداء الكاشيرية">
          <table className="t"><thead><tr><th>الكاشير</th><th>فواتير</th><th>مبيعات</th><th>خصومات</th><th>فرق الدرج</th></tr></thead>
            <tbody>{a.cashiers.map((c) => <tr key={c.name}><td>{c.name}</td><td>{num(c.invoices)}</td><td>{egp0(c.sales)}</td><td>{egp0(c.discounts)}</td>
              <td className={c.cashDiff < 0 ? "down" : c.cashDiff > 0 ? "up" : ""}>{c.cashDiff === 0 ? "مظبوط" : (c.cashDiff > 0 ? "+" : "") + egp0(c.cashDiff)}</td></tr>)}
              {!a.cashiers.length && <tr><td colSpan={5} className="muted">لا توجد بيانات</td></tr>}</tbody></table>
        </Card>
      </div>

      <div className="grid3">
        <Card title={`⚠ مخزون قارب على النفاد (${num(a.lowStock.length)})`}>
          <ul className="list">{a.lowStock.map((p) => <li key={p.id}>{p.name}<b className={p.stock <= 0 ? "down" : ""}>{num(p.stock)} / {num(p.minStock)}</b></li>)}{!a.lowStock.length && <li className="muted">المخزون تمام</li>}</ul>
        </Card>
        <Card title={`⏳ صلاحية قربت أو انتهت (${num(a.expiring.length)})`}>
          <ul className="list">{a.expiring.map((e, i) => <li key={i}>{e.name} <small>({num(e.qty)})</small><b className={e.daysLeft < 0 ? "down" : "warn"}>{e.daysLeft < 0 ? "منتهي" : `باقي ${num(e.daysLeft)} يوم`}</b></li>)}{!a.expiring.length && <li className="muted">مفيش أصناف قربت تنتهي</li>}</ul>
        </Card>
        <Card title={`💳 ديون العملاء (${egp0(a.debts.total)})`}>
          <ul className="list">{a.debts.top.map((d) => <li key={d.name}>{d.name}<b>{egp0(d.balance)}</b></li>)}{!a.debts.top.length && <li className="muted">لا توجد ديون</li>}</ul>
        </Card>
      </div>

      <div className="grid2">
        <Card title="مصاريف حسب النوع">
          <ul className="list">{a.expensesByCategory.map((e) => <li key={e.category}>{e.category}<span className="bar-inline"><i style={{ width: `${(e.total / expTotal) * 100}%` }} /></span><b>{egp0(e.total)}</b></li>)}{!a.expensesByCategory.length && <li className="muted">لا توجد مصاريف</li>}</ul>
        </Card>
        <Card title="🧊 مخزون راكد (مبيعش من 30 يوم)">
          <ul className="list">{a.deadStock.map((d) => <li key={d.name}>{d.name} <small>({num(d.stock)})</small><b>{egp0(d.value)}</b></li>)}{!a.deadStock.length && <li className="muted">مفيش مخزون راكد</li>}</ul>
          <p className="muted">القيمة = الكمية × سعر الشراء، أي فلوس واقفة في الرف.</p>
        </Card>
      </div>
    </div>
  );
}
