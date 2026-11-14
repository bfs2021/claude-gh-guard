import type { Deps } from "../deps.ts";
import { ghConfigDir } from "../paths.ts";
import { gatherFacts } from "../gather.ts";
import { evaluate } from "../evaluate.ts";
import { effectiveEmail } from "../gitRepo.ts";
import { readLearned } from "../learn.ts";

export function runDoctor(cwd: string, d: Deps): string {
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

  const email = repo ? effectiveEmail(repo, d) : { email: null, source: "none" };

  const out = [
    `gh config: ${ghConfigDir(d)}${facts.hosts ? ` (${facts.hosts.hostsFile})` : " (hosts.yml not found)"}`,
    `logins: ${logins.length ? logins.join(", ") : "(none)"}`,
    `active: ${facts.hosts?.active ?? "(none)"}`,
    `repo: ${repo ? repo.workTree : "(not a git repo)"}`,
    `remote: ${remote ? `${facts.remoteName} -> ${remote.host}/${remote.owner}/${remote.repo} (${remote.protocol}${remote.sshAlias ? `, alias ${remote.sshAlias}` : ""})` : "(none)"}`,
    `email: ${email.email ?? "(none)"} (${email.source})`,
    `push identity: ${push}`,
    `expected: ${expected}`,
    `state: ${v.state}${v.problems.length ? ` - ${v.problems.join("; ")}` : ""}`,
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
