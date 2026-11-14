import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../src/render.ts";

const v = (state: any, active: string | null, expected: string | null = null) => ({
  state, active, expected, problems: [], fixes: [],
});
const plain = { ascii: false, color: false };

test("render MATCH emoji and ascii", () => {
  assert.equal(render(v("MATCH", "alice", "alice"), null, plain), "🟢 gh:alice");
  assert.equal(render(v("MISMATCH", "a", "b"), null, { ascii: true, color: false }), "[X] gh:a ≠ b");
});

test("render other states", () => {
  assert.equal(render(v("MISMATCH", "a", "b"), null, plain), "🔴 gh:a ≠ b");
  assert.equal(render(v("AMBIGUOUS", "a"), null, plain), "🟡 gh:a (ambiguous)");
  assert.equal(render(v("UNKNOWN", "a"), null, plain), "⚪ gh:a (?)");
  assert.equal(render(v("UNTRACKED", "a"), null, plain), "⚪ gh:a (no-remote)");
  assert.equal(render(v("UNAUTH", null), null, plain), "⚠️ gh:not-logged-in");
});

test("render appends differing push identity", () => {
  assert.equal(
    render(v("MATCH", "a", "a"), { via: "ssh", login: "alice" }, plain),
    "🟢 gh:a · push(ssh):alice",
  );
  assert.equal(render(v("MATCH", "a", "a"), { via: "gh", login: "A" }, plain), "🟢 gh:a");
  assert.equal(render(v("MATCH", "a", "a"), { via: "ssh", login: null }, plain), "🟢 gh:a");
  assert.equal(render(v("MATCH", "a", "a"), { via: "unknown" }, plain), "🟢 gh:a");
});

test("render color wraps in ANSI", () => {
  assert.equal(render(v("MATCH", "a", "a"), null, { ascii: false, color: true }), "\x1b[32m🟢 gh:a\x1b[0m");
  assert.equal(render(v("MISMATCH", "a", "b"), null, { ascii: false, color: true }), "\x1b[31m🔴 gh:a ≠ b\x1b[0m");
});

test("render ascii for every state", () => {
  const a = { ascii: true, color: false };
  assert.equal(render(v("MATCH", "a", "a"), null, a), "[OK] gh:a");
  assert.equal(render(v("MISMATCH", "a", "b"), null, a), "[X] gh:a ≠ b");
  assert.equal(render(v("AMBIGUOUS", "a"), null, a), "[~] gh:a (ambiguous)");
  assert.equal(render(v("UNKNOWN", "a"), null, a), "[?] gh:a (?)");
  assert.equal(render(v("UNTRACKED", "a"), null, a), "[?] gh:a (no-remote)");
  assert.equal(render(v("UNAUTH", null), null, a), "[!] gh:not-logged-in");
});
