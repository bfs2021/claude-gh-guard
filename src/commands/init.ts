import path from "node:path";
import type { Deps } from "../deps.ts";
import { claudeSettingsPath, stateDir } from "../paths.ts";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Double-quote a path; backslashes become slashes (Git Bash and cmd both accept them, and Git Bash would eat backslashes). */
export function shellQuote(p: string): string {
  return `"${p.replace(/\\/g, "/")}"`;
}

/** POSIX single-quote: nothing inside is expanded by the shell. */
export function posixQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Inverse of posixQuote; null when the text is not exactly one such quoted word. */
export function posixUnquote(s: string): string | null {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      out += s.slice(i + 1, end);
      i = end + 1;
    } else if (s.startsWith("\\'", i)) {
      out += "'";
      i += 2;
    } else {
      return null;
    }
  }
  return out;
}

const binDir = (d: Deps) => path.join(stateDir(d), "bin");
const binFile = (d: Deps) => path.join(binDir(d), "cli.mjs");

const OURS_MARK = ".claude-gh-guard/bin/cli.";
const OURS_STATUSLINE = /^node "[^"]*\.claude-gh-guard\/bin\/cli\.m?js" statusline(?= |$)/;
const isOursStatusLine = (v: unknown): boolean =>
  isObject(v) && typeof v.command === "string" && OURS_STATUSLINE.test(v.command);
const isOursCommand = (c: unknown): boolean => typeof c === "string" && c.includes(OURS_MARK);
const entryHooks = (e: unknown): unknown[] => (isObject(e) && Array.isArray(e.hooks) ? e.hooks : []);
const isOursHook = (h: unknown): boolean => isObject(h) && isOursCommand(h.command);
const isOursEntry = (e: unknown): boolean => entryHooks(e).some(isOursHook);

function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function loadSettings(file: string, d: Deps): { json: Json; text: string | null } | string {
  const text = d.readFile(file);
  if (text === null) return { json: {}, text: null };
  try {
    const v: unknown = JSON.parse(text);
    if (!isObject(v)) return `error: ${file} is not a JSON object; left unchanged`;
    return { json: v, text };
  } catch (e) {
    return `error: ${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}); left unchanged`;
  }
}

const serialize = (j: Json) => JSON.stringify(j, null, 2) + "\n";

/** Drop our hook objects from every PreToolUse entry; entries left empty are removed. Returns the index where our first whole entry stood. */
function stripOurs(pre: unknown[]): { kept: unknown[]; at: number } {
  const kept: unknown[] = [];
  let at = -1;
  for (const e of pre) {
    if (!isOursEntry(e)) {
      kept.push(e);
      continue;
    }
    const rest = entryHooks(e).filter((h) => !isOursHook(h));
    if (rest.length > 0) kept.push({ ...(e as Json), hooks: rest });
    else if (at < 0) at = kept.length;
  }
  return { kept, at };
}

export function runInit(d: Deps, selfPath: string, opts: { settings?: string } = {}): string {
  const file = opts.settings ?? claudeSettingsPath(d);
  const loaded = loadSettings(file, d);
  if (typeof loaded === "string") return loaded;
  const { json, text } = loaded;

  const code = d.readFile(selfPath);
  if (code === null) return `error: cannot read ${selfPath} to install it`;

  const lines: string[] = [];
  d.writeFile(binFile(d), code);
  const base = `node ${shellQuote(binFile(d))}`;

  // status line
  const cur = json.statusLine;
  if (isOursStatusLine(cur)) {
    const o = cur as Json;
    o.command = (o.command as string).replace(OURS_STATUSLINE, `${base} statusline`);
  } else if (isObject(cur) && typeof cur.command === "string") {
    json.statusLine = { ...cur, command: `${base} statusline --after ${posixQuote(cur.command)}` };
  } else {
    json.statusLine = { type: "command", command: `${base} statusline` };
  }

  // hook
  const entry = { matcher: "Bash", hooks: [{ type: "command", command: `${base} hook` }] };
  const hooks: Json = isObject(json.hooks) ? json.hooks : {};
  const { kept, at } = stripOurs(Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []);
  kept.splice(at >= 0 ? at : kept.length, 0, entry);
  hooks.PreToolUse = kept;
  json.hooks = hooks;

  const out = serialize(json);
  if (out === text) {
    lines.push(`unchanged: ${file}`);
  } else {
    if (text !== null) {
      let bak = `${file}.bak-${timestamp(d.now())}`;
      for (let n = 1; d.mtime(bak) !== null; n++) bak = `${file}.bak-${timestamp(d.now())}-${n}`;
      d.writeFile(bak, text);
      lines.push(`backup: ${bak}`);
    }
    d.writeFile(file, out);
    lines.push(`updated: ${file}`);
  }
  lines.push(`installed: ${binFile(d)}`, "statusLine and PreToolUse hook registered");
  return lines.join("\n");
}

export function runUninstall(d: Deps, opts: { settings?: string } = {}): string {
  const file = opts.settings ?? claudeSettingsPath(d);
  const loaded = loadSettings(file, d);
  if (typeof loaded === "string") return loaded;
  const { json, text } = loaded;

  const notes: string[] = [];
  if (text !== null) {
    if (isObject(json.hooks) && Array.isArray(json.hooks.PreToolUse)) {
      const hooks = json.hooks;
      const { kept } = stripOurs(hooks.PreToolUse as unknown[]);
      if (kept.length > 0) hooks.PreToolUse = kept;
      else delete hooks.PreToolUse;
      if (Object.keys(hooks).length === 0) delete json.hooks;
    }
    const sl = json.statusLine;
    if (isObject(sl) && isOursStatusLine(sl)) {
      const rest = (sl.command as string).replace(OURS_STATUSLINE, "");
      if (rest === "") {
        delete json.statusLine;
      } else {
        const orig = rest.startsWith(" --after ") ? posixUnquote(rest.slice(" --after ".length)) : null;
        if (orig !== null) json.statusLine = { ...sl, command: orig };
        else notes.push("could not recover the original statusLine command; left it in place");
      }
    }
    d.writeFile(file, serialize(json));
  }
  d.remove(binDir(d));
  const head = text === null ? `no settings file at ${file}; removed installed files` : `restored: ${file}\nremoved: ${binDir(d)}`;
  return [head, ...notes].join("\n");
}
