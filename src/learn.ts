import path from "node:path";
import type { Deps } from "./deps.ts";
import { stateDir } from "./paths.ts";

export interface LearnedEntry {
  pushers: string[];
  expected: string | null;
  basis: "single" | "history" | "ambiguous" | "none";
  checkedAt: number;
  loginsKey: string;
}

const MAX_AGE_MS = 604800000;

function learnedPath(d: Deps): string {
  return path.join(stateDir(d), "learned.json");
}

function loginsKeyOf(logins: string[]): string {
  return [...logins].sort().join(",");
}

export function readLearned(d: Deps): Record<string, LearnedEntry> {
  const text = d.readFile(learnedPath(d));
  if (text === null) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function writeLearned(d: Deps, key: string, e: LearnedEntry): void {
  const all = readLearned(d);
  all[key.toLowerCase()] = e;
  d.writeFile(learnedPath(d), JSON.stringify(all, null, 2));
}

export function isFresh(e: LearnedEntry, logins: string[], now: number): boolean {
  return now - e.checkedAt <= MAX_AGE_MS && e.loginsKey === loginsKeyOf(logins);
}

export async function learnRepo(
  owner: string,
  repo: string,
  logins: string[],
  d: Deps,
  timeoutMs: number,
): Promise<LearnedEntry | null> {
  const loginsKey = loginsKeyOf(logins);
  const checkedAt = d.now();
  if (logins.length === 0) {
    return { pushers: [], expected: null, basis: "none", checkedAt, loginsKey };
  }

  const start = Date.now();
  const ctrl = new AbortController();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("timeout"));
    ctrl.signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const api = async (url: string, token: string): Promise<Response> => {
    const r = await Promise.race([
      d.fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "claude-gh-guard",
        },
        signal: ctrl.signal,
      }),
      aborted,
    ]);
    return r;
  };

  try {
    const base = `https://api.github.com/repos/${owner}/${repo}`;
    const pushers: string[] = [];
    let pusherToken: string | null = null;

    for (const login of logins) {
      const remaining = Math.max(1, timeoutMs - (Date.now() - start));
      if (remaining <= 1 && ctrl.signal.aborted) return null;
      const t = d.exec("gh", ["auth", "token", "--user", login], { timeoutMs: remaining });
      const token = t.stdout.trim();
      if (t.code !== 0 || !token) continue;
      if (Date.now() - start >= timeoutMs) return null;
      const r = await api(base, token);
      if (r.status !== 200) continue;
      const body = (await Promise.race([r.json(), aborted])) as { permissions?: { push?: boolean } };
      if (body?.permissions?.push === true) {
        pushers.push(login);
        pusherToken ??= token;
      }
    }

    if (pushers.length === 0) return { pushers, expected: null, basis: "none", checkedAt, loginsKey };
    if (pushers.length === 1) return { pushers, expected: pushers[0]!, basis: "single", checkedAt, loginsKey };

    const counts = new Map<string, number>();
    try {
      const r = await api(`${base}/commits?per_page=50`, pusherToken!);
      if (r.status === 200) {
        const commits = (await Promise.race([r.json(), aborted])) as { author?: { login?: string } | null }[];
        if (Array.isArray(commits)) {
          for (const c of commits) {
            const al = c?.author?.login;
            if (typeof al !== "string") continue;
            const mine = logins.find((l) => l.toLowerCase() === al.toLowerCase());
            if (mine) counts.set(mine, (counts.get(mine) ?? 0) + 1);
          }
        }
      }
    } catch {
      if (ctrl.signal.aborted) return null;
      // commits failure: treat as no history
    }

    let best: string | null = null;
    let bestN = 0;
    let tie = false;
    for (const [l, n] of counts) {
      if (n > bestN) {
        best = l;
        bestN = n;
        tie = false;
      } else if (n === bestN) tie = true;
    }
    if (best && !tie) return { pushers, expected: best, basis: "history", checkedAt, loginsKey };
    return { pushers, expected: null, basis: "ambiguous", checkedAt, loginsKey };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ctrl.signal.removeEventListener("abort", onAbort);
  }
}
