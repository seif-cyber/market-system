import { useState } from "react";
import type { Party, PartyInput } from "@market/core";
import { api, errMsg, toPiastres } from "../api";
import { fromPiastres } from "../fmt";
import { Modal } from "./ui";

/** Add / edit a customer, a supplier, or both. */
export function PartyForm({ initial, onClose, onSaved }: { initial: Partial<Party>; onClose: () => void; onSaved: (id: number) => void }) {
  const [f, setF] = useState({
    name: initial.name ?? "", code: initial.code ?? "", phone: initial.phone ?? "", taxNo: initial.taxNo ?? "", address: initial.address ?? "", email: initial.email ?? "", notes: initial.notes ?? "",
    isCustomer: initial.isCustomer ?? true, isSupplier: initial.isSupplier ?? false, limit: fromPiastres(initial.creditLimit ?? 0),
  });
  const [err, setErr] = useState("");
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const save = () => {
    const p: PartyInput = { id: initial.id, name: f.name, code: f.code, phone: f.phone, taxNo: f.taxNo, address: f.address, email: f.email, notes: f.notes, isCustomer: f.isCustomer, isSupplier: f.isSupplier, creditLimit: toPiastres(f.limit) };
    api.saveParty(p).then(onSaved).catch((e) => setErr(errMsg(e)));
  };
  return (
    <Modal title={initial.id ? "تعديل بيانات" : "إضافة عميل / مورد"} onClose={onClose} wide>
      <div className="row"><label className="row"><input type="checkbox" checked={f.isCustomer} onChange={(e) => set("isCustomer", e.target.checked)} /> عميل</label>
        <label className="row"><input type="checkbox" checked={f.isSupplier} onChange={(e) => set("isSupplier", e.target.checked)} /> مورد</label></div>
      <div className="grid-form">
        <label>الاسم<input autoFocus value={f.name} onChange={(e) => set("name", e.target.value)} /></label>
        <label>الكود<input value={f.code} onChange={(e) => set("code", e.target.value)} /></label>
        <label>التليفون<input value={f.phone} onChange={(e) => set("phone", e.target.value)} /></label>
        <label>الرقم الضريبي<input value={f.taxNo} onChange={(e) => set("taxNo", e.target.value)} /></label>
        <label>العنوان<input value={f.address} onChange={(e) => set("address", e.target.value)} /></label>
        <label>الإيميل<input value={f.email} onChange={(e) => set("email", e.target.value)} dir="ltr" /></label>
        {f.isCustomer && <label>حد الآجل (جنيه) — 0 يعني ممنوع الآجل<input type="number" min="0" value={f.limit} onChange={(e) => set("limit", e.target.value)} /></label>}
      </div>
      <label>ملاحظات<input value={f.notes} onChange={(e) => set("notes", e.target.value)} /></label>
      {err && <div className="error">{err}</div>}
      <button className="primary" disabled={!f.name.trim() || (!f.isCustomer && !f.isSupplier)} onClick={save}>حفظ</button>
    </Modal>
  );
}
