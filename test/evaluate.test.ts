import { test } from "node:test";
import assert from "node:assert/strict";
import type { LearnedEntry } from "../src/learn.ts";
import { evaluate, resolveExpected, noreplyLogin, type Expected, type Facts } from "../src/evaluate.ts";

const remote = { protocol: "ssh", host: "github.com", sshAlias: null, owner: "corp", repo: "app" } as const;
const hosts = { active: "alice", logins: ["alice", "bob-work"], hostsFile: "" };
const exp = (login: string | null, extra = {}) =>
  ({ login, source: "learned", ambiguous: false, emails: [], ...extra }) as Expected;
const facts = (o: Partial<Facts>): Facts => ({
  hosts, remote, email: null, push: null, expected: exp("bob-work"), remoteName: "origin", ...o,
});

test("pr with wrong gh account -> MISMATCH with gh fix", () => {
  const v = evaluate("pr", facts({}));
  assert.equal(v.state, "MISMATCH");
  assert.ok(v.fixes.includes("gh auth switch --user bob-work"));
  assert.deepEqual(v.problems, ["gh account is alice, expected bob-work"]);
  assert.equal(v.active, "alice");
  assert.equal(v.expected, "bob-work");
});

test("pr with matching gh account (case-insensitive) -> MATCH", () => {
  assert.equal(evaluate("pr", facts({ hosts: { ...hosts, active: "BOB-work" } })).state, "MATCH");
});

test("commit ignores gh account; checks noreply email", () => {
  const bad = evaluate("commit", facts({ email: "12345+alice@users.noreply.github.com" }));
  assert.equal(bad.state, "MISMATCH");
  assert.deepEqual(bad.problems, [
    "author email 12345+alice@users.noreply.github.com belongs to alice, expected bob-work",
  ]);
  assert.deepEqual(bad.fixes, ["git config user.email <id>+bob-work@users.noreply.github.com"]);
  assert.equal(evaluate("commit", facts({ email: "me@company.com" })).state, "MATCH");
});

test("commit with profile emails requires membership", () => {
  const e = exp("bob-work", { source: "profile", emails: ["Me@Corp.com"] });
  assert.equal(evaluate("commit", facts({ expected: e, email: "me@corp.com" })).state, "MATCH");
  const v = evaluate("commit", facts({ expected: e, email: "other@x.com" }));
  assert.equal(v.state, "MISMATCH");
  assert.deepEqual(v.fixes, ["git config user.email Me@Corp.com"]);
});

test("commit without hosts still evaluates email", () => {
  const v = evaluate("commit", facts({ hosts: null, email: "1+alice@users.noreply.github.com" }));
  assert.equal(v.state, "MISMATCH");
  assert.equal(v.active, null);
});

test("push over ssh uses key owner, not gh account", () => {
  const v = evaluate("push", facts({
    hosts: { ...hosts, active: "bob-work" },
    push: { via: "ssh", login: "alice" },
  }));
  assert.equal(v.state, "MISMATCH");
  assert.deepEqual(v.problems, ["push over ssh uses alice's key, expected bob-work"]);
  assert.deepEqual(v.fixes, [
    "Configure an SSH key for bob-work (e.g. a Host alias in ~/.ssh/config) and set the remote: git remote set-url origin git@<alias>:corp/app.git",
  ]);
});

test("push via gh with wrong login -> MISMATCH; right login -> MATCH", () => {
  assert.equal(evaluate("push", facts({ push: { via: "gh", login: "alice" } })).state, "MISMATCH");
  assert.equal(evaluate("push", facts({ push: { via: "gh", login: "bob-work" } })).state, "MATCH");
});

test("push via unknown helper or null login -> not MISMATCH", () => {
  assert.equal(evaluate("push", facts({ push: { via: "unknown" } })).state, "MATCH");
  assert.equal(evaluate("push", facts({ push: { via: "ssh", login: null } })).state, "MATCH");
  assert.equal(evaluate("push", facts({ push: null })).state, "MATCH");
});

