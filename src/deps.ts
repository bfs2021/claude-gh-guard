import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export interface Deps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  tmpdir: string;
  now(): number;
  readFile(p: string): string | null;
  writeFile(p: string, s: string): void;
  mtime(p: string): number | null;
  exec(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv; verbatim?: boolean },
  ): { code: number | null; stdout: string; stderr: string };
  fetch: typeof fetch;
  spawnDetached(args: string[]): void;
}

export function realDeps(): Deps {
  return {
    env: process.env,
    platform: process.platform,
    home: os.homedir(),
    tmpdir: os.tmpdir(),
    now: () => Date.now(),
    readFile(p) {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    writeFile(p, s) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, s);
    },
    mtime(p) {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return null;
      }
    },
    exec(cmd, args, opts = {}) {
      const r = spawnSync(cmd, args, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        input: opts.input,
        env: opts.env ?? process.env,
        encoding: "utf8",
        windowsHide: true,
        windowsVerbatimArguments: opts.verbatim,
      });
      return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    fetch: (...a) => fetch(...a),
    spawnDetached(args) {
      const child = spawn(process.execPath, [process.argv[1]!, ...args], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    },
  };
}
