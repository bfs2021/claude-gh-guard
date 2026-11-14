import path from "node:path";
import type { Deps } from "../deps.ts";
import { parseCommand } from "../hook/parse.ts";
import { gatherFacts } from "../gather.ts";
import { evaluate } from "../evaluate.ts";
import { findRepo, remoteUrl } from "../gitRepo.ts";
import type { Repo } from "../gitRepo.ts";
import { parseRemoteUrl } from "../remote.ts";
import type { Remote } from "../remote.ts";
import { learnRepo, writeLearned } from "../learn.ts";
import { logError } from "../errorLog.ts";

const BUDGET_MS = 3000;

function prRemoteName(repo: Repo | null): string {
  if (repo) {
    for (const key of repo.config.keys()) {
      const m = /^remote\.(.+)\.gh-resolved$/.exec(key);
      if (m) return m[1]!;
    }
    if (remoteUrl(repo, "upstream") !== null) return "upstream";
  }
  return "origin";
}

export async function runHook(stdin: string, d: Deps): Promise<{ stdout: string; exitCode: 0 }> {
  const none = { stdout: "", exitCode: 0 as const };
  try {
    const input = JSON.parse(stdin);
    if (input?.tool_name !== "Bash") return none;
    const command = input?.tool_input?.command;
    if (typeof command !== "string") return none;
    const baseCwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
    const segs = parseCommand(command, baseCwd);
    if (segs.length === 0) return none;

    const start = d.now();
    const sshConfig = d.readFile(path.join(d.home, ".ssh", "config"));
    let notice: string | null = null;

    for (const seg of segs) {
      const opts: { allowSpawn: boolean; remoteName?: string; remoteOverride?: Remote } = { allowSpawn: true };
      if (seg.remoteUrl !== undefined) {
        const r = parseRemoteUrl(seg.remoteUrl, sshConfig);
        if (!r) continue;
        opts.remoteOverride = r;
      } else if (seg.ghRepo !== undefined) {
        const [owner, repo] = seg.ghRepo.split("/");
        if (!owner || !repo) continue;
        opts.remoteOverride = { protocol: "https", host: "github.com", sshAlias: null, owner, repo };
      } else if (seg.kind === "pr") {
        opts.remoteName = prRemoteName(findRepo(seg.cwd, d));
      } else if (seg.kind === "push" && seg.remoteName) {
        opts.remoteName = seg.remoteName;
      }

      let g = gatherFacts(seg.cwd, d, opts);
      if (g.needsLearn) {
        const remaining = BUDGET_MS - (d.now() - start);
        if (remaining > 0) {
          const logins = g.facts.hosts?.logins ?? [];
          const entry = await learnRepo(g.needsLearn.owner, g.needsLearn.repo, logins, d, remaining);
          if (entry) {
            writeLearned(d, `${g.needsLearn.owner}/${g.needsLearn.repo}`, entry);
            g = gatherFacts(seg.cwd, d, opts);
          }
        }
      }
      if (seg.emailOverride !== undefined) g.facts.email = seg.emailOverride;

      const v = evaluate(seg.kind, g.facts);
      if (v.state === "MISMATCH") {
        const reason = `claude-gh-guard: ${v.problems.join("; ")}. Fix: ${v.fixes.join(" && ")}`;
        return {
          stdout: JSON.stringify({
            hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
          }),
          exitCode: 0,
        };
      }
      if (notice === null && (v.state === "AMBIGUOUS" || v.state === "UNKNOWN" || v.state === "UNAUTH")) {
        const r = g.facts.remote;
        notice = `claude-gh-guard: ${v.state} for ${r ? `${r.owner}/${r.repo}` : "this directory"} — not blocked. Run claude-gh-guard doctor.`;
      }
    }
    return notice ? { stdout: JSON.stringify({ systemMessage: notice }), exitCode: 0 } : none;
  } catch (e) {
    logError(d, e);
    return none;
  }
}
