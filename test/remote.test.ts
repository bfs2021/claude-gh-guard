import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRemoteUrl, resolveSshHost } from "../src/remote.ts";

test("https", () => assert.deepEqual(parseRemoteUrl("https://github.com/Org/Repo.git", null), { protocol: "https", host: "github.com", sshAlias: null, owner: "Org", repo: "Repo" }));
test("https with user@ and no .git", () => assert.equal(parseRemoteUrl("https://me@github.com/o/r", null)?.owner, "o"));
test("https trailing slash", () => assert.equal(parseRemoteUrl("https://github.com/o/r.git/", null)?.repo, "r"));
test("scp-style", () => assert.deepEqual(parseRemoteUrl("git@github.com:o/r.git", null), { protocol: "ssh", host: "github.com", sshAlias: null, owner: "o", repo: "r" }));
test("ssh:// with port", () => assert.equal(parseRemoteUrl("ssh://git@github.com:22/o/r.git", null)?.repo, "r"));
test("alias resolved", () => {
  const cfg = "Host github.com-work\n  HostName github.com\n  IdentityFile ~/.ssh/work\n";
  assert.deepEqual(parseRemoteUrl("git@github.com-work:corp/app.git", cfg), { protocol: "ssh", host: "github.com", sshAlias: "github.com-work", owner: "corp", repo: "app" });
});
test("non-github host still parsed", () => assert.equal(parseRemoteUrl("https://gitlab.com/o/r", null)?.host, "gitlab.com"));
test("missing repo → null", () => assert.equal(parseRemoteUrl("https://github.com/o", null), null));
test("garbage → null", () => assert.equal(parseRemoteUrl("/local/path/repo", null), null));

test("resolve: case-insensitive keywords, Key=value, multiple patterns, comments", () => {
  const cfg = "# c\nhost a b.example  # trailing\n  hostname=real.host\n";
  assert.equal(resolveSshHost("b.example", cfg), "real.host");
  assert.equal(resolveSshHost("A", cfg), "real.host");
});
test("resolve: globs, first match wins, negation skipped", () => {
  const cfg = "Host !skip *.corp\n  HostName first\nHost *\n  HostName second\n";
  assert.equal(resolveSshHost("x.corp", cfg), "first");
  assert.equal(resolveSshHost("skip", cfg), "second");
  assert.equal(resolveSshHost("h?", "Host h?\n HostName q\n"), "q");
});
test("resolve: no match or null → alias", () => {
  assert.equal(resolveSshHost("foo", "Host bar\n HostName x\n"), "foo");
  assert.equal(resolveSshHost("foo", null), "foo");
});
