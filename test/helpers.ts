import path from "node:path";
import type { Deps } from "../src/deps.ts";

export function fakeDeps(overrides: Partial<Deps> & { files?: Record<string, string> } = {}): Deps {
  const { files: initial, ...rest } = overrides;
  const files = new Map<string, string>();
  for (const [k, v] of Object.entries(initial ?? {})) files.set(path.normalize(k), v);
  const base: Deps = {
    env: {},
    platform: "linux",
    home: "/home/test",
    tmpdir: "/tmp",
    now: () => 0,
    readFile: (p) => files.get(path.normalize(p)) ?? null,
    writeFile: (p, s) => { files.set(path.normalize(p), s); },
    mtime: (p) => (files.has(path.normalize(p)) ? 0 : null),
    remove: (p) => {
      const n = path.normalize(p);
      for (const k of [...files.keys()]) if (k === n || k.startsWith(n + path.sep)) files.delete(k);
    },
    exec: () => ({ code: 1, stdout: "", stderr: "" }),
    fetch: (() => Promise.reject(new Error("fetch not stubbed"))) as typeof fetch,
    spawnDetached: () => {},
  };
  return { ...base, ...rest };
}
