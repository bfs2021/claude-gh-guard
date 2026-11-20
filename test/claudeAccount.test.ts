import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fakeDeps } from "./helpers.ts";
import { claudeStatePath, readClaudeAccount, formatClaudeAccount } from "../src/claudeAccount.ts";
import { runStatusline } from "../src/commands/statusline.ts";
import { runDoctor } from "../src/commands/doctor.ts";

const home = "/home/test";
const defaultPath = path.join(home, ".claude.json");
const state = (oauthAccount: unknown) => JSON.stringify({ numStartups: 3, projects: {}, oauthAccount });
const personal = { emailAddress: "me@corp.example", organizationName: "me@corp.example's Organization", organizationType: "claude_max" };

test("claudeStatePath: CLAUDE_CONFIG_DIR wins, else ~/.claude.json", () => {
  assert.equal(claudeStatePath(fakeDeps()), defaultPath);
  assert.equal(claudeStatePath(fakeDeps({ env: { CLAUDE_CONFIG_DIR: "/cfg/work" } })), path.join("/cfg/work", ".claude.json"));
});

test("personal plan shows the email domain and the plan", () => {
  const d = fakeDeps({ files: { [defaultPath]: state(personal) } });
  const a = readClaudeAccount(d);
  assert.deepEqual(a, { label: "corp.example", plan: "max", email: "me@corp.example", org: "me@corp.example's Organization" });
  assert.equal(formatClaudeAccount(a!), "claude:corp.example (max)");
});

test("a real organization shows its name", () => {
  const d = fakeDeps({ files: { [defaultPath]: state({ emailAddress: "me@corp.example", organizationName: "Corp Inc", organizationType: "claude_team" }) } });
  assert.equal(formatClaudeAccount(readClaudeAccount(d)!), "claude:Corp Inc (team)");
});

test("reads the account of CLAUDE_CONFIG_DIR", () => {
  const d = fakeDeps({
    env: { CLAUDE_CONFIG_DIR: "/cfg/work" },
    files: { [defaultPath]: state({ emailAddress: "me@gmail.com" }), [path.join("/cfg/work", ".claude.json")]: state(personal) },
  });
  assert.equal(readClaudeAccount(d)?.label, "corp.example");
});

test("no plan type: label only", () => {
  const d = fakeDeps({ files: { [defaultPath]: state({ emailAddress: "me@gmail.com" }) } });
  assert.equal(formatClaudeAccount(readClaudeAccount(d)!), "claude:gmail.com");
});

test("missing file, invalid JSON, no account, no email or org → null", () => {
  assert.equal(readClaudeAccount(fakeDeps()), null);
  assert.equal(readClaudeAccount(fakeDeps({ files: { [defaultPath]: "{not json" } })), null);
  assert.equal(readClaudeAccount(fakeDeps({ files: { [defaultPath]: JSON.stringify({ projects: {} }) } })), null);
  assert.equal(readClaudeAccount(fakeDeps({ files: { [defaultPath]: state({ organizationType: "claude_pro" }) } })), null);
  assert.equal(readClaudeAccount(fakeDeps({ files: { [defaultPath]: state("nope") } })), null);
});

// --- status line and doctor ---

const HOSTS = "github.com:\n    user: alice\n    users:\n        alice:\n";
const hostsPath = path.join(home, ".config", "gh", "hosts.yml");
const repoFiles = {
  [hostsPath]: HOSTS,
  [path.join(path.resolve("/w/r"), ".git", "HEAD")]: "ref: refs/heads/main\n",
  [path.join(path.resolve("/w/r"), ".git", "config")]: '[remote "origin"]\n\turl = git@github.com:alice/x.git\n',
};
const stdin = JSON.stringify({ workspace: { current_dir: "/w/r" } });

test("status line appends the Claude account after the gh segment", () => {
  const d = fakeDeps({ env: { NO_COLOR: "1" }, files: { ...repoFiles, [defaultPath]: state(personal) } });
  assert.equal(runStatusline(stdin, [], d), "🟢 gh:alice · claude:corp.example (max)");
});

test("status line without a Claude account is unchanged", () => {
  const d = fakeDeps({ env: { NO_COLOR: "1" }, files: repoFiles });
  assert.equal(runStatusline(stdin, [], d), "🟢 gh:alice");
});

test("Claude account is read fresh on a cached render", () => {
  const d = fakeDeps({ env: { NO_COLOR: "1" }, files: { ...repoFiles, [defaultPath]: state(personal) } });
  assert.equal(runStatusline(stdin, [], d), "🟢 gh:alice · claude:corp.example (max)");
  d.writeFile(defaultPath, state({ emailAddress: "me@gmail.com", organizationType: "claude_pro" }));
  assert.equal(runStatusline(stdin, [], d), "🟢 gh:alice · claude:gmail.com (pro)");
});

test("status line colors the Claude account dim, outside the state color", () => {
  const d = fakeDeps({ files: { ...repoFiles, [defaultPath]: state(personal) } });
  assert.equal(runStatusline(stdin, [], d), "\x1b[32m🟢 gh:alice\x1b[0m \x1b[2m· claude:corp.example (max)\x1b[0m");
});

test("status line --ascii uses an ascii separator", () => {
  const d = fakeDeps({ env: { NO_COLOR: "1" }, files: { ...repoFiles, [defaultPath]: state(personal) } });
  assert.equal(runStatusline(stdin, ["--ascii"], d), "[OK] gh:alice | claude:corp.example (max)");
});

test("doctor prints the Claude account and where it was read", async () => {
  const d = fakeDeps({ files: { ...repoFiles, [defaultPath]: state(personal) } });
  const out = await runDoctor(path.resolve("/w/r"), d);
  assert.ok(out.split("\n").includes(`claude: me@corp.example, me@corp.example's Organization (max) [${defaultPath}]`), out);
  const none = await runDoctor(path.resolve("/w/r"), fakeDeps({ files: repoFiles }));
  assert.ok(none.split("\n").includes(`claude: (not found) [${defaultPath}]`), none);
});
