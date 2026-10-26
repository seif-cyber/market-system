// All amounts are integer piastres (قرش) to avoid float errors.
export interface LineInput {
  unitPrice: number;
  qty: number; // may be fractional for weighed items
  discount?: number; // line discount, piastres
}

export interface InvoiceTotals {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

export function lineTotal(l: LineInput): number {
  const gross = Math.round(l.unitPrice * l.qty);
  const net = gross - (l.discount ?? 0);
  if (net < 0) throw new Error("line discount exceeds line amount");
  return net;
}

/** taxRate is a fraction, e.g. 0.14. Prices are tax-inclusive when taxInclusive is true. */
export function calcInvoice(
  lines: LineInput[],
  opts: { invoiceDiscount?: number; taxRate?: number; taxInclusive?: boolean } = {},
): InvoiceTotals {
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  const discount = opts.invoiceDiscount ?? 0;
  if (discount > subtotal) throw new Error("invoice discount exceeds subtotal");
  const net = subtotal - discount;
  const rate = opts.taxRate ?? 0;
  if (opts.taxInclusive) {
    const tax = Math.round(net - net / (1 + rate));
    return { subtotal, discount, tax, total: net };
  }
  const tax = Math.round(net * rate);
  return { subtotal, discount, tax, total: net + tax };
}
