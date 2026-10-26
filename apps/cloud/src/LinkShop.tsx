import { useEffect, useRef, useState } from "react";
import type { Backend, CloudUser } from "./backend";
import { Support } from "./Support";

/** Where the code comes from: the shop's QR opens the site with ?link=CODE; it survives the sign-in redirect. */
export function takePendingCode(): string {
  try {
    const fromUrl = new URLSearchParams(location.search).get("link");
    if (fromUrl) { sessionStorage.setItem("pending-link", fromUrl); history.replaceState(null, "", location.pathname); }
    return sessionStorage.getItem("pending-link") ?? "";
  } catch { return ""; }
}

export function LinkShop({ be, user, first, onLinked, onCancel }: { be: Backend; user: CloudUser; first: boolean; onLinked: (shopId: string) => void; onCancel?: () => void }) {
  const [code, setCode] = useState(() => takePendingCode());
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const tried = useRef(false);
  const submit = (c = code) => {
    setBusy(true); setErr("");
    be.linkShop(user, c).then((id) => { try { sessionStorage.removeItem("pending-link"); } catch { /* private mode */ } onLinked(id); }).catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };
  // Opened from the shop's QR: link right away.
  useEffect(() => { if (code && !tried.current && code.replace(/[^A-Za-z0-9]/g, "").length === 10) { tried.current = true; submit(code); } }, []); // eslint-disable-line
  return (
    <div className="center">
      <form className="card" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h2>{first ? "اربط محلك" : "ربط محل جديد"}</h2>
        <p>اتفضل <b dir="ltr">{user.email}</b>. عشان تتابع محلك:</p>
        <ol className="steps">
          <li>افتح برنامج الكاشير على جهاز المحل بحساب <b>المالك</b>.</li>
          <li>من <b>الإعدادات</b> اختار «ربط حساب المالك بالموبايل».</li>
          <li>اكتب الكود اللي هيظهر هنا (أو امسح الـ QR بكاميرا الموبايل).</li>
        </ol>
        <label>كود الربط
          <input className="codein" autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXXX-XXXXX" dir="ltr" autoComplete="off" autoCapitalize="characters" spellCheck={false} />
        </label>
        {err && <div className="error" role="alert">{err}</div>}
        <button className="primary" disabled={busy || code.replace(/[^A-Za-z0-9]/g, "").length < 10}>{busy ? "جاري الربط..." : "ربط المحل"}</button>
        {onCancel && <button type="button" onClick={onCancel}>رجوع</button>}
        <button type="button" className="link" onClick={() => be.logout()}>خروج من الحساب</button>
        <p className="muted small">الكود صالح 15 دقيقة، والمحل بيتربط بحساب مالك واحد بس.</p>
      </form>
      <Support floating />
    </div>
  );
}
