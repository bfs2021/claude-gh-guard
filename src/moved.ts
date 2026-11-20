import path from "node:path";
import type { Deps } from "./deps.ts";
import type { Remote } from "./remote.ts";
import { stateDir } from "./paths.ts";

/** What GitHub calls a repo now. A renamed or transferred repo keeps redirecting from its old name. */
export interface MovedEntry {
  /** Canonical `owner/repo`, or null when none of the logins can see the repo. */
  fullName: string | null;
  checkedAt: number;
}

const MAX_AGE_MS = 604800000;

function movedPath(d: Deps): string {
  return path.join(stateDir(d), "moved.json");
}

export function readMoved(d: Deps): Record<string, MovedEntry> {
  const text = d.readFile(movedPath(d));
  if (text === null) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function writeMoved(d: Deps, key: string, e: MovedEntry): void {
  const all = readMoved(d);
  all[key.toLowerCase()] = e;
  d.writeFile(movedPath(d), JSON.stringify(all, null, 2));
}

export function isMovedFresh(e: MovedEntry, now: number): boolean {
  return now - e.checkedAt <= MAX_AGE_MS;
}

export function movedKey(r: Remote): string {
  return `${r.owner}/${r.repo}`.toLowerCase();
}

/** The new `owner/repo` when the cache says this github.com remote points at an old name. Cache only, no network. */
export function movedTo(d: Deps, r: Remote | null): string | null {
  if (!r || r.host.toLowerCase() !== "github.com") return null;
  const e = readMoved(d)[movedKey(r)];
  if (!e || typeof e.fullName !== "string") return null;
  return e.fullName.toLowerCase() === movedKey(r) ? null : e.fullName;
}

export function setUrlFix(r: Remote, fullName: string, remoteName: string): string {
  if (!remoteName) return `use ${fullName} instead`;
  const url = r.protocol === "ssh" ? `git@${r.sshAlias ?? r.host}:${fullName}.git` : `https://${r.host}/${fullName}.git`;
  return `git remote set-url ${remoteName} ${url}`;
}

/** Ask GitHub for the repo's canonical name (the API follows the redirect of a moved repo). Null when undecided. */
export async function checkMoved(
  owner: string,
  repo: string,
  logins: string[],
  active: string | null,
  d: Deps,
  timeoutMs: number,
): Promise<MovedEntry | null> {
  if (logins.length === 0) return null;
  const order = [...logins].sort((a, b) => Number(b === active) - Number(a === active));
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const aborted = new Promise<never>((_, reject) =>
    ctrl.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }),
  );
  aborted.catch(() => {});
  let notFound = 0;
  try {
    for (const login of order) {
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) return null;
      const t = d.exec("gh", ["auth", "token", "--user", login], { timeoutMs: remaining });
      const token = t.stdout.trim();
      if (t.code !== 0 || !token) continue;
      const r = await Promise.race([
        d.fetch(`https://api.github.com/repos/${owner}/${repo}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "claude-gh-guard" },
          signal: ctrl.signal,
        }),
        aborted,
      ]);
      if (r.status === 404) {
        notFound++;
        continue;
      }
      if (r.status !== 200) return null;
      const body = (await Promise.race([r.json(), aborted])) as { full_name?: unknown };
      if (typeof body?.full_name !== "string") return null;
      return { fullName: body.full_name, checkedAt: d.now() };
    }
    // only a 404 for every login means "not visible"; a missing token leaves it undecided
    return notFound === order.length ? { fullName: null, checkedAt: d.now() } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
