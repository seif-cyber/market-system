import { useEffect, useState } from "react";
import type { Backend, CloudUser } from "./backend";
import { createFirebaseBackend } from "./firebaseBackend";
import { createMockBackend } from "./mockBackend";
import { Login } from "./Login";
import { Home } from "./Home";

async function loadBackend(): Promise<Backend | null> {
  if (import.meta.env.MODE === "mock") return createMockBackend();
  try {
    const cfg = await (await fetch("/firebase-config.json", { cache: "no-store" })).json();
    if (!cfg.apiKey || !cfg.projectId) return null;
    return createFirebaseBackend(cfg);
  } catch { return null; }
}

export function App() {
  const [be, setBe] = useState<Backend | null | undefined>(undefined);
  const [user, setUser] = useState<CloudUser | null | undefined>(undefined);

  useEffect(() => { loadBackend().then(setBe); }, []);
  useEffect(() => (be ? be.onAuth(setUser) : undefined), [be]);

  if (be === undefined || (be && user === undefined)) return <div className="center"><div className="spinner" aria-label="جاري التحميل" /></div>;
  if (be === null) return (
    <div className="center"><div className="card"><h2>الموقع لسه متظبطش</h2><p>ملف <code>firebase-config.json</code> فاضي. املاه ببيانات مشروع Firebase وارفع الموقع تاني.</p></div></div>
  );
  if (!user) return <Login be={be} />;
  return <Home be={be} user={user} />;
}
