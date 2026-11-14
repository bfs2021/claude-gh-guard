import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig, matchProfile } from "../src/config.ts";
import { fakeDeps } from "./helpers.ts";

const cfgPath = path.join("/home/test", ".gh-guard.json");
const load = (text: string | null) =>
  loadConfig(fakeDeps({ files: text === null ? {} : { [cfgPath]: text } }));

test("owner/repo beats owner across profiles", () => {
  const p = [
    { name: "a", ghUser: "A", gitEmails: [], owners: ["corp"] },
    { name: "b", ghUser: "B", gitEmails: [], owners: ["corp/special"] },
  ];
  assert.equal(matchProfile(p, "corp", "special")?.name, "b");
  assert.equal(matchProfile(p, "CORP", "other")?.name, "a");
  assert.equal(matchProfile(p, "CORP", "SPECIAL")?.name, "b");
  assert.equal(matchProfile(p, "nope", "x"), null);
});

test("first profile in file order wins for owner", () => {
  const p = [
    { name: "a", ghUser: "A", gitEmails: [], owners: ["o"] },
    { name: "b", ghUser: "B", gitEmails: [], owners: ["o"] },
  ];
  assert.equal(matchProfile(p, "o", "r")?.name, "a");
});

test("gitEmail string normalized", () => {
  const r = load('{"profiles":{"w":{"ghUser":"x","gitEmail":"e@x","owners":["o"]}}}');
  assert.equal(r.error, null);
  assert.deepEqual(r.profiles, [{ name: "w", ghUser: "x", gitEmails: ["e@x"], owners: ["o"] }]);
});

test("gitEmail array, non-strings dropped, missing ghUser skipped, order kept", () => {
  const r = load(JSON.stringify({ profiles: {
    bad: { owners: ["o"] },
    bad2: { ghUser: 5 },
    p1: { ghUser: "u1", gitEmail: ["a@x", 3, "b@x"], owners: ["o", 1] },
    p2: { ghUser: "u2" },
  } }));
  assert.deepEqual(r.profiles.map((p) => p.name), ["p1", "p2"]);
  assert.deepEqual(r.profiles[0].gitEmails, ["a@x", "b@x"]);
  assert.deepEqual(r.profiles[0].owners, ["o"]);
  assert.deepEqual(r.profiles[1], { name: "p2", ghUser: "u2", gitEmails: [], owners: [] });
});

test("missing file and missing profiles key", () => {
  assert.deepEqual(load(null), { profiles: [], error: null });
  assert.deepEqual(load("{}"), { profiles: [], error: null });
});

test("invalid JSON reports error, no throw", () => {
  const r = load("{nope");
  assert.notEqual(r.error, null);
  assert.deepEqual(r.profiles, []);
});

test("valid JSON that is not an object is an error", () => {
  for (const t of ["[]", "5", "null", '"s"']) {
    const r = load(t);
    assert.notEqual(r.error, null, t);
    assert.deepEqual(r.profiles, []);
  }
});
