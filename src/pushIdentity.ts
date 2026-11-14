import path from "node:path";
import type { Deps } from "./deps.ts";
import type { Remote } from "./remote.ts";
import type { Repo } from "./gitRepo.ts";
import type { GhHosts } from "./ghHosts.ts";
import { stateDir } from "./paths.ts";

export type PushIdentity =
  | { via: "ssh"; login: string | null }
  | { via: "gh"; login: string | null }
  | { via: "unknown" };

export function parseSshHello(stderr: string): string | null {
  return /Hi ([A-Za-z0-9-]+)!/.exec(stderr)?.[1] ?? null;
}

const KEY_FILES = ["id_rsa", "id_ecdsa", "id_ecdsa_sk", "id_ed25519", "id_ed25519_sk", "id_dsa"];

function sshKeyStamp(d: Deps): number {
  const dir = path.join(d.home, ".ssh");
  let max = 0;
  for (const f of ["config", ...KEY_FILES]) {
    const m = d.mtime(path.join(dir, f));
    if (m !== null && m > max) max = m;
  }
  return max;
}

type SshCache = Record<string, { login: string; key: number }>;

function readCache(file: string, d: Deps): SshCache {
  try {
    const v = JSON.parse(d.readFile(file) ?? "");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as SshCache) : {};
  } catch {
    return {};
  }
}

/** A custom ssh program (env or core.sshCommand) may pick any key: we cannot know whose. */
function customSsh(repo: Repo, d: Deps, allowSpawn: boolean): boolean {
  if (d.env.GIT_SSH || d.env.GIT_SSH_COMMAND) return true;
  if ((repo.config.get("core.sshcommand")?.at(-1) ?? "") !== "") return true;
  if (!allowSpawn) return false;
  // global/system/include config: only git itself knows
  const r = d.exec("git", ["config", "core.sshCommand"], { cwd: repo.workTree, timeoutMs: 2000 });
  return r.code === 0 && r.stdout.trim() !== "";
}

function sshIdentity(remote: Remote, d: Deps, allowSpawn: boolean): PushIdentity {
  const target = remote.sshAlias ?? remote.host;
  const k = target.toLowerCase();
  const file = path.join(stateDir(d), "ssh.json");
  const stamp = sshKeyStamp(d);
  const cache = readCache(file, d);
  if (!allowSpawn) {
    // status line: the cache is all we have (the agent may have changed since; the hook re-probes)
    const hit = cache[k];
    return { via: "ssh", login: hit && typeof hit.login === "string" && hit.key === stamp ? hit.login : null };
  }

  // hook/doctor: always ask ssh, since the agent's loaded keys are invisible to the cache key
  const r = d.exec("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", `git@${target}`], { timeoutMs: 3000 });
  const login = parseSshHello(r.stderr) ?? parseSshHello(r.stdout);
  if (!login) return { via: "ssh", login: null };
  try {
    cache[k] = { login, key: stamp };
    d.writeFile(file, JSON.stringify(cache));
  } catch {
    // cache is best-effort
  }
  return { via: "ssh", login };
}

/** Values of a multi-valued key in config order, applying git's rule that an empty value clears the list so far. */
function helpers(d: Deps, repo: Repo, key: string): string[] {
  const r = d.exec("git", ["config", "--get-all", key], { cwd: repo.workTree, timeoutMs: 2000 });
  if (r.code !== 0) return [];
  let list: string[] = [];
  for (const raw of r.stdout.replace(/\r?\n$/, "").split(/\r?\n/)) {
    const v = raw.trim();
    if (v === "") list = [];
    else list.push(v);
  }
  return list;
}

export function pushIdentity(
  remote: Remote,
  repo: Repo,
  hosts: GhHosts | null,
  d: Deps,
  opts: { allowSpawn: boolean },
): PushIdentity {
  if (remote.protocol === "ssh") {
    if (customSsh(repo, d, opts.allowSpawn)) return { via: "unknown" };
    return sshIdentity(remote, d, opts.allowSpawn);
  }
  // the most specific credential.<url>.helper list wins if non-empty, else the generic one;
  // git asks helpers in order, so only a gh helper that comes first decides the identity
  const specific = helpers(d, repo, `credential.https://${remote.host.toLowerCase()}.helper`);
  const list = specific.length > 0 ? specific : helpers(d, repo, "credential.helper");
  if (list[0]?.includes("auth git-credential")) {
    return { via: "gh", login: hosts?.active ?? null };
  }
  return { via: "unknown" };
}
