import { useEffect, useState } from "react";
import type { Analytics, RangePreset } from "@market/core";
import { api, errMsg } from "../api";
import { DashboardView } from "../components/DashboardView";

export function Dashboard() {
  const [range, setRange] = useState<RangePreset>("today");
  const [a, setA] = useState<Analytics | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { setErr(""); api.analytics(range).then(setA).catch((e) => setErr(errMsg(e))); }, [range]);
  if (err) return <div className="error">{err}</div>;
  if (!a) return <div className="muted">...</div>;
  return <DashboardView a={a} range={range} onRange={setRange} />;
}
