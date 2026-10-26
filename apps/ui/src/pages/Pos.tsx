import { useEffect, useRef, useState } from "react";
import type { Bootstrap, ProductHit } from "@market/core";
import { api, egp, errMsg } from "../api";

interface Line { p: ProductHit; qty: number }

export function Pos({ b }: { b: Bootstrap }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [code, setCode] = useState("");
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const locked = b.license.mode === "readonly";
  const total = lines.reduce((s, l) => s + Math.round(l.p.price * l.qty), 0);

  const focus = () => input.current?.focus();
  useEffect(focus, []);

  const add = (p: ProductHit) => {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.p.id === p.id);
      return i >= 0 ? ls.map((l, j) => (j === i ? { ...l, qty: l.qty + 1 } : l)) : [...ls, { p, qty: 1 }];
    });
    setMsg(""); setHits([]);
  };

  // A USB barcode scanner types the code fast and presses Enter.
  const submit = async () => {
    const c = code.trim(); if (!c) return;
    setCode("");
    try {
      const p = await api.scan(c);
      if (p) return add(p);
      const found = await api.search(c);
      if (found.length === 1) add(found[0]); else if (found.length) setHits(found); else setMsg(`مفيش صنف بالكود: ${c}`);
    } catch (e) { setMsg(errMsg(e)); }
    finally { focus(); }
  };

  const pay = async (method: "cash" | "card") => {
    setBusy(true);
    try {
      const r = await api.checkout({ lines: lines.map((l) => ({ productId: l.p.id, qty: l.qty })), payMethod: method });
      setMsg(`تمت الفاتورة رقم ${r.no}`);
      setLines([]);
      api.print(r.receiptHtml).catch((e) => setMsg(`الفاتورة اتحفظت لكن الطباعة فشلت: ${errMsg(e)}`));
    } catch (e) { setMsg(errMsg(e)); }
    finally { setBusy(false); focus(); }
  };

  return (
    <div className="pos">
      <section>
        <input ref={input} className="scan" placeholder="امسح الباركود أو اكتب اسم الصنف ثم Enter" value={code}
          onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} disabled={locked} />
        {msg && <div className="note">{msg}</div>}
        {hits.length > 0 && <div className="hits">{hits.map((h) => <button key={h.id} onClick={() => { add(h); focus(); }}>{h.name} — {egp(h.price)}</button>)}</div>}
        <table>
          <thead><tr><th>الصنف</th><th>السعر</th><th>الكمية</th><th>الإجمالي</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.p.id}>
                <td>{l.p.name}</td><td>{egp(l.p.price)}</td>
                <td><input className="qty" type="number" min="0.001" step="any" value={l.qty}
                  onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: +e.target.value || 0 } : x)))} /></td>
                <td>{egp(Math.round(l.p.price * l.qty))}</td>
                <td><button onClick={() => { setLines(lines.filter((_, j) => j !== i)); focus(); }}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <aside>
        <div className="total"><span>الإجمالي</span><b>{egp(total)}</b></div>
        <button className="primary big" disabled={!lines.length || busy || locked || lines.some((l) => !(l.qty > 0))} onClick={() => pay("cash")}>نقدي</button>
        <button className="big" disabled={!lines.length || busy || locked || lines.some((l) => !(l.qty > 0))} onClick={() => pay("card")}>فيزا</button>
        <button disabled={!lines.length} onClick={() => { setLines([]); focus(); }}>إلغاء الفاتورة</button>
      </aside>
    </div>
  );
}
