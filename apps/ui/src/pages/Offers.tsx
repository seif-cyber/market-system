import { useCallback, useEffect, useState } from "react";
import type { Category, InventoryProduct, PromotionInput, PromotionRow } from "@market/core";
import { api, egp, errMsg, toPiastres } from "../api";
import { dateLongAr, fromPiastres } from "../fmt";
import { Modal, Toast, useToast } from "../components/ui";

const TYPE: Record<PromotionRow["type"], string> = { percent: "خصم نسبة", amount: "خصم مبلغ للقطعة", bxgy: "اشترِ X وخد Y" };
const STATE: Record<PromotionRow["state"], string> = { running: "شغّال", upcoming: "لسه هيبدأ", ended: "انتهى", stopped: "موقوف" };
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const startOf = (v: string) => new Date(v + "T00:00:00").getTime();
const endOf = (v: string) => new Date(v + "T23:59:59").getTime();

const describe = (p: PromotionRow) => (p.type === "percent" ? `${p.value}٪ خصم` : p.type === "amount" ? `${egp(p.value)} جنيه خصم على القطعة` : `اشترِ ${p.buyQty} وخد ${p.getQty} مجانًا`);

export function Offers() {
  const [rows, setRows] = useState<PromotionRow[]>([]);
  const [edit, setEdit] = useState<Partial<PromotionRow> | null>(null);
  const toast = useToast();
  const load = useCallback(() => api.listPromotions().then(setRows).catch((e) => toast.fail(errMsg(e))), []); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const now = Date.now();
  return (
    <div className="page-wide">
      <div className="row toolbar">
        <button className="primary" onClick={() => setEdit({ type: "percent", target: "product", value: 10, buyQty: 2, getQty: 1, startsAt: now, endsAt: now + 14 * 86_400_000 })}>+ عرض جديد</button>
        <span className="muted">العروض بتتطبق أوتوماتيك في الكاشير على الأصناف أو الأقسام وقت ما تكون شغّالة، من غير ما الكاشير يحتاج اعتماد.</span>
      </div>
      <div className="scroll"><table>
        <thead><tr><th>العرض</th><th>النوع</th><th>على</th><th>من</th><th>إلى</th><th>الحالة</th><th /></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td><td>{describe(p)}</td><td>{p.target === "category" ? "قسم: " : "صنف: "}{p.targetName}</td><td>{dateLongAr(p.startsAt)}</td><td>{dateLongAr(p.endsAt)}</td>
              <td><span className={`st st-${p.state === "running" ? "paid" : p.state === "upcoming" ? "partial" : "voided"}`}>{STATE[p.state]}</span></td>
              <td><div className="row"><button onClick={() => setEdit(p)}>تعديل</button>
                <button onClick={() => api.setPromotionActive(p.id, !p.active).then(load)}>{p.active ? "إيقاف" : "تشغيل"}</button></div></td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={7} className="muted">لسه مفيش عروض.</td></tr>}
        </tbody>
      </table></div>
      {edit && <OfferForm initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); toast.ok("اتحفظ العرض ✔"); }} />}
      <Toast msg={toast.msg} />
    </div>
  );
}

function OfferForm({ initial, onClose, onSaved }: { initial: Partial<PromotionRow>; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(initial.name ?? "");
  const [type, setType] = useState<PromotionRow["type"]>(initial.type ?? "percent");
  const [target, setTarget] = useState<"product" | "category">(initial.target ?? "product");
  const [targetId, setTargetId] = useState(initial.targetId ?? 0);
  const [targetName, setTargetName] = useState(initial.targetName ?? "");
  const [value, setValue] = useState(initial.type === "amount" ? fromPiastres(initial.value ?? 0) : String(initial.value ?? 10));
  const [buy, setBuy] = useState(String(initial.buyQty ?? 2)); const [get, setGet] = useState(String(initial.getQty ?? 1));
  const [from, setFrom] = useState(day(initial.startsAt ?? Date.now())); const [to, setTo] = useState(day(initial.endsAt ?? Date.now() + 14 * 86_400_000));
  const [cats, setCats] = useState<Category[]>([]); const [q, setQ] = useState(""); const [hits, setHits] = useState<InventoryProduct[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => { api.listCategories().then(setCats); }, []);
  useEffect(() => { if (target === "product" && q.trim()) api.listProducts(q, "all").then((r) => setHits(r.slice(0, 6))); else setHits([]); }, [q, target]);

  const save = () => {
    const p: PromotionInput = {
      id: initial.id, name, type, target, targetId, value: type === "percent" ? parseFloat(value) : type === "amount" ? toPiastres(value) : 0,
      buyQty: type === "bxgy" ? parseInt(buy) : 0, getQty: type === "bxgy" ? parseInt(get) : 0, startsAt: startOf(from), endsAt: endOf(to),
    };
    api.savePromotion(p).then(onSaved).catch((e) => setErr(errMsg(e)));
  };
  return (
    <Modal title={initial.id ? "تعديل عرض" : "عرض جديد"} onClose={onClose}>
      <label>اسم العرض<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: خصم رمضان على الألبان" /></label>
      <label>نوع العرض<select value={type} onChange={(e) => setType(e.target.value as typeof type)}><option value="percent">خصم نسبة ٪</option><option value="amount">خصم مبلغ على القطعة</option><option value="bxgy">اشترِ X وخد Y مجانًا</option></select></label>
      {type === "percent" && <label>النسبة ٪<input type="number" min="1" max="100" value={value} onChange={(e) => setValue(e.target.value)} /></label>}
      {type === "amount" && <label>الخصم على كل قطعة (جنيه)<input type="number" min="0" step="any" value={value} onChange={(e) => setValue(e.target.value)} /></label>}
      {type === "bxgy" && <div className="row"><label className="grow">اشترِ<input type="number" min="1" value={buy} onChange={(e) => setBuy(e.target.value)} /></label><label className="grow">وخد مجانًا<input type="number" min="1" value={get} onChange={(e) => setGet(e.target.value)} /></label></div>}
      <label>العرض على<select value={target} onChange={(e) => { setTarget(e.target.value as typeof target); setTargetId(0); setTargetName(""); }}><option value="product">صنف</option><option value="category">قسم</option></select></label>
      {target === "category"
        ? <label>القسم<select value={targetId} onChange={(e) => setTargetId(+e.target.value)}><option value={0}>— اختار —</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        : <label>الصنف
            {targetId ? <div className="row"><span className="pill">{targetName}</span><button onClick={() => { setTargetId(0); setTargetName(""); setQ(""); }}>تغيير</button></div>
              : <><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث بالاسم أو الباركود" />{hits.length > 0 && <div className="pick">{hits.map((h) => <button key={h.id} onClick={() => { setTargetId(h.id); setTargetName(h.name); setHits([]); }}>{h.name}</button>)}</div>}</>}
          </label>}
      <div className="row"><label className="grow">من تاريخ<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label className="grow">إلى تاريخ<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label></div>
      {err && <div className="error">{err}</div>}
      <button className="primary" disabled={!name.trim() || !targetId} onClick={save}>حفظ العرض</button>
    </Modal>
  );
}
