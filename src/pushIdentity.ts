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

function sshIdentity(remote: Remote, d: Deps, allowSpawn: boolean): PushIdentity {
  const target = remote.sshAlias ?? remote.host;
  const k = target.toLowerCase();
  const file = path.join(stateDir(d), "ssh.json");
  const stamp = sshKeyStamp(d);
  const cache = readCache(file, d);
  const hit = cache[k];
  if (hit && typeof hit.login === "string" && hit.key === stamp) return { via: "ssh", login: hit.login };
  if (!allowSpawn) return { via: "ssh", login: null };

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

function helpers(d: Deps, repo: Repo, key: string): string[] {
  const r = d.exec("git", ["config", "--get-all", key], { cwd: repo.workTree, timeoutMs: 2000 });
  if (r.code !== 0) return [];
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export function pushIdentity(
  remote: Remote,
  repo: Repo,
  hosts: GhHosts | null,
  d: Deps,
  opts: { allowSpawn: boolean },
): PushIdentity {
  if (remote.protocol === "ssh") return sshIdentity(remote, d, opts.allowSpawn);
  // git uses the most specific credential.<url>.helper if set, else the generic one
  const specific = helpers(d, repo, `credential.https://${remote.host.toLowerCase()}.helper`);
  const list = specific.length > 0 ? specific : helpers(d, repo, "credential.helper");
  if (list.some((h) => h.includes("auth git-credential"))) {
    return { via: "gh", login: hosts?.active ?? null };
  }
  return { via: "unknown" };
}
