import { initializeApp, type FirebaseOptions } from "firebase/app";
import {
  createUserWithEmailAndPassword, getAuth, GoogleAuthProvider, onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword,
  signInWithPopup, signInWithRedirect, signOut, type Auth,
} from "firebase/auth";
import {
  collection, doc, getDoc, initializeFirestore, limit, onSnapshot, orderBy, persistentLocalCache, persistentMultipleTabManager, query, writeBatch, type Firestore,
} from "firebase/firestore";
import type { Backend, SaleRow, ShiftRow, ShopRef, ShopStatus, SuppliersDoc, TreasuryDoc } from "./backend";

const FRIENDLY: Record<string, string> = {
  "auth/invalid-credential": "الإيميل أو الباسورد غلط", "auth/wrong-password": "الباسورد غلط", "auth/user-not-found": "الإيميل ده مش مسجّل",
  "auth/invalid-email": "الإيميل غلط", "auth/too-many-requests": "محاولات كتير، جرّب بعد شوية", "auth/network-request-failed": "مفيش اتصال بالإنترنت",
  "auth/user-disabled": "الحساب موقوف", "auth/email-already-in-use": "الإيميل ده مسجّل قبل كده، سجّل دخول", "auth/weak-password": "الباسورد ضعيف (6 حروف على الأقل)",
  "auth/popup-closed-by-user": "اتقفل شباك الدخول قبل ما يخلص", "auth/cancelled-popup-request": "اتقفل شباك الدخول قبل ما يخلص",
  "auth/operation-not-allowed": "طريقة الدخول دي مش مفعّلة في Firebase", "auth/unauthorized-domain": "الدومين ده مش مضاف في Firebase (Authorized domains)",
};
const say = (e: unknown, fallback: string) => FRIENDLY[(e as { code?: string }).code ?? ""] ?? fallback;
const parse = <T,>(s: unknown): T | null => { try { return JSON.parse(String(s)) as T; } catch { return null; } };

export function createFirebaseBackend(cfg: FirebaseOptions): Backend {
  const app = initializeApp(cfg);
  const auth: Auth = getAuth(app);
  auth.languageCode = "ar";
  // IndexedDB cache: the last synced data still opens when the phone is offline.
  const db: Firestore = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  const shop = (id: string, path: string) => doc(db, "shops", id, ...path.split("/"));
  const docJson = <T,>(id: string, path: string, cb: (v: T | null) => void) => onSnapshot(shop(id, path), (s) => cb(s.exists() ? parse<T>(s.data().json) : null), () => cb(null));

  return {
    configured: true,
    onAuth: (cb) => onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, email: u.email ?? "", name: u.displayName ?? "" } : null)),
    async signInGoogle() {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      try { await signInWithPopup(auth, provider); }
      catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") { await signInWithRedirect(auth, provider); return; }  // some phones / installed apps block popups
        throw new Error(say(e, "تعذّر الدخول بجوجل"));
      }
    },
    async signInEmail(email, password) {
      try { await signInWithEmailAndPassword(auth, email.trim(), password); } catch (e) { throw new Error(say(e, "تعذّر تسجيل الدخول")); }
    },
    async signUpEmail(email, password) {
      try { await createUserWithEmailAndPassword(auth, email.trim(), password); } catch (e) { throw new Error(say(e, "تعذّر إنشاء الحساب")); }
    },
    async resetPassword(email) {
      try { await sendPasswordResetEmail(auth, email.trim()); } catch (e) { throw new Error(say(e, "تعذّر إرسال رسالة الاسترجاع")); }
    },
    logout: () => signOut(auth),

    watchShops: (uid, cb) => onSnapshot(collection(db, "users", uid, "shops"), (qs) => cb(qs.docs.map((d) => ({ id: d.id, linkedAt: Number(d.data().linkedAt) || 0 }) as ShopRef).sort((a, b) => a.linkedAt - b.linkedAt)), () => cb([])),

    async linkShop(user, rawCode) {
      const code = rawCode.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (code.length !== 10) throw new Error("الكود لازم يكون 10 حروف وأرقام");
      let pairing;
      try { pairing = await getDoc(doc(db, "pairings", code)); } catch (e) { throw new Error(say(e, "تعذّر التحقق من الكود")); }
      if (!pairing.exists()) throw new Error("الكود غلط أو انتهى. اطلب كود جديد من برنامج الكاشير.");
      const { deviceUid, expiresAt } = pairing.data() as { deviceUid: string; expiresAt: number };
      if (Number(expiresAt) < Date.now()) throw new Error("الكود انتهى (صالح 15 دقيقة). اطلب كود جديد من برنامج الكاشير.");
      const b = writeBatch(db);
      b.set(shop(deviceUid, "meta/owner"), { uid: user.uid, email: user.email, name: user.name, code, linkedAt: Date.now() });
      b.set(doc(db, "users", user.uid, "shops", deviceUid), { linkedAt: Date.now() });
      try { await b.commit(); }
      catch { throw new Error("المحل ده مربوط بحساب تاني (فك الربط من برنامج الكاشير الأول)، أو الكود انتهى."); }
      return deviceUid;
    },
    async unlinkShop(uid, shopId) {
      const b = writeBatch(db);
      b.delete(shop(shopId, "meta/owner"));
      b.delete(doc(db, "users", uid, "shops", shopId));
      await b.commit();
    },

    watchStatus: (id, cb) => onSnapshot(shop(id, "meta/status"), (s) => {
      const d = s.data();
      cb(d ? ({ brand: d.brand, syncedAt: Number(d.syncedAt), integrityOk: !!d.integrityOk, lastInvoice: Number(d.lastInvoice) } as ShopStatus) : null);
    }, () => cb(null)),
    watchReport: (id, range, cb) => docJson(id, `reports/${range}`, cb),
    watchSales: (id, cb) =>
      onSnapshot(query(collection(db, "shops", id, "sales"), orderBy("no", "desc"), limit(60)), (qs) =>
        cb(qs.docs.map((d) => {
          const x = d.data(); const extra = parse<{ discount: number; items: SaleRow["items"] }>(x.json);
          return { no: Number(x.no), createdAt: Number(x.createdAt), total: Number(x.total), payMethod: x.payMethod, cashier: x.cashier, customer: x.customer, discount: extra?.discount ?? 0, items: extra?.items ?? [] };
        })), () => cb([])),
    watchShifts: (id, cb) => onSnapshot(shop(id, "meta/shifts"), (s) => cb(s.exists() ? (parse<ShiftRow[]>(s.data().json) ?? []) : []), () => cb([])),
    watchTreasury: (id, cb) => docJson<TreasuryDoc>(id, "meta/treasury", cb),
    watchSuppliers: (id, cb) => docJson<SuppliersDoc>(id, "meta/suppliers", cb),
  };
}
