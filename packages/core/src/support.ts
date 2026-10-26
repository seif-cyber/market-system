export const SUPPORT_CONTACTS = [
  { id: "primary", name: "م. محمد شعيب", role: "الدعم الأساسي", phone: "201159858866" },
  { id: "secondary", name: "م. سيف الدين", role: "الدعم الفني", phone: "201555262127" },
] as const;
export type SupportContactId = (typeof SUPPORT_CONTACTS)[number]["id"];

/** wa.me link to a support contact (the primary one by default), optionally with a prefilled message. */
export function whatsappUrl(text?: string, phone: string = SUPPORT_CONTACTS[0].phone): string {
  return `https://wa.me/${phone}` + (text ? `?text=${encodeURIComponent(text)}` : "");
}
