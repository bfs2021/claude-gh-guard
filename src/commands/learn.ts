import type { Deps } from "../deps.ts";
import { readGhHosts } from "../ghHosts.ts";
import { learnRepo, writeLearned } from "../learn.ts";
import { checkMoved, writeMoved } from "../moved.ts";
import { withLock } from "../lock.ts";

export async function runLearn(argv: string[], d: Deps): Promise<void> {
  const [owner, repo] = argv;
  if (!owner || !repo) return;
  await withLock(d, "learn", async () => {
    const logins = readGhHosts(d)?.logins ?? [];
    const entry = await learnRepo(owner, repo, logins, d, 10000);
    if (entry) writeLearned(d, `${owner}/${repo}`, entry);
  });
}

export async function runMoved(argv: string[], d: Deps): Promise<void> {
  const [owner, repo] = argv;
  if (!owner || !repo) return;
  await withLock(d, "moved", async () => {
    const hosts = readGhHosts(d);
    const entry = await checkMoved(owner, repo, hosts?.logins ?? [], hosts?.active ?? null, d, 10000);
    if (entry) writeMoved(d, `${owner}/${repo}`, entry);
  });
}
