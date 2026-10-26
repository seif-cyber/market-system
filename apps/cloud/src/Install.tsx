import { useEffect, useState } from "react";

interface BIPEvent extends Event { prompt(): Promise<void> }

/** "Install on your phone" helper: native prompt on Android/Chrome, instructions on iPhone. */
export function Install() {
  const [ev, setEv] = useState<BIPEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem("hide-install") === "1"; } catch { return false; } });
  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone;
    if (standalone) { setHidden(true); return; }
    setIos(/iphone|ipad|ipod/i.test(navigator.userAgent));
    const h = (e: Event) => { e.preventDefault(); setEv(e as BIPEvent); };
    window.addEventListener("beforeinstallprompt", h);
    return () => window.removeEventListener("beforeinstallprompt", h);
  }, []);
  if (hidden || (!ev && !ios)) return null;
  const close = () => { setHidden(true); try { localStorage.setItem("hide-install", "1"); } catch { /* private mode */ } };
  return (
    <div className="install" role="note">
      <span>📲 {ev ? "ثبّت الموقع على موبايلك زي أي تطبيق" : "عشان تثبّته على الآيفون: اضغط زر المشاركة ثم «إضافة إلى الشاشة الرئيسية»"}</span>
      <div className="row">{ev && <button className="primary" onClick={() => ev.prompt().then(close)}>تثبيت</button>}<button onClick={close}>مش دلوقتي</button></div>
    </div>
  );
}
