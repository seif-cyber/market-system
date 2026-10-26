import { useEffect, useState } from "react";
import type { Bootstrap, BrandSettings, CloudStatus, Role } from "@market/core";
import { api, errMsg } from "../api";
import { ago, dateTimeAr } from "../fmt";
import { SupportButton, Toast, useToast } from "../components/ui";

const ROLE: Record<Role, string> = { owner: "مالك", manager: "مدير", cashier: "كاشير" };

export function Settings({ b, onChange }: { b: Bootstrap; onChange: () => void }) {
  const owner = b.user?.role === "owner";
  const toast = useToast();
  return (
    <div className="page">
      <Brand b={b} onChange={onChange} toast={toast} />
      {owner && <Users b={b} onChange={onChange} toast={toast} />}
      <Backups owner={owner} toast={toast} />
      <Cloud owner={owner} toast={toast} />
      <License b={b} owner={owner} onChange={onChange} toast={toast} />
      <Toast msg={toast.msg} />
    </div>
  );
}
type T = ReturnType<typeof useToast>;

function Brand({ b, onChange, toast }: { b: Bootstrap; onChange: () => void; toast: T }) {
  const [s, setS] = useState<BrandSettings>(b.brand);
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
  return (
    <div className="card wide">
      <h2>بيانات المحل (بتظهر على الفاتورة)</h2>
      <div className="grid-form">
        <label>اسم المحل / البراند<input value={s.brand_name} onChange={(e) => set("brand_name", e.target.value)} /></label>
        <label>التليفون<input value={s.phone} onChange={(e) => set("phone", e.target.value)} /></label>
        <label>العنوان<input value={s.address} onChange={(e) => set("address", e.target.value)} /></label>
        <label>الرقم الضريبي<input value={s.tax_no} onChange={(e) => set("tax_no", e.target.value)} /></label>
        <label>رسالة آخر الفاتورة<input value={s.footer} onChange={(e) => set("footer", e.target.value)} /></label>
        <label>نسبة الضريبة ٪<input type="number" min="0" max="100" value={s.tax_rate} onChange={(e) => set("tax_rate", e.target.value)} /></label>
      </div>
      <label className="row"><input type="checkbox" checked={s.tax_inclusive === "1"} onChange={(e) => set("tax_inclusive", e.target.checked ? "1" : "0")} /> الأسعار شاملة الضريبة</label>
      <label>اللوجو<input type="file" accept="image/*" onChange={(e) => pickLogo(e.target.files?.[0])} /></label>
      {s.logo && <div className="row"><img className="logo" src={s.logo} alt="" /><button onClick={() => set("logo", "")}>شيل اللوجو</button></div>}
      <h3>ميزان الباركود وتنبيهات الصلاحية</h3>
      <div className="grid-form">
        <label>بداية باركود الميزان<input value={s.scale_prefix} onChange={(e) => set("scale_prefix", e.target.value)} /></label>
        <label>طول رقم الصنف (PLU)<input type="number" min="3" max="7" value={s.scale_plu_len} onChange={(e) => set("scale_plu_len", e.target.value)} /></label>
        <label>الباركود بيحمل<select value={s.scale_mode} onChange={(e) => set("scale_mode", e.target.value)}><option value="weight">الوزن (بالجرام)</option><option value="price">السعر</option></select></label>
        <label>نبّهني قبل الصلاحية بـ (يوم)<input type="number" min="1" value={s.expiry_alert_days} onChange={(e) => set("expiry_alert_days", e.target.value)} /></label>
      </div>
      <button className="primary" onClick={() => api.saveSettings(s).then(() => { toast.ok("اتحفظ ✔"); onChange(); }).catch((e) => toast.fail(errMsg(e)))}>حفظ</button>
    </div>
  );
}

function Users({ b, onChange, toast }: { b: Bootstrap; onChange: () => void; toast: T }) {
  const [name, setName] = useState(""); const [role, setRole] = useState<Role>("cashier"); const [pin, setPin] = useState("");
  const run = (p: Promise<unknown>, ok: string) => p.then(() => { toast.ok(ok); onChange(); }).catch((e) => toast.fail(errMsg(e)));
  return (
    <div className="card wide">
      <h2>المستخدمين</h2>
      <table className="t"><tbody>
        {b.users.map((u) => (
          <tr key={u.id}><td>{u.name}</td><td>{ROLE[u.role]}</td>
            <td><div className="row"><button onClick={() => { const p = prompt("PIN جديد (4 إلى 8 أرقام)"); if (p) run(api.resetPin(u.id, p), "اتغيّر الـ PIN"); }}>تغيير PIN</button>
              {u.id !== b.user?.id && <button onClick={() => confirm(`إيقاف ${u.name}؟`) && run(api.setUserActive(u.id, false), "اتوقف المستخدم")}>إيقاف</button>}</div></td></tr>
        ))}
      </tbody></table>
      <h3>مستخدم جديد</h3>
      <div className="row">
        <label className="grow">الاسم<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>الصلاحية<select value={role} onChange={(e) => setRole(e.target.value as Role)}><option value="cashier">كاشير</option><option value="manager">مدير</option><option value="owner">مالك</option></select></label>
        <label>PIN<input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} /></label>
      </div>
      <button className="primary" disabled={!name || !pin} onClick={() => run(api.addUser(name, role, pin).then(() => { setName(""); setPin(""); }), "اتضاف المستخدم")}>إضافة</button>
    </div>
  );
}

