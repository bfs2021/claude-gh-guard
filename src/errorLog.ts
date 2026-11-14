import path from "node:path";
import type { Deps } from "./deps.ts";
import { stateDir } from "./paths.ts";

/** Append a timestamped line to the state dir's error.log. Never throws. */
export function logError(d: Deps, err: unknown): void {
  try {
    const file = path.join(stateDir(d), "error.log");
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    d.writeFile(file, (d.readFile(file) ?? "") + `${new Date(d.now()).toISOString()} ${msg}\n`);
  } catch {
    // logging is best-effort
  }
}
