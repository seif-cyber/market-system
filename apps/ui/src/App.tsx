import { useCallback, useEffect, useState } from "react";
import type { Bootstrap } from "@market/core";
import { api, errMsg } from "./api";
import { Login, Setup } from "./pages/Login";
import { Pos } from "./pages/Pos";
import { Settings } from "./pages/Settings";
import { Products } from "./pages/Products";

type Tab = "pos" | "products" | "settings";

export function App() {
  const [b, setB] = useState<Bootstrap | null>(null);
  const [tab, setTab] = useState<Tab>("pos");
  const [err, setErr] = useState("");

  const reload = useCallback(() => api.bootstrap().then(setB).catch((e) => setErr(errMsg(e))), []);
  useEffect(() => { reload(); }, [reload]);

  if (err) return <div className="center"><div className="card error">{err}</div></div>;
  if (!b) return <div className="center">...</div>;
  if (b.needsSetup) return <Setup onDone={reload} />;
  if (!b.user) return <Login b={b} onDone={reload} />;

  const manager = b.user.role !== "cashier";
  const lic = b.license;
  return (
    <div className="app">
      <header>
        <div className="brand">{b.brand.logo && <img src={b.brand.logo} alt="" />}<b>{b.brand.brand_name}</b></div>
        <nav>
          <button className={tab === "pos" ? "on" : ""} onClick={() => setTab("pos")}>البيع</button>
          {manager && <button className={tab === "products" ? "on" : ""} onClick={() => setTab("products")}>المنتجات</button>}
          {manager && <button className={tab === "settings" ? "on" : ""} onClick={() => setTab("settings")}>الإعدادات</button>}
        </nav>
        <div className="who">
          {lic.mode === "trial" && <span className="pill warn">تجربة: باقي {lic.daysLeft} يوم</span>}
          {lic.mode === "readonly" && <span className="pill bad">الترخيص منتهي: البيع موقوف</span>}
          <span>{b.user.name}</span>
          <button onClick={() => api.logout().then(reload)}>خروج</button>
        </div>
      </header>
      <main>
        {tab === "pos" && <Pos b={b} />}
        {tab === "products" && manager && <Products />}
        {tab === "settings" && manager && <Settings b={b} onChange={reload} />}
      </main>
    </div>
  );
}
