import path from "node:path";

export interface Guarded {
  kind: "commit" | "push" | "pr";
  cwd: string;
  remoteName?: string;
  remoteUrl?: string;
  ghRepo?: string;
  emailOverride?: string;
}

/** Split into segments of tokens. Separators are only recognised outside quotes. */
function tokenize(input: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let cur = "";
  let has = false;
  const endToken = () => { if (has) tokens.push(cur); cur = ""; has = false; };
  const endSeg = () => { endToken(); if (tokens.length) segments.push(tokens); tokens = []; };
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === "'") {
      has = true; i++;
      while (i < input.length && input[i] !== "'") cur += input[i++];
      i++;
    } else if (c === '"') {
      has = true; i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) { cur += input[i + 1]; i += 2; }
        else cur += input[i++];
      }
      i++;
    } else if (c === "\\" && i + 1 < input.length && " \"'\n".includes(input[i + 1])) {
      if (input[i + 1] !== "\n") { cur += input[i + 1]; has = true; }
      i += 2;
    } else if (c === " " || c === "\t" || c === "\r") {
      endToken(); i++;
    } else if (c === "\n" || c === ";" || c === "|" || c === "&") {
      endSeg();
      i++;
      if ((c === "|" || c === "&") && input[i] === c) i++;
    } else {
      cur += c; has = true; i++;
    }
  }
  endSeg();
  return segments;
}

function baseName(cmd: string): string {
  return cmd.split(/[\\/]/).pop()!.toLowerCase();
}
const isGit = (cmd: string) => ["git", "git.exe"].includes(baseName(cmd));
const isGh = (cmd: string) => ["gh", "gh.exe"].includes(baseName(cmd));

const PUSH_VALUE_OPTS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

function isUrlLike(s: string): boolean {
  if (s.includes("://") || s.includes("@")) return true;
  const colon = s.indexOf(":");
  if (colon < 0) return false;
  const slash = s.search(/[\\/]/);
  return slash < 0 || colon < slash;
}

export function parseCommand(command: string, baseCwd: string): Guarded[] {
  const out: Guarded[] = [];
  let cwd = baseCwd;
  for (const seg of tokenize(command)) {
    let i = 0;
    let emailOverride: string | undefined;
    while (i < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i])) {
      const eq = seg[i].indexOf("=");
      if (seg[i].slice(0, eq) === "GIT_AUTHOR_EMAIL") emailOverride = seg[i].slice(eq + 1);
      i++;
    }
    const cmd = seg[i++];
    if (cmd === undefined) continue;

    if (cmd === "cd") {
      if (seg[i] === "/d") i++;
      if (seg[i] === "--") i++;
      const arg = seg[i];
      if (arg !== undefined && arg !== "-") cwd = path.resolve(cwd, arg);
      continue;
    }

    if (isGit(cmd)) {
      let segCwd = cwd;
      let skip = false;
      while (i < seg.length && seg[i].startsWith("-")) {
        const o = seg[i];
        if (o === "-C") {
          if (seg[i + 1] === undefined) { skip = true; break; }
          segCwd = path.resolve(segCwd, seg[i + 1]); i += 2;
        } else if (o === "-c") {
          const kv = seg[i + 1];
          if (kv === undefined) { skip = true; break; }
          const eq = kv.indexOf("=");
          if (eq > 0 && kv.slice(0, eq).toLowerCase() === "user.email") emailOverride = kv.slice(eq + 1);
          i += 2;
        } else if (/^--(git-dir|work-tree)(=|$)/.test(o)) {
          skip = true; break;
        } else i++;
      }
      if (skip) continue;
      const sub = seg[i++];
      if (sub === "commit") {
        const g: Guarded = { kind: "commit", cwd: segCwd };
        if (emailOverride !== undefined) g.emailOverride = emailOverride;
        out.push(g);
      } else if (sub === "push") {
        let remote: string | undefined;
        let repoOpt: string | undefined;
        let onlyPos = false;
        for (; i < seg.length; i++) {
          const a = seg[i];
          if (!onlyPos && a === "--") { onlyPos = true; continue; }
          if (!onlyPos && a.startsWith("-")) {
            if (a.startsWith("--repo=")) repoOpt = a.slice(7);
            else if (PUSH_VALUE_OPTS.has(a)) {
              if (a === "--repo") repoOpt = seg[i + 1];
              i++;
            }
            continue;
          }
          remote = a;
          break;
        }
        const target = repoOpt ?? remote;
        const g: Guarded = { kind: "push", cwd: segCwd };
        if (target !== undefined && target !== "") {
          if (isUrlLike(target)) g.remoteUrl = target; else g.remoteName = target;
        }
        if (emailOverride !== undefined) g.emailOverride = emailOverride;
        out.push(g);
      }
    } else if (isGh(cmd)) {
      if (seg[i] === "pr" && seg[i + 1] === "create") {
        const g: Guarded = { kind: "pr", cwd };
        for (let j = i + 2; j < seg.length; j++) {
          const a = seg[j];
          if ((a === "-R" || a === "--repo") && seg[j + 1] !== undefined) { g.ghRepo = seg[j + 1]; break; }
          if (a.startsWith("--repo=")) { g.ghRepo = a.slice(7); break; }
        }
        out.push(g);
      }
    }
  }
  return out;
}
