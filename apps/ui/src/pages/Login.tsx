import { useState } from "react";
import type { Bootstrap } from "@market/core";
import { api, errMsg } from "../api";

export function Setup({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  return (
    <div className="center">
      <form className="card" onSubmit={(e) => { e.preventDefault(); api.setupOwner(name, pin).then(onDone).catch((x) => setErr(errMsg(x))); }}>
        <h2>إعداد أول مرة</h2>
        <p>اعمل حساب المالك. الـ PIN من 4 لـ 8 أرقام.</p>
        <label>اسم المالك<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>PIN<input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} required /></label>
        {err && <div className="error">{err}</div>}
        <button className="primary">ابدأ</button>
      </form>
    </div>
  );
}

export function Login({ b, onDone }: { b: Bootstrap; onDone: () => void }) {
  const [uid, setUid] = useState(b.users[0]?.id ?? 0);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  return (
    <div className="center">
      <form className="card" onSubmit={(e) => { e.preventDefault(); api.login(uid, pin).then(onDone).catch((x) => { setErr(errMsg(x)); setPin(""); }); }}>
        {b.brand.logo && <img className="logo" src={b.brand.logo} alt="" />}
        <h2>{b.brand.brand_name}</h2>
        <label>المستخدم
          <select value={uid} onChange={(e) => setUid(+e.target.value)}>{b.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
        </label>
        <label>PIN<input autoFocus type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} /></label>
        {err && <div className="error">{err}</div>}
        <button className="primary">دخول</button>
      </form>
    </div>
  );
}
