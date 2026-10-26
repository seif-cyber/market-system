import { execFileSync } from "node:child_process";
import { cpus, hostname, networkInterfaces } from "node:os";
import { fingerprintFrom } from "@market/core";

function machineGuid(): string {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8" });
      return out.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1] ?? "";
    }
    if (process.platform === "linux") return execFileSync("cat", ["/etc/machine-id"], { encoding: "utf8" }).trim();
  } catch { /* fall through */ }
  return "";
}

/** Short device code the customer sends us; the license is bound to it. */
export function deviceFingerprint(): string {
  const mac = Object.values(networkInterfaces()).flat().find((n) => n && !n.internal && n.mac !== "00:00:00:00:00:00")?.mac ?? "";
  return fingerprintFrom([machineGuid(), cpus()[0]?.model ?? "", mac || hostname()]);
}
