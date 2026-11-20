import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fakeDeps } from "./helpers.ts";
import { runHook } from "../src/commands/hook.ts";

const HOSTS = `github.com:
    user: alice
    users:
        alice:
        bob-work:
`;
const home = "/home/test";
const hostsPath = path.join(home, ".config", "gh", "hosts.yml");
const R = path.resolve("/w/r");
const learnedPath = path.join(home, ".claude-gh-guard", "learned.json");
const errPath = path.join(home, ".claude-gh-guard", "error.log");
const LOGINS = "alice,bob-work";

function files(url: string, extra: Record<string, string> = {}, cfg = "") {
  return {
    [hostsPath]: HOSTS,
    [path.join(R, ".git", "HEAD")]: "ref: refs/heads/main\n",
    [path.join(R, ".git", "config")]: `[remote "origin"]\n\turl = ${url}\n${cfg}`,
    ...extra,
  };
}
const learned = (key: string, expected: string | null) =>
  JSON.stringify({
    [key]: { pushers: expected ? [expected] : [], expected, basis: expected ? "single" : "none", checkedAt: 0, loginsKey: LOGINS },
  });
const input = (command: string, tool = "Bash") => JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: R });
const ghTokens = (cmd: string, args: string[]) =>
  cmd === "gh" ? { code: 0, stdout: `tok_${args[3]}`, stderr: "" } : { code: 1, stdout: "", stderr: "" };

