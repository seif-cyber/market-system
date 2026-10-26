// Security rules, run against the Firestore emulator:  cd cloud/rules-test && npm install && npm test
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, getDocs, collection, setDoc, writeBatch } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";

const DEV = "DEVICE1", OWNER = "OWNER1", OTHER = "OWNER2", STRANGER = "STRANGER";
let env;
const as = (uid, email) => env.authenticatedContext(uid, email ? { email } : {}).firestore();
const now = () => Date.now();
const ownerDoc = (uid, code) => ({ uid, email: `${uid}@x.com`, name: "المالك", code, linkedAt: now() });

before(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-market", firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8089 } });
});
after(() => env.cleanup());
beforeEach(() => env.clearFirestore());

const seed = (fn) => env.withSecurityRulesDisabled(async (ctx) => fn(ctx.firestore()));
const pair = (code, deviceUid = DEV, expiresAt = now() + 10 * 60_000) => seed((db) => setDoc(doc(db, "pairings", code), { deviceUid, expiresAt, createdAt: now() }));
const link = (uid = OWNER, code = "CODE123456") => seed((db) => setDoc(doc(db, "shops", DEV, "meta", "owner"), ownerDoc(uid, code)));

describe("the shop device", () => {
  it("writes and reads its own area only", async () => {
    const db = as(DEV);
    await assertSucceeds(setDoc(doc(db, "shops", DEV, "reports", "today"), { json: "{}" }));
    await assertSucceeds(getDoc(doc(db, "shops", DEV, "reports", "today")));
    await assertFails(setDoc(doc(db, "shops", "SOMEONE_ELSE", "reports", "today"), { json: "{}" }));
    await assertFails(getDoc(doc(db, "shops", "SOMEONE_ELSE", "reports", "today")));
  });
  it("can create a pairing code for itself, short-lived, and nobody else's", async () => {
    const db = as(DEV);
    await assertSucceeds(setDoc(doc(db, "pairings", "AAAAAAAAAA"), { deviceUid: DEV, expiresAt: now() + 15 * 60_000, createdAt: now() }));
    await assertFails(setDoc(doc(db, "pairings", "BBBBBBBBBB"), { deviceUid: "OTHER_DEVICE", expiresAt: now() + 60_000, createdAt: now() }));
    await assertFails(setDoc(doc(db, "pairings", "CCCCCCCCCC"), { deviceUid: DEV, expiresAt: now() + 3 * 3600_000, createdAt: now() }));   // far-future code
    await assertFails(setDoc(doc(db, "pairings", "DDDDDDDDDD"), { deviceUid: DEV, expiresAt: now() + 60_000, createdAt: now(), extra: 1 }));
  });
  it("can delete its pairing code", async () => {
    await pair("AAAAAAAAAA");
    await assertSucceeds(deleteDoc(doc(as(DEV), "pairings", "AAAAAAAAAA")));
  });
});

describe("pairing codes", () => {
  it("can be read by a signed-in user who knows the code, never listed, never by anonymous visitors", async () => {
    await pair("AAAAAAAAAA");
    await assertSucceeds(getDoc(doc(as(OWNER), "pairings", "AAAAAAAAAA")));
    await assertFails(getDocs(collection(as(OWNER), "pairings")));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "pairings", "AAAAAAAAAA")));
  });
  it("cannot be deleted or changed by a stranger", async () => {
    await pair("AAAAAAAAAA");
    await assertFails(deleteDoc(doc(as(STRANGER), "pairings", "AAAAAAAAAA")));
    await assertFails(setDoc(doc(as(STRANGER), "pairings", "AAAAAAAAAA"), { deviceUid: STRANGER, expiresAt: now() + 1000, createdAt: now() }));
  });
});

