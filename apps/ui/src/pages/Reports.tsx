import { useEffect, useMemo, useState } from "react";
import type { Bootstrap, Category, InventoryProduct, Party, ReportFilterKey, ReportFilters, ReportMeta, ReportResult } from "@market/core";
import { api, errMsg, num } from "../api";
import { fmtCell } from "../fmt";
import { Toast, useToast } from "../components/ui";

const GROUPS: Record<ReportMeta["group"], string> = { sales: "المبيعات", purchases: "المشتريات", inventory: "المخزون", finance: "المالية" };
const RANGES: [NonNullable<ReportFilters["range"]>, string][] = [["today", "النهارده"], ["7d", "آخر 7 أيام"], ["30d", "آخر 30 يوم"], ["month", "الشهر الحالي"], ["all", "كل الفترات"], ["custom", "فترة محددة"]];
const PAY: [string, string][] = [["cash", "نقدي"], ["card", "فيزا"], ["credit", "آجل"]];
const today = () => new Date().toISOString().slice(0, 10);

export function Reports({ b }: { b: Bootstrap }) {
  const [metas, setMetas] = useState<ReportMeta[]>([]);
  const [sel, setSel] = useState<ReportMeta | null>(null);
  const [range, setRange] = useState<NonNullable<ReportFilters["range"]>>("30d");
  const [from, setFrom] = useState(today()); const [to, setTo] = useState(today());
  const [userId, setUserId] = useState(0); const [partyId, setPartyId] = useState(0); const [categoryId, setCategoryId] = useState(0);
  const [payMethod, setPayMethod] = useState(""); const [account, setAccount] = useState("");
  const [product, setProduct] = useState<InventoryProduct | null>(null); const [pq, setPq] = useState(""); const [hits, setHits] = useState<InventoryProduct[]>([]);
  const [parties, setParties] = useState<Party[]>([]); const [cats, setCats] = useState<Category[]>([]);
  const [res, setRes] = useState<ReportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => { api.reportList().then((m) => { setMetas(m); setSel(m[0] ?? null); }); api.listParties().then(setParties); api.listCategories().then(setCats); }, []);
  useEffect(() => { if (pq.trim() && !product) api.listProducts(pq, "all").then((r) => setHits(r.slice(0, 6))); else setHits([]); }, [pq, product]);

  const filters = useMemo((): ReportFilters => ({
    range, ...(range === "custom" ? { from: new Date(from + "T00:00:00").getTime(), to: new Date(to + "T00:00:00").getTime() } : {}),
    userId: userId || undefined, partyId: partyId || undefined, productId: product?.id, categoryId: categoryId || undefined, payMethod: payMethod || undefined, account: account || undefined,
  }), [range, from, to, userId, partyId, product, categoryId, payMethod, account]);

  const run = (m = sel) => {
    if (!m) return;
    setBusy(true);
    api.runReport(m.id, filters).then(setRes).catch((e) => toast.fail(errMsg(e))).finally(() => setBusy(false));
  };
  useEffect(() => { if (sel) run(sel); }, [sel]); // eslint-disable-line
  const exp = (kind: "xlsx" | "pdf" | "print") => {
    if (!sel) return;
    api.exportReport(sel.id, filters, kind).then((p) => { if (p) toast.ok(kind === "print" ? "اتبعت للطباعة" : `اتحفظ: ${p}`); }).catch((e) => toast.fail(errMsg(e)));
  };
  const has = (k: ReportFilterKey) => !!sel?.filters.includes(k);

  return (
    <div className="reports">
      <section className="rep-list">
        <h2>حدد التقرير للعرض أو الطباعة</h2>
        {(Object.keys(GROUPS) as ReportMeta["group"][]).map((g) => (
          <div key={g}><h3>{GROUPS[g]}</h3>
            {metas.filter((m) => m.group === g).map((m) => <button key={m.id} className={`rep-item ${sel?.id === m.id ? "on" : ""}`} onClick={() => setSel(m)}>{m.title}</button>)}
          </div>
        ))}
      </section>

      <div className="rep-main">
      <aside className="rep-filters">
        <h3>تصفية</h3>
        <div className="filters-grid">
        {has("range") && <>
          <label>الفترة<select value={range} onChange={(e) => setRange(e.target.value as typeof range)}>{RANGES.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select></label>
          {range === "custom" && <div className="row"><label className="grow">من<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label className="grow">إلى<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label></div>}
        </>}
        {has("userId") && <label>المستخدم<select value={userId} onChange={(e) => setUserId(+e.target.value)}><option value={0}>جميع المستخدمين</option>{b.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>}
        {has("partyId") && <label>العميل / المورد<select value={partyId} onChange={(e) => setPartyId(+e.target.value)}><option value={0}>الكل</option>{parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
        {has("categoryId") && <label>القسم<select value={categoryId} onChange={(e) => setCategoryId(+e.target.value)}><option value={0}>كل الأقسام</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
        {has("productId") && (
          <label>الصنف
            {product ? <div className="row"><span className="pill">{product.name}</span><button onClick={() => { setProduct(null); setPq(""); }}>✕</button></div>
              : <><input value={pq} onChange={(e) => setPq(e.target.value)} placeholder="ابحث عن صنف" />{hits.length > 0 && <div className="pick">{hits.map((h) => <button key={h.id} onClick={() => { setProduct(h); setHits([]); }}>{h.name}</button>)}</div>}</>}
          </label>
        )}
        {has("payMethod") && <label>طريقة الدفع<select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}><option value="">الكل</option>{PAY.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select></label>}
        {has("account") && <label>الحساب<select value={account} onChange={(e) => setAccount(e.target.value)}><option value="">كاش وبنك</option><option value="cash">كاش</option><option value="bank">بنك / فيزا</option></select></label>}
        {sel && sel.filters.length === 0 && <p className="muted">التقرير ده مفيهوش فلاتر.</p>}
        </div>
        <div className="rep-actions">
          <button className="primary" disabled={!sel || busy} onClick={() => run()}>🔍 عرض</button>
          <button disabled={!sel} onClick={() => exp("print")}>🖨 طباعة</button>
          <button disabled={!sel} onClick={() => exp("xlsx")}>📊 Excel</button>
          <button disabled={!sel} onClick={() => exp("pdf")}>📄 PDF</button>
        </div>
      </aside>

      <section className="rep-result">
        {res && (
          <>
            <div className="row between"><h2>{res.title}</h2><span className="muted">{num(res.rows.length)} سطر</span></div>
            <div className="scroll"><table>
              <thead><tr>{res.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
              <tbody>
                {res.rows.slice(0, 500).map((r, i) => <tr key={i}>{res.columns.map((c) => <td key={c.key} className={["money", "qty", "int", "percent"].includes(c.type) ? "num" : ""}>{fmtCell(c, r[c.key] ?? null)}</td>)}</tr>)}
                {res.totals && <tr className="sum">{res.columns.map((c, i) => <td key={c.key} className={["money", "qty", "int", "percent"].includes(c.type) ? "num" : ""}>{i === 0 ? "الإجمالي" : c.key in res.totals! ? fmtCell(c, res.totals![c.key] as number) : ""}</td>)}</tr>}
                {!res.rows.length && <tr><td colSpan={res.columns.length} className="muted">مفيش بيانات بالفلاتر دي.</td></tr>}
              </tbody>
            </table></div>
            {res.rows.length > 500 && <p className="muted">معروض أول 500 سطر. التصدير (Excel / PDF) بيشمل كل السطور.</p>}
          </>
        )}
      </section>
      </div>
      <Toast msg={toast.msg} />
    </div>
  );
}