function Backups({ owner, toast }: { owner: boolean; toast: T }) {
  return (
    <div className="card wide">
      <h2>النسخ الاحتياطي</h2>
      <p>البرنامج بياخد نسخة تلقائية كل يوم وعند إقفال أي وردية. احتفظ بنسخة على فلاشة أو جهاز تاني تحسبًا لتلف الجهاز.</p>
      <div className="row">
        <button onClick={() => api.backupNow().then((f) => toast.ok(`اتعملت نسخة: ${f}`)).catch((e) => toast.fail(errMsg(e)))}>نسخة احتياطية الآن</button>
        {owner && <button onClick={() => api.backupExport().then((f) => f && toast.ok(`اتحفظت في: ${f}`)).catch((e) => toast.fail(errMsg(e)))}>حفظ نسخة على فلاشة / فولدر</button>}
        {owner && <button className="danger" onClick={() => confirm("الاستعادة هتستبدل كل بيانات البرنامج الحالية بالنسخة اللي هتختارها، وهيتقفل البرنامج ويفتح تاني. متأكد؟") && api.restoreBackup().catch((e) => toast.fail(errMsg(e)))}>استعادة من نسخة</button>}
      </div>
    </div>
  );
}

function Cloud({ owner, toast }: { owner: boolean; toast: T }) {
  const [st, setSt] = useState<CloudStatus | null>(null);
  const [email, setEmail] = useState(""); const [pw, setPw] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { api.cloudStatus().then(setSt).catch(() => {}); }, []);
  const run = (p: Promise<CloudStatus>, ok: string) => { setBusy(true); p.then((s) => { setSt(s); toast.ok(ok); }).catch((e) => { toast.fail(errMsg(e)); api.cloudStatus().then(setSt); }).finally(() => setBusy(false)); };
  if (!st) return null;
  return (
    <div className="card wide">
      <h2>متابعة المبيعات من الموبايل</h2>
      {!st.configured ? <p className="muted">الخدمة دي مش مفعّلة في النسخة دي.</p> : st.linked ? (
        <>
          <p>مربوط بحساب: <b>{st.email}</b></p>
          <p>{st.lastSync ? <>آخر مزامنة: {dateTimeAr(st.lastSync)} ({ago(st.lastSync)})</> : "لسه ما اتبعتش بيانات"}</p>
          {st.lastError && <div className="error">آخر خطأ: {st.lastError}</div>}
          <div className="row"><button className="primary" disabled={busy} onClick={() => run(api.cloudSyncNow(), "اتبعتت البيانات")}>مزامنة الآن</button>
            {owner && <button disabled={busy} onClick={() => confirm("فك الربط؟") && run(api.cloudUnlink(), "اتفك الربط")}>فك الربط</button>}</div>
          <p className="muted">البيانات بتتبعت لوحدها كل 15 دقيقة لما يكون فيه إنترنت. لو النت قطع البرنامج بيكمل شغل عادي.</p>
        </>
      ) : owner ? (
        <>
          <p>سجّل بنفس الإيميل والباسورد اللي بتدخل بيهم على موقع المتابعة. الباسورد مش بيتخزّن في البرنامج.</p>
          <div className="row"><label className="grow">الإيميل<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="grow">الباسورد<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></label></div>
          <button className="primary" disabled={busy || !email || !pw} onClick={() => run(api.cloudLink(email, pw), "تم الربط ✔")}>ربط الحساب</button>
        </>
      ) : <p className="muted">المالك بس يقدر يربط الحساب.</p>}
    </div>
  );
}

function License({ b, owner, onChange, toast }: { b: Bootstrap; owner: boolean; onChange: () => void; toast: T }) {
  const [key, setKey] = useState("");
  const lic = b.license;
  return (
    <div className="card wide">
      <h2>التفعيل والدعم</h2>
      <p>كود الجهاز: <code>{b.deviceCode}</code></p>
      <p>
        {lic.mode === "licensed" && <>مفعّل لـ <b>{lic.payload.customer}</b> — باقي {lic.daysLeft} يوم</>}
        {lic.mode === "trial" && <>نسخة تجريبية — باقي {lic.daysLeft} يوم</>}
        {lic.mode === "readonly" && <>الترخيص غير صالح ({lic.reason})</>}
      </p>
      {owner && <>
        <label>مفتاح التفعيل<textarea rows={3} value={key} onChange={(e) => setKey(e.target.value)} /></label>
        <button className="primary" disabled={!key.trim()} onClick={() => api.activate(key).then(() => { toast.ok("تم التفعيل ✔"); setKey(""); onChange(); }).catch((e) => toast.fail(errMsg(e)))}>تفعيل</button>
      </>}
      <SupportButton label="💬 تواصل مع الدعم على واتساب" />
    </div>
  );
}
