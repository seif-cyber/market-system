import { useState } from "react";
import { SUPPORT_CONTACTS, whatsappUrl } from "@market/core/src/support";

/** WhatsApp support: both engineers, primary first. Plain links, so they work in the installed app too. */
export function Support({ floating, shop }: { floating?: boolean; shop?: string }) {
  const [open, setOpen] = useState(false);
  const text = `السلام عليكم، محتاج مساعدة في موقع متابعة المبيعات${shop ? `\nالمحل: ${shop}` : ""}`;
  return (
    <div className={floating ? "support floating" : "support"}>
      {open && (
        <div className="support-pop" role="dialog" aria-label="الدعم الفني">
          <b>الدعم الفني على واتساب</b>
          {SUPPORT_CONTACTS.map((c) => (
            <a key={c.id} className="wa-link" href={whatsappUrl(text, c.phone)} target="_blank" rel="noreferrer noopener">
              <span>💬 {c.name}</span><small>{c.role}</small>
            </a>
          ))}
        </div>
      )}
      <button className="wa fab" onClick={() => setOpen(!open)} aria-expanded={open}>💬 الدعم</button>
    </div>
  );
}
