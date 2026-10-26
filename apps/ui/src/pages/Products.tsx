import { useState } from "react";
import { api, errMsg } from "../api";

export function Products() {
  const [res, setRes] = useState<{ created: number; updated: number; errors: string[] } | null>(null);
  const [err, setErr] = useState("");

  const pick = async (f?: File) => {
    if (!f) return;
    setErr(""); setRes(null);
    try { setRes(await api.importCsv(await f.text())); } catch (e) { setErr(errMsg(e)); }
  };
  const template = () => {
    const blob = new Blob(["﻿الباركود,الاسم,السعر,التكلفة,الكمية\n6221234567890,شاي العروسة 40 جم,5.5,4.8,100\n"], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "products-template.csv"; a.click();
  };
  return (
    <div className="page">
      <div className="card wide">
        <h2>استيراد المنتجات من ملف CSV</h2>
        <p>من Excel: احفظ الملف كـ CSV. الأعمدة المطلوبة: الباركود، الاسم، السعر (بالجنيه). اختياري: التكلفة، الكمية. لو الباركود موجود الصنف بيتحدّث والكمية بتتضاف.</p>
        <button onClick={template}>نزّل ملف نموذج</button>
        <label>اختار الملف<input type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} /></label>
        {err && <div className="error">{err}</div>}
        {res && <div className="note">اتضاف {res.created} صنف جديد، واتحدّث {res.updated}.
          {res.errors.length > 0 && <ul>{res.errors.slice(0, 20).map((x) => <li key={x}>{x}</li>)}</ul>}</div>}
      </div>
    </div>
  );
}
