import { useEffect, useState } from "react";
import type { Backend, CloudUser, ShopRef } from "./backend";
import { createFirebaseBackend } from "./firebaseBackend";
import { createMockBackend } from "./mockBackend";
import { Login } from "./Login";
import { Home } from "./Home";
import { Admin, ADMIN_EMAILS } from "./Admin";
import { LinkShop, takePendingCode } from "./LinkShop";

async function loadBackend(): Promise<Backend | null> {
  if (import.meta.env.MODE === "mock") return createMockBackend();
  try {
    const cfg = await (await fetch("/firebase-config.json", { cache: "no-store" })).json();
    if (!cfg.apiKey || !cfg.projectId) return null;
    return createFirebaseBackend(cfg);
  } catch { return null; }
}

const Spinner = () => <div className="center"><div className="spinner" aria-label="جاري التحميل" /></div>;

export function App() {
  const [be, setBe] = useState<Backend | null | undefined>(undefined);
  const [user, setUser] = useState<CloudUser | null | undefined>(undefined);
  const [shops, setShops] = useState<ShopRef[] | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [active, setActive] = useState<string>(() => { try { return localStorage.getItem("active-shop") ?? ""; } catch { return ""; } });

  useEffect(() => { takePendingCode(); loadBackend().then(setBe); }, []);
  useEffect(() => (be ? be.onAuth(setUser) : undefined), [be]);
  useEffect(() => { setShops(undefined); return be && user ? be.watchShops(user.uid, setShops) : undefined; }, [be, user]);
  const [hash, setHash] = useState(location.hash);
  useEffect(() => { const f = () => setHash(location.hash); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  const pick = (id: string) => { setActive(id); setAdding(false); try { localStorage.setItem("active-shop", id); } catch { /* private mode */ } };

  if (be === undefined || (be && user === undefined)) return <Spinner />;
  if (be === null) return (
    <div className="center"><div className="card"><h2>الموقع لسه متظبطش</h2><p>ملف <code>firebase-config.json</code> ناقص <code>apiKey</code>. املاه ببيانات مشروع Firebase وارفع الموقع تاني.</p></div></div>
  );
  if (!user) return <Login be={be} />;
  const isAdmin = ADMIN_EMAILS.includes(user.email.toLowerCase());
  if (isAdmin && hash === "#/admin") return <Admin be={be} user={user} onBack={() => { location.hash = ""; }} />;
  if (shops === undefined) return <Spinner />;
  if (shops.length === 0 || adding) return <LinkShop be={be} user={user} first={shops.length === 0} onLinked={pick} onCancel={shops.length ? () => setAdding(false) : undefined} />;
  const shopId = shops.some((s) => s.id === active) ? active : shops[0].id;
  return <Home be={be} user={user} shops={shops} shopId={shopId} onPick={pick} onAdd={() => setAdding(true)} isAdmin={isAdmin} />;
}
