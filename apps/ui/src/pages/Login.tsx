import { useState } from "react";
import type { Bootstrap } from "@market/core";
import { api, errMsg } from "../api";
import { SupportButton } from "../components/ui";

function Extras({ onDone }: { onDone: () => void }) {
  return (
    <div className="extras">
      <button className="link" onClick={() => api.enterDemo().then(onDone)}>▶ جرّب النظام ببيانات تجريبية</button>
      <SupportButton label="💬 الدعم الفني على واتساب" />
    </div>
  );
}

export function Setup({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  return (
    <div className="center">
      <form className="card" onSubmit={(e) => { e.preventDefault(); api.setupOwner(name, pin).then(onDone).catch((x) => setErr(errMsg(x))); }}>
        <img className="logo" src="./icon.svg" alt="" width={84} height={84} />
        <h2>إعداد أول مرة</h2>
        <p>اعمل حساب المالك. الـ PIN من 4 لـ 8 أرقام.</p>
        <label>اسم المالك<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>PIN<input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} required /></label>
        {err && <div className="error">{err}</div>}
        <button className="primary">ابدأ</button>
        <Extras onDone={onDone} />
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
        <img className="logo" src={b.brand.logo || "./icon.svg"} alt="" width={b.brand.logo ? undefined : 84} height={b.brand.logo ? undefined : 84} />
        <h2>{b.brand.brand_name}</h2>
        <label>المستخدم
          <select value={uid} onChange={(e) => setUid(+e.target.value)}>{b.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
        </label>
        <label>PIN<input autoFocus type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} /></label>
        {err && <div className="error">{err}</div>}
        <button className="primary">دخول</button>
        <Extras onDone={onDone} />
      </form>
    </div>
  );
}
