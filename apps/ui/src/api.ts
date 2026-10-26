import type { Api } from "@market/core";

declare global { interface Window { api: Api } }

export const api = window.api;
export { egp, egp0, num, toPiastres, fromPiastres } from "./fmt";
export const errMsg = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
