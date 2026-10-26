import type { Api } from "@market/core";

declare global { interface Window { api: Api } }

export const api = window.api;
export const egp = (piastres: number) => (piastres / 100).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const errMsg = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
