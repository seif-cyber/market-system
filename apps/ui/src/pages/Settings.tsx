import { useState } from "react";
import type { Bootstrap, BrandSettings } from "@market/core";
import { api, errMsg } from "../api";

export function Settings({ b, onChange }: { b: Bootstrap; onChange: () => void }) {
  const [s, setS] = useState<BrandSettings>(b.brand);
  const [msg, setMsg] = useState("");
  const [key, setKey] = useState("");
  const set = (k: keyof BrandSettings, v: string) => setS({ ...s, [k]: v });

  const pickLogo = (f?: File) => {
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      // Downscale so the receipt stays light and prints crisply on a thermal printer.
      const scale = Math.min(1, 400 / img.width);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      const g = c.getContext("2d")!;
      g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      set("logo", c.toDataURL("image/png"));
    };
    img.src = URL.createObjectURL(f);
  };

  const save = () => api.saveSettings(s).then(() => { setMsg("اتحفظ ✔"); onChange(); }).catch((e) => setMsg(errMsg(e)));
  const activate = () => api.activate(key).then(() => { setMsg("تم التفعيل ✔"); setKey(""); onChange(); }).catch((e) => setMsg(errMsg(e)));
  const lic = b.license;

  return (
    <div className="page">
      <div className="card wide">
        <h2>بيانات المحل (بتظهر على الفاتورة)</h2>
        <label>اسم المحل / البراند<input value={s.brand_name} onChange={(e) => set("brand_name", e.target.value)} /></label>
        <label>العنوان<input value={s.address} onChange={(e) => set("address", e.target.value)} /></label>
        <label>التليفون<input value={s.phone} onChange={(e) => set("phone", e.target.value)} /></label>
        <label>الرقم الضريبي<input value={s.tax_no} onChange={(e) => set("tax_no", e.target.value)} /></label>
        <label>رسالة آخر الفاتورة<input value={s.footer} onChange={(e) => set("footer", e.target.value)} /></label>
        <label>نسبة الضريبة %<input type="number" min="0" max="100" value={s.tax_rate} onChange={(e) => set("tax_rate", e.target.value)} /></label>
        <label className="row"><input type="checkbox" checked={s.tax_inclusive === "1"} onChange={(e) => set("tax_inclusive", e.target.checked ? "1" : "0")} /> الأسعار شاملة الضريبة</label>
        <label>اللوجو<input type="file" accept="image/*" onChange={(e) => pickLogo(e.target.files?.[0])} /></label>
        {s.logo && <div className="row"><img className="logo" src={s.logo} alt="" /><button onClick={() => set("logo", "")}>شيل اللوجو</button></div>}
        <button className="primary" onClick={save}>حفظ</button>
        {msg && <div className="note">{msg}</div>}
      </div>

      <div className="card wide">
        <h2>التفعيل</h2>
        <p>كود الجهاز: <code>{b.deviceCode}</code></p>
        <p>
          {lic.mode === "licensed" && <>مفعّل لـ <b>{lic.payload.customer}</b> — باقي {lic.daysLeft} يوم</>}
          {lic.mode === "trial" && <>نسخة تجريبية — باقي {lic.daysLeft} يوم</>}
          {lic.mode === "readonly" && <>الترخيص غير صالح ({lic.reason})</>}
        </p>
        {b.user?.role === "owner" && <>
          <label>مفتاح التفعيل<textarea rows={3} value={key} onChange={(e) => setKey(e.target.value)} /></label>
          <button className="primary" disabled={!key.trim()} onClick={activate}>تفعيل</button>
        </>}
      </div>
    </div>
  );
}
