import path from "node:path";
import type { Deps } from "./deps.ts";

export type GitConfig = Map<string, string[]>;

export interface Repo {
  workTree: string;
  gitDir: string;
  commonDir: string;
  configFile: string;
  config: GitConfig;
  branch: string | null;
}

function parseValue(raw: string): string {
  let out = "";
  let inQuote = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "\\" && i + 1 < raw.length) {
      const n = raw[++i]!;
      out += n === "n" ? "\n" : n === "t" ? "\t" : n === "b" ? "\b" : n;
    } else if (c === '"') {
      inQuote = !inQuote;
    } else if (!inQuote && (c === "#" || c === ";")) {
      break;
    } else {
      out += c;
    }
  }
  return out.trim();
}

export function parseGitConfig(text: string): GitConfig {
  const cfg: GitConfig = new Map();
  let prefix = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line[0] === "#" || line[0] === ";") continue;
    if (line[0] === "[") {
      const m = /^\[\s*([^\s\]"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
      if (!m) { prefix = ""; continue; }
      let section = m[1]!;
      let sub = m[2]?.replace(/\\(.)/g, "$1");
      if (sub === undefined) {
        const dot = section.indexOf(".");
        if (dot >= 0) { sub = section.slice(dot + 1); section = section.slice(0, dot); }
      }
      prefix = section.toLowerCase() + (sub !== undefined ? "." + sub : "");
      continue;
    }
    if (!prefix) continue;
    const eq = line.indexOf("=");
    const key = (eq < 0 ? line : line.slice(0, eq)).trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(key)) continue;
    const value = eq < 0 ? "true" : parseValue(line.slice(eq + 1));
    const full = prefix + "." + key;
    const arr = cfg.get(full);
    if (arr) arr.push(value); else cfg.set(full, [value]);
  }
  return cfg;
}

function resolveGitDir(workTree: string, d: Deps): string | null {
  const dotGit = path.join(workTree, ".git");
  if (d.readFile(path.join(dotGit, "HEAD")) !== null) return dotGit;
  const text = d.readFile(dotGit);
  const m = text === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);
  return m ? path.resolve(workTree, m[1]!) : null;
}

export function findRepo(cwd: string, d: Deps): Repo | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const gitDir = resolveGitDir(dir, d);
    if (gitDir) return build(dir, gitDir, d);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function build(workTree: string, gitDir: string, d: Deps): Repo {
  const cd = d.readFile(path.join(gitDir, "commondir"))?.trim();
  const commonDir = cd ? path.resolve(gitDir, cd) : gitDir;
  const configFile = path.join(commonDir, "config");
  const config = parseGitConfig(d.readFile(configFile) ?? "");
  const head = d.readFile(path.join(gitDir, "HEAD"));
  const hm = head === null ? null : /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head);
  return { workTree, gitDir, commonDir, configFile, config, branch: hm ? hm[1]! : null };
}

export function effectiveEmail(
  repo: Repo,
  d: Deps,
): { email: string | null; source: "local" | "git" | "none" } {
  const local = repo.config.get("user.email")?.at(-1);
  if (local) return { email: local, source: "local" };
  const r = d.exec("git", ["config", "user.email"], { cwd: repo.workTree, timeoutMs: 2000 });
  const out = r.code === 0 ? r.stdout.trim() : "";
  return out ? { email: out, source: "git" } : { email: null, source: "none" };
}

export function remoteUrl(repo: Repo, name: string): string | null {
  return repo.config.get(`remote.${name}.url`)?.at(-1) ?? null;
}

export function pushRemoteName(repo: Repo, explicit?: string): string {
  if (explicit) return explicit;
  const b = repo.branch;
  const get = (k: string) => repo.config.get(k)?.at(-1);
  return (
    (b && get(`branch.${b}.pushremote`)) ||
    get("remote.pushdefault") ||
    (b && get(`branch.${b}.remote`)) ||
    "origin"
  );
}
