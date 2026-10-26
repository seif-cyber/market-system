import { useState } from "react";
import type { Backend } from "./backend";
import { Support } from "./Support";

export function Login({ be }: { be: Backend }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="center">
      <form className="card" onSubmit={(e) => { e.preventDefault(); setBusy(true); setErr(""); be.login(email, pw).catch((x) => setErr(x.message)).finally(() => setBusy(false)); }}>
        <img className="logo" src="/icon.svg" alt="" width={72} height={72} />
        <h2 style={{ textAlign: "center" }}>متابعة المبيعات</h2>
        <p className="muted" style={{ textAlign: "center" }}>سجّل دخول بحساب المحل عشان تشوف مبيعاتك وأرباحك.</p>
        <label>الإيميل<input type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required dir="ltr" /></label>
        <label>الباسورد<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required dir="ltr" /></label>
        {err && <div className="error" role="alert">{err}</div>}
        <button className="primary" disabled={busy}>{busy ? "جاري الدخول..." : "دخول"}</button>
        <p className="muted small">لو معندكش حساب أو نسيت الباسورد، كلّم الدعم على واتساب.</p>
      </form>
      <Support floating />
    </div>
  );
}