describe("linking an owner", () => {
  const claim = (uid, code) => setDoc(doc(as(uid), "shops", DEV, "meta", "owner"), ownerDoc(uid, code));

  it("a signed-in user with a valid code becomes the owner and can then read, but not write, the shop's data", async () => {
    await pair("CODE123456");
    await seed((db) => setDoc(doc(db, "shops", DEV, "reports", "today"), { json: "{}" }));
    await assertFails(getDoc(doc(as(OWNER), "shops", DEV, "reports", "today")));          // not linked yet
    await assertSucceeds(claim(OWNER, "CODE123456"));
    await assertSucceeds(getDoc(doc(as(OWNER), "shops", DEV, "reports", "today")));
    await assertSucceeds(getDocs(collection(as(OWNER), "shops", DEV, "sales")));
    await assertFails(setDoc(doc(as(OWNER), "shops", DEV, "reports", "today"), { json: "hacked" }));
    await assertFails(setDoc(doc(as(OWNER), "shops", DEV, "sales", "1"), { total: 1 }));
  });
  it("rejects a wrong code, an expired code, a code of another shop, and someone else's uid", async () => {
    await pair("CODE123456");
    await assertFails(claim(OWNER, "WRONGCODE00"));
    await pair("OLDCODE000", DEV, now() - 1000);
    await assertFails(claim(OWNER, "OLDCODE000"));
    await pair("OTHERSHOP0", "ANOTHER_DEVICE");
    await assertFails(claim(OWNER, "OTHERSHOP0"));
    await assertFails(setDoc(doc(as(OWNER), "shops", DEV, "meta", "owner"), ownerDoc(STRANGER, "CODE123456")));
    await assertFails(setDoc(doc(as(OWNER), "shops", DEV, "meta", "owner"), { ...ownerDoc(OWNER, "CODE123456"), isAdmin: true }));
    await assertFails(getDoc(doc(as(OWNER), "shops", DEV, "meta", "status")));
  });
  it("a shop has one owner: a second account cannot take it over, even with a valid code", async () => {
    await pair("CODE123456"); await link(OWNER);
    await assertFails(claim(OTHER, "CODE123456"));
    await assertFails(setDoc(doc(as(OTHER), "shops", DEV, "meta", "owner"), ownerDoc(OTHER, "CODE123456")));   // overwrite attempt
    await seed((db) => setDoc(doc(db, "shops", DEV, "reports", "today"), { json: "{}" }));
    await assertFails(getDoc(doc(as(OTHER), "shops", DEV, "reports", "today")));
    await assertFails(getDoc(doc(as(STRANGER), "shops", DEV, "reports", "today")));
  });
  it("the owner doc cannot be edited by the owner, only removed", async () => {
    await link(OWNER);
    await assertFails(setDoc(doc(as(OWNER), "shops", DEV, "meta", "owner"), ownerDoc(OTHER, "CODE123456")));
    await assertSucceeds(deleteDoc(doc(as(OWNER), "shops", DEV, "meta", "owner")));
  });
  it("either side can unlink; afterwards the old owner sees nothing and the code can be used again", async () => {
    await link(OWNER);
    await seed((db) => setDoc(doc(db, "shops", DEV, "reports", "today"), { json: "{}" }));
    await assertSucceeds(deleteDoc(doc(as(DEV), "shops", DEV, "meta", "owner")));                          // shop PC unlinks
    await assertFails(getDoc(doc(as(OWNER), "shops", DEV, "reports", "today")));
    await pair("NEWCODE000");
    await assertSucceeds(claim(OTHER, "NEWCODE000"));                                                       // a different owner can now link
    await assertFails(deleteDoc(doc(as(STRANGER), "shops", DEV, "meta", "owner")));                         // but strangers still cannot remove it
  });
  it("the atomic link (owner doc + own shop list) works in one batch", async () => {
    await pair("CODE123456");
    const db = as(OWNER, "o@x.com");
    const b = writeBatch(db);
    b.set(doc(db, "shops", DEV, "meta", "owner"), ownerDoc(OWNER, "CODE123456"));
    b.set(doc(db, "users", OWNER, "shops", DEV), { linkedAt: now() });
    await assertSucceeds(b.commit());
  });
});

describe("per-user data", () => {
  it("an account can only touch its own shop list", async () => {
    await assertSucceeds(setDoc(doc(as(OWNER), "users", OWNER, "shops", DEV), { linkedAt: 1 }));
    await assertSucceeds(getDocs(collection(as(OWNER), "users", OWNER, "shops")));
    await assertFails(getDocs(collection(as(OTHER), "users", OWNER, "shops")));
    await assertFails(setDoc(doc(as(OTHER), "users", OWNER, "shops", "X"), { linkedAt: 1 }));
  });
  it("everything else is closed", async () => {
    await assertFails(getDoc(doc(as(OWNER), "admin", "x")));
    await assertFails(setDoc(doc(as(OWNER), "anything", "x"), { a: 1 }));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "shops", DEV, "reports", "today")));
  });
});
