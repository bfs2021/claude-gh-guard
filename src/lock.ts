import path from "node:path";
import type { Deps } from "./deps.ts";
import { stateDir } from "./paths.ts";

const STALE_MS = 60000;

/**
 * Run `fn` unless another run holds `<name>.lock`. Deps has no exclusive-create, so:
 * a non-empty lock younger than 60s means another run is active; otherwise take it.
 * On finish the lock is overwritten with "", and an empty lock counts as released.
 */
export async function withLock(d: Deps, name: string, fn: () => Promise<void>): Promise<void> {
  const lock = path.join(stateDir(d), `${name}.lock`);
  const held = d.readFile(lock);
  const m = d.mtime(lock);
  if (held !== null && held !== "" && m !== null && d.now() - m < STALE_MS) return;
  d.writeFile(lock, String(d.now()));
  try {
    await fn();
  } catch {
    // background work: always exit 0
  } finally {
    try {
      d.writeFile(lock, "");
    } catch {
      // ignore
    }
  }
}