test("ambiguous expected -> AMBIGUOUS, never MISMATCH", () => {
  const e = exp(null, { ambiguous: true });
  const v = evaluate("status", facts({ expected: e, email: "1+alice@users.noreply.github.com", push: { via: "ssh", login: "alice" } }));
  assert.equal(v.state, "AMBIGUOUS");
  assert.equal(v.expected, null);
});

test("expected null login -> UNKNOWN; null expected -> UNKNOWN", () => {
  assert.equal(evaluate("pr", facts({ expected: exp(null) })).state, "UNKNOWN");
  assert.equal(evaluate("commit", facts({ expected: null, email: "a@b.c" })).state, "UNKNOWN");
});

test("no remote or non-github host -> UNTRACKED", () => {
  assert.equal(evaluate("pr", facts({ remote: null })).state, "UNTRACKED");
  assert.equal(evaluate("commit", facts({ remote: { ...remote, host: "gitlab.com" } })).state, "UNTRACKED");
  assert.equal(evaluate("commit", facts({ remote: { ...remote, host: "GitHub.com" }, email: "me@company.com" })).state, "MATCH");
});

test("no hosts / no active on pr or status -> UNAUTH, not on commit/push", () => {
  assert.equal(evaluate("pr", facts({ hosts: null })).state, "UNAUTH");
  assert.equal(evaluate("status", facts({ hosts: { ...hosts, active: null } })).state, "UNAUTH");
  assert.equal(evaluate("push", facts({ hosts: null })).state, "MATCH");
});

test("status runs all checks and dedups fixes", () => {
  const v = evaluate("status", facts({ email: "1+alice@users.noreply.github.com", push: { via: "gh", login: "alice" } }));
  assert.equal(v.state, "MISMATCH");
  assert.equal(v.problems.length, 3);
  assert.equal(v.fixes.filter((x) => x === "gh auth switch --user bob-work").length, 1);
});

test("noreplyLogin", () => {
  assert.equal(noreplyLogin("1+Foo-Bar@users.noreply.github.com"), "Foo-Bar");
  assert.equal(noreplyLogin("foo@users.noreply.github.com"), "foo");
  assert.equal(noreplyLogin("foo@company.com"), null);
});

test("resolveExpected: precedence and casing", () => {
  const logins = ["Corp", "bob-work"];
  const learned: LearnedEntry = { pushers: [], expected: "bob-work", basis: "single", checkedAt: 0, loginsKey: "" };
  const profiles = [{ name: "w", ghUser: "bob-work", gitEmails: ["a@b.c"], owners: ["CORP"] }];
  const r = { ...remote, owner: "corp" };
  assert.deepEqual(resolveExpected(r, logins, profiles, learned), { login: "bob-work", source: "profile", ambiguous: false, emails: ["a@b.c"] });
  assert.deepEqual(resolveExpected(r, logins, [], learned), { login: "Corp", source: "owner", ambiguous: false, emails: [] });
  const r2 = { ...remote, owner: "other" };
  assert.equal(resolveExpected(r2, logins, [], learned).source, "learned");
  assert.equal(resolveExpected(r2, ["BOB-work"], [], learned).login, "BOB-work");
  assert.equal(resolveExpected(r2, logins, [], { ...learned, basis: "ambiguous", expected: null }).ambiguous, true);
  assert.deepEqual(resolveExpected(r2, logins, [], undefined), { login: null, source: "none", ambiguous: false, emails: [] });
  assert.equal(resolveExpected(r2, logins, [], { ...learned, basis: "none", expected: null }).source, "none");
});

test("push ssh fix without a named remote says push to the url", () => {
  const v = evaluate("push", facts({
    hosts: { ...hosts, active: "bob-work" },
    push: { via: "ssh", login: "alice" },
    remoteName: "",
  }));
  assert.deepEqual(v.fixes, [
    "Configure an SSH key for bob-work (e.g. a Host alias in ~/.ssh/config) and push to git@<alias>:corp/app.git",
  ]);
});
