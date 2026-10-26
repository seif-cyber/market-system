import { useEffect, useState } from "react";
import type { Approval, Bootstrap } from "@market/core";
import { SUPPORT_CONTACTS } from "@market/core/src/support";
import { api } from "../api";

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-label={title}>
        <header><h2>{title}</h2><button onClick={onClose} aria-label="إغلاق">✕</button></header>
        {children}
      </div>
    </div>
  );
}

/** Cashiers must have a manager type their PIN; managers/owners approve themselves. */
export function ApprovalFields({ b, value, onChange }: { b: Bootstrap; value: Approval | null; onChange: (a: Approval | null) => void }) {
  const managers = b.users.filter((u) => u.role !== "cashier");
  if (b.user?.role !== "cashier") return null;
  const uid = value?.userId ?? managers[0]?.id ?? 0;
  return (
    <div className="approval">
      <b>محتاج اعتماد المدير</b>
      <div className="row">
        <select value={uid} onChange={(e) => onChange({ userId: +e.target.value, pin: value?.pin ?? "" })}>{managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
        <input type="password" inputMode="numeric" placeholder="PIN المدير" value={value?.pin ?? ""} onChange={(e) => onChange({ userId: uid, pin: e.target.value })} />
      </div>
    </div>
  );
}

export function useToast() {
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  useEffect(() => { if (msg) { const t = setTimeout(() => setMsg(null), 5000); return () => clearTimeout(t); } }, [msg]);
  return { msg, ok: (text: string) => setMsg({ text, bad: false }), fail: (text: string) => setMsg({ text, bad: true }) };
}

export const Toast = ({ msg }: { msg: { text: string; bad: boolean } | null }) => (msg ? <div className={`toast ${msg.bad ? "bad" : ""}`} role="status">{msg.text}</div> : null);

/** Opens WhatsApp (through the main process) to one of the support engineers. */
export function SupportDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="الدعم الفني على واتساب" onClose={onClose}>
      <p className="muted">هتفتح محادثة واتساب ومعاها اسم المحل وكود الجهاز، فنقدر نساعدك أسرع.</p>
      <div className="pick">
        {SUPPORT_CONTACTS.map((c) => (
          <button key={c.id} className="wa-pick" onClick={() => { api.contactSupport(c.id).catch(() => {}); onClose(); }}>
            <span>💬 {c.name}</span><small>{c.role}</small>
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function SupportButton({ label = "💬 الدعم" }: { label?: string }) {
  const [open, setOpen] = useState(false);
  return (<><button className="wa" onClick={() => setOpen(true)} title="الدعم الفني على واتساب">{label}</button>{open && <SupportDialog onClose={() => setOpen(false)} />}</>);
}
