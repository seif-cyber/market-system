import { useCallback, useEffect, useState } from "react";
import type { ImportBatch } from "@market/core";
import { api, errMsg, num } from "../api";
import { dateTimeAr } from "../fmt";
import { Toast, useToast } from "./ui";

const TEMPLATES = {
  products: { file: "products-template.csv", text: "﻿الباركود,الاسم,السعر,التكلفة,الكمية,الحد الأدنى,تاريخ الصلاحية,القسم\n6221234567890,شاي العروسة 40 جم,5.5,4.8,100,20,2027-01-31,مشروبات\n" },
  parties: { file: "parties-template.csv", text: "﻿الكود,الاسم,النوع,التليفون,الرقم الضريبي,العنوان,الإيميل,حد الآجل\nC001,أبو علي,عميل,01000000000,,القاهرة,,500\nS001,شركة النور,مورد,0225000000,123-456,الجيزة,info@example.com,0\n" },
};

/** Upload a CSV (Excel "Save as CSV") and, if it was a mistake, take it back: the last import can always be undone. */
export function ImportPanel({ kind, onChanged }: { kind: "products" | "parties"; onChanged?: () => void }) {
  const [res, setRes] = useState<{ created: number; updated: number; errors: string[]; batchId: number | null } | null>(null);
  const [hist, setHist] = useState<ImportBatch[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const loadHist = useCallback(() => api.listImports().then((r) => setHist(r.filter((x) => x.kind === kind))).catch(() => {}), [kind]);
  useEffect(() => { loadHist(); }, [loadHist]);

  const pick = async (f?: File) => {
    if (!f) return;
    setBusy(true); setRes(null);
    try {
      const text = await f.text();
      setRes(kind === "products" ? await api.importCsv(text, f.name) : await api.importParties(text, f.name));
      loadHist(); onChanged?.();
    } catch (e) { toast.fail(errMsg(e)); }
    finally { setBusy(false); }
  };
  const undo = (b: ImportBatch) => {
    if (!confirm(`التراجع عن «${b.label}»؟\nالأصناف/الأسماء الجديدة هتتمسح، والمتحدّثة هترجع لقيمها القديمة.`)) return;
    api.undoImport(b.id).then((r) => {
      toast.ok(`تم التراجع: اتمسح ${num(r.removed)} ورجع ${num(r.restored)}` + (r.skipped ? ` وفضل ${num(r.skipped)} لأنهم اتحركوا بعد الاستيراد` : ""));
      setRes(null); loadHist(); onChanged?.();
    }).catch((e) => toast.fail(errMsg(e)));
  };
  const template = () => {
    const t = TEMPLATES[kind];
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([t.text], { type: "text/csv" })); a.download = t.file; a.click();
  };
  const last = res?.batchId ? hist.find((h) => h.id === res.batchId) : undefined;

  return (
    <div className="card wide">
      <h2>{kind === "products" ? "استيراد الأصناف من ملف" : "استيراد العملاء والموردين من ملف"}</h2>
      <p>
        من Excel: احفظ الملف كـ <b>CSV</b>.{" "}
        {kind === "products"
          ? "المطلوب: الباركود، الاسم، السعر (بالجنيه). اختياري: التكلفة، الكمية، الحد الأدنى، تاريخ الصلاحية (2027-01-31)، القسم. لو الباركود موجود الصنف بيتحدّث والكمية بتتضاف."
          : "المطلوب: الاسم. اختياري: الكود، النوع (عميل / مورد / الاتنين)، التليفون، الرقم الضريبي، العنوان، الإيميل، حد الآجل. لو الكود أو الاسم موجود بيتحدّث."}
      </p>
      <div className="row"><button onClick={template}>نزّل ملف نموذج</button></div>
      <label>اختار الملف<input type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} /></label>
      {res && (
        <div className="note">
          <b>اتضاف {num(res.created)} جديد، واتحدّث {num(res.updated)}.</b>
          {res.errors.length > 0 && <ul>{res.errors.slice(0, 20).map((x) => <li key={x}>{x}</li>)}</ul>}
          {last?.undoable && <div><button className="danger" onClick={() => undo(last)}>↩ تراجع عن الاستيراد ده</button></div>}
        </div>
      )}
      {hist.length > 0 && (
        <>
          <h3>آخر عمليات الاستيراد</h3>
          <table className="t"><tbody>
            {hist.slice(0, 6).map((h) => (
              <tr key={h.id}>
                <td>{h.label}</td><td className="muted">{dateTimeAr(h.createdAt)}</td><td>{num(h.created)} جديد • {num(h.updated)} تحديث</td>
                <td>{h.undone ? <span className="muted">اتلغى</span> : h.undoable ? <button onClick={() => undo(h)}>↩ تراجع</button> : <span className="muted" title="تقدر تتراجع عن آخر استيراد بس">—</span>}</td>
              </tr>
            ))}
          </tbody></table>
        </>
      )}
      <Toast msg={toast.msg} />
    </div>
  );
}
