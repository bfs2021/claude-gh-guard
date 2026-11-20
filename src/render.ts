import type { Verdict } from "./evaluate.ts";
import type { PushIdentity } from "./pushIdentity.ts";

const GLYPH = {
  MATCH: ["🟢", "[OK]"],
  MISMATCH: ["🔴", "[X]"],
  AMBIGUOUS: ["🟡", "[~]"],
  UNKNOWN: ["⚪", "[?]"],
  UNTRACKED: ["⚪", "[?]"],
  UNAUTH: ["⚠️", "[!]"],
} as const;

const COLOR = { MATCH: 32, MISMATCH: 31, AMBIGUOUS: 33, UNKNOWN: 37, UNTRACKED: 37, UNAUTH: 33 } as const;

export function render(
  v: Verdict,
  push: PushIdentity | null,
  opts: { ascii: boolean; color: boolean; moved?: string | null },
): string {
  const g = GLYPH[v.state][opts.ascii ? 1 : 0];
  const active = v.active ?? "?";
  let text: string;
  switch (v.state) {
    case "MATCH": text = `${g} gh:${active}`; break;
    case "MISMATCH": text = `${g} gh:${active} ≠ ${v.expected ?? "?"}`; break;
    case "AMBIGUOUS": text = `${g} gh:${active} (ambiguous)`; break;
    case "UNKNOWN": text = `${g} gh:${active} (?)`; break;
    case "UNTRACKED": text = `${g} gh:${active} (no-remote)`; break;
    case "UNAUTH": text = `${g} gh:not-logged-in`; break;
  }
  if (
    push &&
    (push.via === "ssh" || push.via === "gh") &&
    push.login &&
    push.login.toLowerCase() !== (v.active ?? "").toLowerCase()
  ) {
    text += ` · push(${push.via}):${push.login}`;
  }
  if (opts.moved) text += ` · moved${opts.ascii ? "->" : "→"}${opts.moved}`;
  return opts.color ? `\x1b[${COLOR[v.state]}m${text}\x1b[0m` : text;
}
