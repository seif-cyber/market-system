import { useState } from "react";
import type { Backend, CloudUser } from "./backend";

/** Emails allowed to see the license console. Real protection is the private key, which never leaves this browser. */
export const ADMIN_EMAILS = ["khoz3a@k.com"];
const KEY = "license-private-pem";

const b64u = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ""; u.forEach((c) => (s += String.fromCharCode(c)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const utf8 = (s: string) => new TextEncoder().encode(s);

async function signToken(pem: string, payload: object): Promise<string> {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  const body = b64u(utf8(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, utf8(body));
  return `${body}.${b64u(sig)}`;
}

const load = () => { try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; } };

export function Admin({ be, user, onBack }: { be: Backend; user: CloudUser; onBack: () => void }) {
  const [pem, setPem] = useState(load);
  const [editKey, setEditKey] = useState(!load());
  const [fp, setFp] = useState("");
  const [customer, setCustomer] = useState("");
  const [plan, setPlan] = useState("supermarket");
  const [days, setDays] = useState("365");
  const [out, setOut] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const code = fp.replace(/[^0-9a-fA-F]/g, "").toUpperCase();

  const saveKey = () => {
    if (!/BEGIN PRIVATE KEY/.test(pem)) return setErr("المفتاح لازم يبدأ بـ BEGIN PRIVATE KEY (محتوى ملف keys/private.pem)");
    try { localStorage.setItem(KEY, pem); } catch { /* private mode: key stays in memory */ }
    setErr(""); setEditKey(false);
  };
  const forget = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } setPem(""); setEditKey(true); setOut(""); };
  const issue = async () => {
    setErr(""); setOut(""); setCopied(false);
    if (code.length !== 20) return setErr("كود الجهاز لازم يكون ٢٠ حرف/رقم (من الإعدادات في برنامج الكاشير)");
    if (!customer.trim()) return setErr("اكتب اسم العميل");
    const n = Number(days);
    if (!(n > 0)) return setErr("عدد الأيام غلط");
    try {
      const now = Date.now();
      setOut(await signToken(pem, { fp: code, customer: customer.trim(), plan, exp: now + n * 86_400_000, iat: now }));
    } catch { setErr("فشل التوقيع. المفتاح غلط أو المتصفح قديم (استخدم Chrome/Edge/Safari حديث)."); }
  };
  const copy = () => navigator.clipboard?.writeText(out).then(() => setCopied(true));

  return (
    <div className="center">
      <div className="card">
        <h2>إصدار أكواد التفعيل</h2>
        <p>مسجّل دخول: <b dir="ltr">{user.email}</b></p>
        {editKey ? (
          <>
            <label>المفتاح الخاص (محتوى <code>keys/private.pem</code>)
              <textarea dir="ltr" rows={5} value={pem} onChange={(e) => setPem(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" />
            </label>
            <p className="muted">بيتحفظ في المتصفح ده بس، مش بيترفع لأي سيرفر.</p>
            <button className="primary" onClick={saveKey}>حفظ المفتاح</button>
          </>
        ) : (
          <>
            <label>كود الجهاز
              <input className="codein" dir="ltr" value={fp} onChange={(e) => setFp(e.target.value)} placeholder="XXXXXXXXXXXXXXXXXXXX" autoComplete="off" spellCheck={false} />
            </label>
            <label>اسم العميل<input value={customer} onChange={(e) => setCustomer(e.target.value)} /></label>
            <label>الباقة
              <select value={plan} onChange={(e) => setPlan(e.target.value)}>
                <option value="supermarket">سوبر ماركت</option><option value="restaurant">مطعم</option><option value="both">الاتنين</option>
              </select>
            </label>
            <label>المدة بالأيام<input type="number" min="1" dir="ltr" value={days} onChange={(e) => setDays(e.target.value)} /></label>
            <button className="primary" onClick={issue}>توليد كود التفعيل</button>
            {out && (
              <>
                <textarea readOnly dir="ltr" rows={5} value={out} onFocus={(e) => e.currentTarget.select()} />
                <button onClick={copy}>{copied ? "اتنسخ ✔" : "نسخ الكود"}</button>
              </>
            )}
          </>
        )}
        {err && <div className="error" role="alert">{err}</div>}
        {!editKey && <button type="button" onClick={forget}>تغيير / مسح المفتاح من المتصفح</button>}
        <button type="button" onClick={onBack}>رجوع</button>
        <button type="button" onClick={() => be.logout()}>خروج</button>
      </div>
    </div>
  );
}
