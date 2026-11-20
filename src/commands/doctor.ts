import type { Deps } from "../deps.ts";
import { ghConfigDir } from "../paths.ts";
import { gatherFacts } from "../gather.ts";
import { evaluate } from "../evaluate.ts";
import { effectiveEmail } from "../gitRepo.ts";
import { readLearned } from "../learn.ts";
import { readClaudeAccount, claudeStatePath } from "../claudeAccount.ts";
import { checkMoved, readMoved, writeMoved, isMovedFresh, movedKey, movedTo, setUrlFix } from "../moved.ts";

export async function runDoctor(cwd: string, d: Deps): Promise<string> {
  const t0 = Date.now();
  const { facts, repo } = gatherFacts(cwd, d, { allowSpawn: true });
  const ms = Date.now() - t0;
  const v = evaluate("status", facts);
  const logins = facts.hosts?.logins ?? [];
  const exp = facts.expected;
  const remote = facts.remote;

  let expected = "(none)";
  if (exp) {
    if (exp.ambiguous) expected = "(ambiguous)";
    else if (exp.login) expected = exp.login;
    if (exp.source === "learned" && remote) {
      const e = readLearned(d)[`${remote.owner}/${remote.repo}`.toLowerCase()];
      expected += e ? ` (learned: ${e.basis}, pushers: ${e.pushers.join(", ") || "none"})` : " (learned)";
    } else {
      expected += ` (${exp.source})`;
    }
  }

  let push = "(n/a)";
  if (facts.push) push = facts.push.via === "unknown" ? "unknown" : `${facts.push.login ?? "unknown"} via ${facts.push.via}`;

  let moved = "(n/a)";
  if (remote && remote.host.toLowerCase() === "github.com") {
    const cached = readMoved(d)[movedKey(remote)];
    if (!cached || !isMovedFresh(cached, d.now())) {
      const e = await checkMoved(remote.owner, remote.repo, logins, facts.hosts?.active ?? null, d, 5000);
      if (e) writeMoved(d, `${remote.owner}/${remote.repo}`, e);
    }
    const to = movedTo(d, remote);
    const entry = readMoved(d)[movedKey(remote)];
    if (to) moved = `yes, now ${to} - fix: ${setUrlFix(remote, to, facts.remoteName)}`;
    else if (entry && isMovedFresh(entry, d.now())) moved = entry.fullName ? "no" : "unknown (no login can see the repo)";
    else moved = "unknown (GitHub API check failed)";
  }

  const email = repo ? effectiveEmail(repo, d) : { email: null, source: "none" };
  const claude = readClaudeAccount(d);

  const out = [
    `gh config: ${ghConfigDir(d)}${facts.hosts ? ` (${facts.hosts.hostsFile})` : " (hosts.yml not found)"}`,
    `logins: ${logins.length ? logins.join(", ") : "(none)"}`,
    `active: ${facts.hosts?.active ?? "(none)"}`,
    `repo: ${repo ? repo.workTree : "(not a git repo)"}`,
    `remote: ${remote ? `${facts.remoteName} -> ${remote.host}/${remote.owner}/${remote.repo} (${remote.protocol}${remote.sshAlias ? `, alias ${remote.sshAlias}` : ""})` : "(none)"}`,
    `moved: ${moved}`,
    `email: ${email.email ?? "(none)"} (${email.source})`,
    `push identity: ${push}`,
    `expected: ${expected}`,
    `state: ${v.state}${v.problems.length ? ` - ${v.problems.join("; ")}` : ""}`,
    `claude: ${claude ? [claude.email, claude.org].filter(Boolean).join(", ") + (claude.plan ? ` (${claude.plan})` : "") : "(not found)"} [${claudeStatePath(d)}]`,
    `time: ${ms} ms`,
  ];

  if (v.state === "AMBIGUOUS" && remote) {
    const pin = logins.find((l) => l.toLowerCase() === (facts.hosts?.active ?? "").toLowerCase()) ?? logins[0] ?? "<login>";
    out.push(
      "",
      "Several of your accounts can push here. To pin one, add to ~/.gh-guard.json:",
      JSON.stringify({ profiles: { pinned: { ghUser: pin, owners: [remote.owner] } } }, null, 2).replace(
        `"owners": [\n        "${remote.owner}"\n      ]`,
        `"owners": ["${remote.owner}"]`,
      ),
    );
  }
  return out.join("\n");
}
