import { initializeApp, type FirebaseOptions } from "firebase/app";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, type Auth } from "firebase/auth";
import {
  collection, doc, initializeFirestore, limit, onSnapshot, orderBy, persistentLocalCache, persistentMultipleTabManager, query, type Firestore,
} from "firebase/firestore";
import type { Backend, SaleRow, ShiftRow, ShopStatus } from "./backend";

const FRIENDLY: Record<string, string> = {
  "auth/invalid-credential": "الإيميل أو الباسورد غلط", "auth/wrong-password": "الباسورد غلط", "auth/user-not-found": "الإيميل ده مش مسجّل",
  "auth/invalid-email": "الإيميل غلط", "auth/too-many-requests": "محاولات كتير، جرّب بعد شوية", "auth/network-request-failed": "مفيش اتصال بالإنترنت",
  "auth/user-disabled": "الحساب موقوف",
};

const parse = <T,>(s: unknown): T | null => { try { return JSON.parse(String(s)) as T; } catch { return null; } };

export function createFirebaseBackend(cfg: FirebaseOptions): Backend {
  const app = initializeApp(cfg);
  const auth: Auth = getAuth(app);
  // IndexedDB cache: the last synced data still opens when the phone is offline.
  const db: Firestore = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  const shop = (uid: string, path: string) => doc(db, "shops", uid, ...path.split("/"));

  return {
    configured: true,
    onAuth: (cb) => onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, email: u.email ?? "" } : null)),
    async login(email, password) {
      try { await signInWithEmailAndPassword(auth, email.trim(), password); }
      catch (e) { throw new Error(FRIENDLY[(e as { code?: string }).code ?? ""] ?? "تعذّر تسجيل الدخول"); }
    },
    logout: () => signOut(auth),
    watchStatus: (uid, cb) => onSnapshot(shop(uid, "meta/status"), (s) => {
      const d = s.data();
      cb(d ? ({ brand: d.brand, syncedAt: Number(d.syncedAt), integrityOk: !!d.integrityOk, lastInvoice: Number(d.lastInvoice) } as ShopStatus) : null);
    }),
    watchReport: (uid, range, cb) => onSnapshot(shop(uid, `reports/${range}`), (s) => cb(s.exists() ? parse(s.data().json) : null)),
    watchSales: (uid, cb) =>
      onSnapshot(query(collection(db, "shops", uid, "sales"), orderBy("no", "desc"), limit(60)), (qs) =>
        cb(qs.docs.map((d) => {
          const x = d.data(); const extra = parse<{ discount: number; items: SaleRow["items"] }>(x.json);
          return { no: Number(x.no), createdAt: Number(x.createdAt), total: Number(x.total), payMethod: x.payMethod, cashier: x.cashier, customer: x.customer, discount: extra?.discount ?? 0, items: extra?.items ?? [] };
        }))),
    watchShifts: (uid, cb) => onSnapshot(shop(uid, "meta/shifts"), (s) => cb(s.exists() ? (parse<ShiftRow[]>(s.data().json) ?? []) : [])),
  };
}
