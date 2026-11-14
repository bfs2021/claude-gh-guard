import path from "node:path";
import { createHash } from "node:crypto";
import type { Deps } from "../deps.ts";
import { cacheDir, ghConfigDir, stateDir } from "../paths.ts";
import { logError } from "../errorLog.ts";
import { gatherFacts } from "../gather.ts";
import { evaluate } from "../evaluate.ts";
import { render } from "../render.ts";
import { findRepo } from "../gitRepo.ts";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

function inputCwd(stdin: string): string {
  try {
    const j = JSON.parse(stdin);
    const c = j?.workspace?.current_dir ?? j?.cwd;
    if (typeof c === "string" && c) return c;
  } catch {
    // fall through
  }
  return process.cwd();
}

// Locate the work tree without parsing git config, so a cache hit stays cheap.
function lightRepo(cwd: string, d: Deps): { workTree: string; files: string[] } | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const gitDir = path.join(dir, ".git");
    if (d.mtime(path.join(gitDir, "HEAD")) !== null) {
      return { workTree: dir, files: [path.join(gitDir, "config"), path.join(gitDir, "HEAD")] };
    }
    if (d.mtime(gitDir) !== null) return null; // .git file (worktree/submodule): use the full path
    const parent = path.dirname(dir);
    if (parent === dir) return { workTree: path.resolve(cwd), files: [] };
    dir = parent;
  }
}

function compute(cwd: string, d: Deps, ascii: boolean, color: boolean): string {
  const { facts, needsLearn } = gatherFacts(cwd, d, { allowSpawn: false });
  if (needsLearn) {
    try {
      d.spawnDetached(["learn", needsLearn.owner, needsLearn.repo]);
    } catch {
      // learning is best-effort
    }
  }
  return render(evaluate("status", facts), facts.push, { ascii, color });
}

export function runStatusline(stdin: string, argv: string[], d: Deps): string {
  const ascii = argv.includes("--ascii") || d.env.GH_GUARD_ASCII === "1";
  const color = !d.env.NO_COLOR;
  const afterIdx = argv.indexOf("--after");
  const after = afterIdx >= 0 ? argv[afterIdx + 1] : undefined;
  const cwd = inputCwd(stdin);

  let ours: string;
  try {
    const light = lightRepo(cwd, d);
    const full = light ? null : findRepo(cwd, d);
    const workTree = light?.workTree ?? full?.workTree ?? path.resolve(cwd);
    const repoFiles = light?.files ?? (full ? [full.configFile, path.join(full.gitDir, "HEAD")] : []);
    const files = [
      path.join(ghConfigDir(d), "hosts.yml"),
      ...repoFiles,
      path.join(d.home, ".gitconfig"),
      path.join(d.home, ".gh-guard.json"),
      path.join(stateDir(d), "learned.json"),
      path.join(stateDir(d), "ssh.json"),
      path.join(d.home, ".ssh", "config"),
      ...(d.env.GIT_CONFIG_GLOBAL ? [d.env.GIT_CONFIG_GLOBAL] : []),
      d.env.XDG_CONFIG_HOME
        ? path.join(d.env.XDG_CONFIG_HOME, "git", "config")
        : path.join(d.home, ".config", "git", "config"),
    ];
    // The time bucket bounds staleness (and lets learning retry) to 10 minutes.
    const key = [Math.floor(d.now() / 600000), Number(ascii), Number(color), ...files.map((f) => d.mtime(f) ?? "-")].join("|");
    const cacheFile = path.join(cacheDir(d), `${sha1(workTree)}.json`);
    let hit: string | null = null;
    try {
      const c = JSON.parse(d.readFile(cacheFile) ?? "");
      if (c && c.key === key && typeof c.line === "string") hit = c.line;
    } catch {
      // corrupt or missing cache is a miss
    }
    if (hit !== null) {
      ours = hit;
    } else {
      ours = compute(cwd, d, ascii, color);
      try {
        d.writeFile(cacheFile, JSON.stringify({ key, line: ours }));
      } catch {
        // cache is best-effort
      }
    }
  } catch (e) {
    logError(d, e);
    const text = ascii ? "[?] gh:? (error)" : "⚪ gh:? (error)";
    ours = color ? `[37m${text}[0m` : text;
  }

  if (after === undefined) return ours;
  // On win32 pass the command verbatim inside one extra pair of quotes: libuv's
  // default escaping uses backslashes, which cmd.exe does not understand.
  const win = d.platform === "win32";
  const [cmd, args]: [string, string[]] = win
    ? ["cmd.exe", ["/d", "/s", "/c", `"${after}"`]]
    : ["/bin/sh", ["-c", after]];
  let theirs = "";
  try {
    const r = d.exec(cmd, args, { input: stdin, timeoutMs: 2000, verbatim: win });
    if (r.code === 0) theirs = r.stdout.trim();
  } catch {
    // ignore
  }
  return theirs && ours ? `${theirs} | ${ours}` : theirs || ours;
}