test("work repo, personal ssh key → deny push with fix", async () => {
  const d = fakeDeps({
    files: files("git@github.com:corp/app.git", { [learnedPath]: learned("corp/app", "bob-work") }),
    exec: (cmd) =>
      cmd === "ssh"
        ? { code: 1, stdout: "", stderr: "Hi alice! You have successfully authenticated" }
        : { code: 1, stdout: "", stderr: "" },
  });
  const r = await runHook(input("git push origin main"), d);
  const j = JSON.parse(r.stdout);
  assert.equal(j.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(j.hookSpecificOutput.permissionDecision, "deny");
  assert.match(j.hookSpecificOutput.permissionDecisionReason, /^claude-gh-guard: .*Fix: .*git remote set-url origin/);
  assert.equal(r.exitCode, 0);
});

test("pr with wrong gh account → deny with gh auth switch", async () => {
  const d = fakeDeps({ files: files("git@github.com:corp/app.git", { [learnedPath]: learned("corp/app", "bob-work") }) });
  const j = JSON.parse((await runHook(input("gh pr create --fill"), d)).stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, "deny");
  assert.match(j.hookSpecificOutput.permissionDecisionReason, /gh auth switch --user bob-work/);
});

test("pr --repo uses that repo regardless of origin", async () => {
  const d = fakeDeps({ files: files("git@github.com:alice/x.git", { [learnedPath]: learned("corp/app", "bob-work") }) });
  const j = JSON.parse((await runHook(input("gh pr create -R corp/app"), d)).stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, "deny");
});

test("pr without --repo prefers gh-resolved remote, then upstream", async () => {
  const cfg = `[remote "upstream"]\n\turl = git@github.com:corp/app.git\n`;
  const ex = { [learnedPath]: learned("corp/app", "bob-work") };
  let d = fakeDeps({ files: files("git@github.com:alice/x.git", ex, cfg) });
  assert.equal(JSON.parse((await runHook(input("gh pr create"), d)).stdout).hookSpecificOutput.permissionDecision, "deny");
  d = fakeDeps({ files: files("git@github.com:alice/x.git", ex, cfg + `[remote "origin"]\n\tgh-resolved = base\n`) });
  assert.equal((await runHook(input("gh pr create"), d)).stdout, "");
});

test("commit with -c personal noreply in work repo → deny", async () => {
  const d = fakeDeps({ files: files("https://github.com/corp/app.git", { [learnedPath]: learned("corp/app", "bob-work") }) });
  const j = JSON.parse((await runHook(input("git -c user.email=1+alice@users.noreply.github.com commit -m x"), d)).stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, "deny");
  assert.match(j.hookSpecificOutput.permissionDecisionReason, /git config user.email/);
});

test("matching identity → empty", async () => {
  const d = fakeDeps({ files: files("https://github.com/alice/x.git") });
  assert.equal((await runHook(input("git commit -m x"), d)).stdout, "");
});

test("unknown org, API timeout → allow with systemMessage", async () => {
  const d = fakeDeps({
    files: files("https://github.com/corp/app.git"),
    exec: ghTokens,
    fetch: (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch,
  });
  const r = await runHook(input("git commit -m x"), d);
  assert.equal(JSON.parse(r.stdout).systemMessage, "claude-gh-guard: UNKNOWN for corp/app — not blocked. Run claude-gh-guard doctor.");
});

test("learns synchronously and persists, then denies", async () => {
  const d = fakeDeps({
    files: files("https://github.com/corp/app.git"),
    exec: ghTokens,
    fetch: (async (_u: string, init: RequestInit) => {
      const tok = (init.headers as Record<string, string>).Authorization!;
      return new Response(JSON.stringify({ permissions: { push: tok.endsWith("bob-work") } }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const r = await runHook(input("gh pr create"), d);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(d.readFile(learnedPath) ?? "", /bob-work/);
});

test("non-Bash tool and unguarded command → empty", async () => {
  const d = fakeDeps({ files: files("https://github.com/corp/app.git") });
  assert.equal((await runHook(input("git commit -m x", "Edit"), d)).stdout, "");
  assert.equal((await runHook(input("ls -la"), d)).stdout, "");
});

test("internal error → empty stdout, error logged", async () => {
  const base = fakeDeps({ files: files("https://github.com/corp/app.git") });
  const d = {
    ...base,
    readFile: (p: string) => {
      if (p.endsWith("hosts.yml")) throw new Error("boom");
      return base.readFile(p);
    },
  };
  const r = await runHook(input("git commit -m x"), d);
  assert.deepEqual(r, { stdout: "", exitCode: 0 });
  assert.match(base.readFile(errPath) ?? "", /boom/);
});

test("invalid stdin → empty", async () => {
  assert.equal((await runHook("not json", fakeDeps())).stdout, "");
});

test("partial learning (token exec fails for one login) → no deny, nothing persisted", async () => {
  const d = fakeDeps({
    files: files("https://github.com/corp/app.git"),
    exec: (cmd, args) =>
      cmd === "gh" && args[3] === "alice"
        ? ({ code: null, stdout: "", stderr: "" } as unknown as { code: number; stdout: string; stderr: string })
        : ghTokens(cmd, args),
    fetch: (async () => new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 })) as unknown as typeof fetch,
  });
  const r = await runHook(input("gh pr create"), d);
  assert.ok(!r.stdout.includes("deny"));
  assert.equal(d.readFile(learnedPath), null);
});

test("explicit push URL fix does not name a remote", async () => {
  const d = fakeDeps({
    files: files("git@github.com:alice/x.git", { [learnedPath]: learned("corp/app", "bob-work") }),
    exec: (cmd) =>
      cmd === "ssh" ? { code: 1, stdout: "", stderr: "Hi alice!" } : { code: 1, stdout: "", stderr: "" },
  });
  const j = JSON.parse((await runHook(input("git push git@github.com:corp/app.git main"), d)).stdout);
  const reason = j.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /push to git@<alias>:corp\/app\.git/);
  assert.doesNotMatch(reason, /set-url/);
});

test("-R accepts HOST/OWNER/REPO; other hosts are allowed", async () => {
  const d = fakeDeps({ files: files("git@github.com:alice/x.git", { [learnedPath]: learned("corp/app", "bob-work") }) });
  const j = JSON.parse((await runHook(input("gh pr create -R github.com/corp/app"), d)).stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, "deny");
  assert.equal((await runHook(input("gh pr create -R ghe.corp/x/y"), d)).stdout, "");
  assert.equal((await runHook(input("gh pr create -R a/b/c/d"), d)).stdout, "");
});

test("commit segments never probe ssh", async () => {
  const calls: string[] = [];
  const d = fakeDeps({
    files: files("git@github.com:corp/app.git", { [learnedPath]: learned("corp/app", "bob-work") }),
    exec: (cmd) => { calls.push(cmd); return { code: 1, stdout: "", stderr: "" }; },
  });
  await runHook(input("git commit -m x"), d);
  assert.ok(!calls.includes("ssh"));
});

test("pr -R outside a git repo still evaluates", async () => {
  const d = fakeDeps({ files: { [hostsPath]: HOSTS, [learnedPath]: learned("corp/app", "bob-work") } });
  const j = JSON.parse((await runHook(input("gh pr create -R corp/app"), d)).stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, "deny");
});

const sshCfg = path.join(home, ".ssh", "config");
const ALIASES = "Host github-personal github-work\n  HostName github.com\n";

// --- push identity must follow what git actually uses (no false denies) ---
const workRepoPersonalKey = (extra: { env?: Record<string, string>; cfg?: string; git?: (args: string[]) => string | null } = {}) => {
  const sshCalls: string[] = [];
  const d = fakeDeps({
    env: extra.env ?? {},
    files: files("git@github.com:corp/app.git", { [learnedPath]: learned("corp/app", "bob-work") }, extra.cfg ?? ""),
    exec: (cmd, args) => {
      if (cmd === "ssh") {
        sshCalls.push(args[args.length - 1]!);
        return { code: 1, stdout: "", stderr: "Hi alice! You have successfully authenticated" };
      }
      const out = cmd === "git" && extra.git ? extra.git(args) : null;
      return out === null ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: out, stderr: "" };
    },
  });
  return { d, sshCalls };
};

test("core.sshCommand in repo config → push not denied", async () => {
  const { d, sshCalls } = workRepoPersonalKey({ cfg: `[core]\n\tsshCommand = ssh -i ~/.ssh/work_key\n` });
  assert.ok(!(await runHook(input("git push origin main"), d)).stdout.includes("deny"));
  assert.deepEqual(sshCalls, []);
});

test("global core.sshCommand (git config stub) → push not denied", async () => {
  const { d } = workRepoPersonalKey({ git: (a) => (a.join(" ") === "config core.sshCommand" ? "ssh -i ~/.ssh/work_key\n" : null) });
  assert.ok(!(await runHook(input("git push origin main"), d)).stdout.includes("deny"));
});

test("GIT_SSH_COMMAND env → push not denied, also for an explicit push URL", async () => {
  const { d } = workRepoPersonalKey({ env: { GIT_SSH_COMMAND: "ssh -i ~/.ssh/work_key" } });
  assert.ok(!(await runHook(input("git push origin main"), d)).stdout.includes("deny"));
  assert.ok(!(await runHook(input("git push git@github.com:corp/app.git main"), d)).stdout.includes("deny"));
});

test("push URL resolved by git (pushurl/insteadOf): identity probed on the resolved alias", async () => {
  // config url is https (unknown helper → no deny); git resolves the push URL to the personal alias
  const sshCalls: string[] = [];
  const d = fakeDeps({
    files: files("https://github.com/corp/app.git", { [learnedPath]: learned("corp/app", "bob-work"), [sshCfg]: ALIASES }),
    exec: (cmd, args, opts) => {
      if (cmd === "ssh") {
        sshCalls.push(args[args.length - 1]!);
        return { code: 1, stdout: "", stderr: "Hi alice!" };
      }
      if (cmd === "git" && args.join(" ") === "remote get-url --push origin") {
        assert.equal(opts?.cwd, R);
        return { code: 0, stdout: "git@github-personal:corp/app.git\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  const j = JSON.parse((await runHook(input("git push origin main"), d)).stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(sshCalls, ["git@github-personal"]);
});

test("push URL resolved to the work alias → not denied though the config url is personal", async () => {
  const d = fakeDeps({
    files: files("git@github-personal:corp/app.git", { [learnedPath]: learned("corp/app", "bob-work"), [sshCfg]: ALIASES }),
    exec: (cmd, args) => {
      if (cmd === "ssh") {
        const who = args[args.length - 1] === "git@github-work" ? "bob-work" : "alice";
        return { code: 1, stdout: "", stderr: `Hi ${who}!` };
      }
      if (cmd === "git" && args.join(" ") === "remote get-url --push origin") {
        return { code: 0, stdout: "git@github-work:corp/app.git\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  assert.equal((await runHook(input("git push origin main"), d)).stdout, "");
});

const learnFetch = (async (_u: string, init: RequestInit) => {
  const tok = (init.headers as Record<string, string>).Authorization!;
  return new Response(JSON.stringify({ permissions: { push: tok.endsWith("bob-work") } }), { status: 200 });
}) as unknown as typeof fetch;

test("after learning, push is judged on the git-resolved URL (not re-read from config)", async () => {
  const d = fakeDeps({
    files: files("https://github.com/corp/app.git", { [sshCfg]: ALIASES }),
    fetch: learnFetch,
    exec: (cmd, args) => {
      if (cmd === "gh") return ghTokens(cmd, args);
      if (cmd === "ssh") return { code: 1, stdout: "", stderr: "Hi alice!" };
      if (cmd === "git" && args.join(" ") === "remote get-url --push origin") {
        return { code: 0, stdout: "git@github-personal:corp/app.git\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  const j = JSON.parse((await runHook(input("git push origin main"), d)).stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, "deny");
});

test("after learning, a failed ssh probe is not replaced by the cached login", async () => {
  const d = fakeDeps({
    files: files("git@github.com:corp/app.git", {
      [path.join(home, ".claude-gh-guard", "ssh.json")]: JSON.stringify({ "github.com": { login: "alice", key: 0 } }),
    }),
    fetch: learnFetch,
    exec: (cmd, args) => (cmd === "gh" ? ghTokens(cmd, args) : { code: 255, stdout: "", stderr: "timeout" }),
  });
  const r = await runHook(input("git push origin main"), d);
  assert.ok(!r.stdout.includes("deny"), r.stdout);
});

const movedPath = path.join(home, ".claude-gh-guard", "moved.json");

test("moved repo: allowed commands get a systemMessage with the set-url fix", async () => {
  const d = fakeDeps({ files: files("git@github.com:alice/x.git", { [movedPath]: JSON.stringify({ "alice/x": { fullName: "corp/x", checkedAt: 0 } }) }) });
  const r = await runHook(input("git commit -m x"), d);
  assert.equal(
    JSON.parse(r.stdout).systemMessage,
    "claude-gh-guard: alice/x has moved to corp/x on GitHub; update the remote: git remote set-url origin git@github.com:corp/x.git",
  );
});

test("moved repo: a deny carries the note too", async () => {
  const d = fakeDeps({
    files: files("https://github.com/alice/x.git", { [movedPath]: JSON.stringify({ "alice/x": { fullName: "corp/x", checkedAt: 0 } }) }, "[user]\n\temail = 1+bob-work@users.noreply.github.com\n"),
  });
  const out = JSON.parse((await runHook(input("git commit -m x"), d)).stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /Note: alice\/x has moved to corp\/x on GitHub; update the remote: git remote set-url origin https:\/\/github\.com\/corp\/x\.git/);
});

test("moved repo with an explicit gh -R: no set-url, notice joins other notices", async () => {
  const d = fakeDeps({
    files: files("https://github.com/alice/x.git", { [movedPath]: JSON.stringify({ "corp/app": { fullName: "corp2/app", checkedAt: 0 } }) }),
    exec: ghTokens,
    fetch: (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch,
  });
  const r = await runHook(input("gh pr create -R corp/app"), d);
  assert.equal(
    JSON.parse(r.stdout).systemMessage,
    "claude-gh-guard: UNKNOWN for corp/app — not blocked. Run claude-gh-guard doctor.\nclaude-gh-guard: corp/app has moved to corp2/app on GitHub; update the remote: use corp2/app instead",
  );
});
