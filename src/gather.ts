import path from "node:path";
import type { Deps } from "./deps.ts";
import { readGhHosts } from "./ghHosts.ts";
import { findRepo, effectiveEmail, remoteUrl, pushRemoteName } from "./gitRepo.ts";
import type { Repo } from "./gitRepo.ts";
import { parseRemoteUrl } from "./remote.ts";
import type { Remote } from "./remote.ts";
import { loadConfig } from "./config.ts";
import { readLearned, isFresh } from "./learn.ts";
import type { LearnedEntry } from "./learn.ts";
import { pushIdentity } from "./pushIdentity.ts";
import type { PushIdentity } from "./pushIdentity.ts";
import { resolveExpected } from "./evaluate.ts";
import type { Expected, Facts } from "./evaluate.ts";

export function gatherFacts(
  cwd: string,
  d: Deps,
  opts: { allowSpawn: boolean; remoteName?: string; remoteOverride?: Remote; skipPush?: boolean },
): { facts: Facts; repo: Repo | null; needsLearn: { owner: string; repo: string } | null } {
  const hosts = readGhHosts(d);
  const logins = hosts?.logins ?? [];
  const repo = findRepo(cwd, d);
  const profiles = loadConfig(d).profiles;

  const resolve = (remote: Remote | null) => {
    let expected: Expected | null = null;
    let needsLearn: { owner: string; repo: string } | null = null;
    if (remote) {
      const entry: LearnedEntry | undefined = readLearned(d)[`${remote.owner}/${remote.repo}`.toLowerCase()];
      const usable =
        entry !== undefined &&
        isFresh(entry, logins, d.now()) &&
        (entry.expected === null || logins.some((l) => l.toLowerCase() === entry.expected!.toLowerCase()));
      expected = resolveExpected(remote, logins, profiles, usable ? entry : undefined);
      if (remote.host.toLowerCase() === "github.com" && expected.source === "none" && !usable) {
        needsLearn = { owner: remote.owner, repo: remote.repo };
      }
    }
    return { expected, needsLearn };
  };

  if (!repo) {
    const remote = opts.remoteOverride ?? null;
    const { expected, needsLearn } = resolve(remote);
    const facts: Facts = {
      hosts, remote, email: null, push: null, expected,
      remoteName: opts.remoteName ?? "origin",
    };
    return { facts, repo: null, needsLearn };
  }

  const remoteName = opts.remoteName ?? pushRemoteName(repo);
  const url = remoteUrl(repo, remoteName);
  const sshConfigText = d.readFile(path.join(d.home, ".ssh", "config"));
  const remote = opts.remoteOverride ?? (url === null ? null : parseRemoteUrl(url, sshConfigText));
  const email = effectiveEmail(repo, d).email;
  const { expected, needsLearn } = resolve(remote);
  const push: PushIdentity | null =
    remote && !opts.skipPush ? pushIdentity(remote, repo, hosts, d, { allowSpawn: opts.allowSpawn }) : null;

  return { facts: { hosts, remote, email, push, expected, remoteName }, repo, needsLearn };
}
