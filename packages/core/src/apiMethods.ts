/** Methods the renderer may call. Kept in its own file so the sandboxed preload can import it without Node modules. */
export const API_METHODS = [
  "bootstrap", "setupOwner", "login", "logout", "saveSettings", "activate", "scan", "search",
  "checkout", "importCsv", "print", "addUser", "setUserActive", "resetPin",
  "openShift", "shiftReport", "listShifts", "closeShift", "holdCart", "listHeld", "resumeHeld", "deleteHeld",
  "findSale", "createReturn",
  "listCustomers", "addCustomer", "setCreditLimit", "customerStatement", "receivePayment",
  "addExpense", "listExpenses", "deleteExpense",
  "listProducts", "saveProduct", "receiveStock", "adjustStock", "expiring",
  "analytics", "treasury", "treasuryEntries", "treasuryDeposit", "treasuryWithdraw", "treasuryTransfer", "treasuryCount", "backupNow", "backupExport", "restoreBackup",
  "enterDemo", "exitDemo", "contactSupport", "remindCustomer",
  "cloudStatus", "cloudLink", "cloudUnlink", "cloudSyncNow",
] as const;
export type ApiMethod = (typeof API_METHODS)[number];
