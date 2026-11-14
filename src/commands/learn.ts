import path from "node:path";
import type { Deps } from "../deps.ts";
import { stateDir } from "../paths.ts";
import { readGhHosts } from "../ghHosts.ts";
import { learnRepo, writeLearned } from "../learn.ts";

const STALE_MS = 60000;

export async function runLearn(argv: string[], d: Deps): Promise<void> {
  const [owner, repo] = argv;
  if (!owner || !repo) return;
  const lock = path.join(stateDir(d), "learn.lock");
  // Deps has no exclusive-create, so: a non-empty lock younger than 60s means
  // another run is active; otherwise take it. On finish we overwrite it with ""
  // and an empty lock counts as released.
  const held = d.readFile(lock);
  const m = d.mtime(lock);
  if (held !== null && held !== "" && m !== null && d.now() - m < STALE_MS) return;
  d.writeFile(lock, String(d.now()));
  try {
    const logins = readGhHosts(d)?.logins ?? [];
    const entry = await learnRepo(owner, repo, logins, d, 10000);
    if (entry) writeLearned(d, `${owner}/${repo}`, entry);
  } catch {
    // always exit 0
  } finally {
    try {
      d.writeFile(lock, "");
    } catch {
      // ignore
    }
  }
}
