export interface ScaleConfig { prefix: string; pluLen: number; valueLen?: number }

/**
 * Price/weight-embedded EAN-13 printed by shop scales: [prefix][PLU][value][check digit].
 * Default layout is 20 + 5-digit PLU + 5-digit value + check digit.
 * `value` is grams (weight mode) or piastres (price mode).
 */
export function parseScaleBarcode(code: string, cfg: ScaleConfig): { plu: string; value: number } | null {
  const valueLen = cfg.valueLen ?? 5;
  if (!/^\d{13}$/.test(code) || !cfg.prefix || !code.startsWith(cfg.prefix)) return null;
  const start = cfg.prefix.length;
  if (start + cfg.pluLen + valueLen > 12) return null;
  return {
    plu: code.slice(start, start + cfg.pluLen),
    value: Number(code.slice(start + cfg.pluLen, start + cfg.pluLen + valueLen)),
  };
}
