export const SUPPORT_WHATSAPP = "201555262127";

/** wa.me link to the vendor's support number, optionally with a prefilled message. */
export function whatsappUrl(text?: string): string {
  return `https://wa.me/${SUPPORT_WHATSAPP}` + (text ? `?text=${encodeURIComponent(text)}` : "");
}
