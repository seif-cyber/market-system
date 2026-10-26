import { useState } from "react";
import type { Backend } from "./backend";
import { Support } from "./Support";

export function Login({ be }: { be: Backend }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const run = (p: Promise<void>, ok?: string) => { setBusy(true); setErr(""); setInfo(""); p.then(() => ok && setInfo(ok)).catch((x) => setErr(x.message)).finally(() => setBusy(false)); };
  return (
    <div className="center">
      <div className="card">
        <img className="logo" src="/icon.svg" alt="" width={72} height={72} />
        <h2 style={{ textAlign: "center" }}>متابعة المبيعات</h2>
        <p className="muted" style={{ textAlign: "center" }}>سجّل دخول بحسابك كصاحب محل عشان تتابع مبيعاتك وأرباحك.</p>

        <button className="google" disabled={busy} onClick={() => run(be.signInGoogle())}>
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"/><path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>
          الدخول بحساب جوجل
        </button>
        <div className="or"><span>أو بالإيميل</span></div>

        <div className="tabs seg">
          <button className={mode === "in" ? "on" : ""} onClick={() => { setMode("in"); setErr(""); }}>دخول</button>
          <button className={mode === "up" ? "on" : ""} onClick={() => { setMode("up"); setErr(""); }}>حساب جديد</button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); run(mode === "in" ? be.signInEmail(email, pw) : be.signUpEmail(email, pw)); }}>
          <label>الإيميل<input type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required dir="ltr" /></label>
          <label>الباسورد<input type="password" autoComplete={mode === "in" ? "current-password" : "new-password"} value={pw} onChange={(e) => setPw(e.target.value)} required minLength={6} dir="ltr" /></label>
          {err && <div className="error" role="alert">{err}</div>}
          {info && <div className="note" role="status">{info}</div>}
          <button className="primary" disabled={busy}>{busy ? "..." : mode === "in" ? "دخول" : "إنشاء الحساب"}</button>
        </form>
        {mode === "in" && <button className="link" disabled={busy || !email} onClick={() => run(be.resetPassword(email), "بعتنالك رسالة على الإيميل لتغيير الباسورد")}>نسيت الباسورد؟</button>}
        <p className="muted small">بعد الدخول هتربط محلك بكود بيظهر في برنامج الكاشير (للمالك بس).</p>
      </div>
      <Support floating />
    </div>
  );
}
