import { useCallback, useEffect, useState } from "react";
import type { Bootstrap } from "@market/core";
import { api, errMsg } from "./api";
import { Login, Setup } from "./pages/Login";
import { Pos } from "./pages/Pos";
import { Dashboard } from "./pages/Dashboard";
import { Inventory } from "./pages/Inventory";
import { Customers } from "./pages/Customers";
import { Expenses } from "./pages/Expenses";
import { Settings } from "./pages/Settings";
import { SupportButton } from "./components/ui";

type Tab = "pos" | "dash" | "inv" | "cust" | "exp" | "set";

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
  const owner = b.user.role === "owner";
  const lic = b.license;
  const tabs: [Tab, string, boolean][] = [
    ["pos", "البيع", true], ["dash", "لوحة التحكم", manager], ["inv", "المخزون", true],
    ["cust", "العملاء", true], ["exp", "المصاريف", manager], ["set", "الإعدادات", manager],
  ];
  const active = tabs.find((t) => t[0] === tab && t[2]) ? tab : "pos";
  return (
    <div className="app">
      {b.demo && (
        <div className="demo-bar">
          <span>🎬 وضع تجريبي: كل البيانات دي وهمية ومش بتأثر على بياناتك الحقيقية</span>
          <button onClick={() => api.exitDemo().then(() => { setTab("pos"); reload(); })}>خروج من الوضع التجريبي</button>
        </div>
      )}
      <header>
        <div className="brand">{b.brand.logo && <img src={b.brand.logo} alt="" />}<b>{b.brand.brand_name}</b></div>
        <nav>{tabs.filter((t) => t[2]).map(([id, label]) => <button key={id} className={active === id ? "on" : ""} onClick={() => setTab(id)}>{label}</button>)}</nav>
        <div className="who">
          {lic.mode === "trial" && <span className="pill warn">تجربة: باقي {lic.daysLeft} يوم</span>}
          {lic.mode === "readonly" && <span className="pill bad">الترخيص منتهي: البيع موقوف</span>}
          <SupportButton />
          <span>{b.user.name}</span>
          <button onClick={() => api.logout().then(reload)}>خروج</button>
        </div>
      </header>
      <main>
        {active === "pos" && <Pos b={b} onChange={reload} />}
        {active === "dash" && <Dashboard />}
        {active === "inv" && <Inventory canEdit={manager} />}
        {active === "cust" && <Customers canManage={manager} />}
        {active === "exp" && <Expenses isOwner={owner} />}
        {active === "set" && <Settings b={b} onChange={reload} />}
      </main>
    </div>
  );
}
