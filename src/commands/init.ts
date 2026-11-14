import path from "node:path";
import type { Deps } from "../deps.ts";
import { claudeSettingsPath, stateDir } from "../paths.ts";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Double-quote a path; backslashes become slashes (Git Bash and cmd both accept them, and Git Bash would eat backslashes). */
export function shellQuote(p: string): string {
  return `"${p.replace(/\\/g, "/")}"`;
}

const binDir = (d: Deps) => path.join(stateDir(d), "bin");
const binFile = (d: Deps) => path.join(binDir(d), "cli.js");
const originalFile = (d: Deps) => path.join(stateDir(d), "original-statusline.json");

const OURS_STATUSLINE = /^node "[^"]*\.claude-gh-guard\/bin\/cli\.js" statusline(?= |$)/;
const isOursStatusLine = (v: unknown): boolean =>
  isObject(v) && typeof v.command === "string" && OURS_STATUSLINE.test(v.command);
const isOursCommand = (c: unknown): boolean => typeof c === "string" && c.includes("claude-gh-guard");
const entryHooks = (e: unknown): unknown[] => (isObject(e) && Array.isArray(e.hooks) ? e.hooks : []);
const isOursEntry = (e: unknown): boolean => entryHooks(e).some((h) => isObject(h) && isOursCommand(h.command));

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

export function runInit(d: Deps, selfPath: string, opts: { settings?: string } = {}): string {
  const file = opts.settings ?? claudeSettingsPath(d);
  const loaded = loadSettings(file, d);
  if (typeof loaded === "string") return loaded;
  const { json, text } = loaded;

  const code = d.readFile(selfPath);
  if (code === null) return `error: cannot read ${selfPath} to install it`;

  const lines: string[] = [];
  if (text !== null) {
    const bak = `${file}.bak-${timestamp(d.now())}`;
    d.writeFile(bak, text);
    lines.push(`backup: ${bak}`);
  }
  d.writeFile(binFile(d), code);
  const base = `node ${shellQuote(binFile(d))}`;

  // status line
  const cur = json.statusLine;
  if (isOursStatusLine(cur)) {
    const o = cur as Json;
    o.command = (o.command as string).replace(OURS_STATUSLINE, `${base} statusline`);
  } else if (isObject(cur) && typeof cur.command === "string") {
    d.writeFile(originalFile(d), JSON.stringify(cur, null, 2));
    json.statusLine = { ...cur, command: `${base} statusline --after ${JSON.stringify(cur.command)}` };
  } else {
    json.statusLine = { type: "command", command: `${base} statusline` };
  }

  // hook
  const entry = { matcher: "Bash", hooks: [{ type: "command", command: `${base} hook` }] };
  const hooks: Json = isObject(json.hooks) ? json.hooks : {};
  const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const at = pre.findIndex(isOursEntry);
  const next = pre.filter((e) => !isOursEntry(e));
  next.splice(at >= 0 ? at : next.length, 0, entry);
  hooks.PreToolUse = next;
  json.hooks = hooks;

  d.writeFile(file, serialize(json));
  lines.push(`updated: ${file}`, `installed: ${binFile(d)}`, "statusLine and PreToolUse hook registered");
  return lines.join("\n");
}

export function runUninstall(d: Deps, opts: { settings?: string } = {}): string {
  const file = opts.settings ?? claudeSettingsPath(d);
  const loaded = loadSettings(file, d);
  if (typeof loaded === "string") return loaded;
  const { json, text } = loaded;

  if (text !== null) {
    if (isObject(json.hooks) && Array.isArray(json.hooks.PreToolUse)) {
      const hooks = json.hooks;
      const kept: unknown[] = [];
      for (const e of hooks.PreToolUse as unknown[]) {
        if (!isOursEntry(e)) {
          kept.push(e);
          continue;
        }
        const rest = entryHooks(e).filter((h) => !(isObject(h) && isOursCommand(h.command)));
        if (rest.length > 0) kept.push({ ...(e as Json), hooks: rest });
      }
      if (kept.length > 0) hooks.PreToolUse = kept;
      else delete hooks.PreToolUse;
      if (Object.keys(hooks).length === 0) delete json.hooks;
    }
    if (isOursStatusLine(json.statusLine)) {
      let restored: unknown = null;
      try {
        restored = JSON.parse(d.readFile(originalFile(d)) ?? "");
      } catch {
        restored = null;
      }
      if (isObject(restored)) json.statusLine = restored;
      else delete json.statusLine;
    }
    d.writeFile(file, serialize(json));
  }
  d.remove(binDir(d));
  d.remove(originalFile(d));
  return text === null ? `no settings file at ${file}; removed installed files` : `restored: ${file}\nremoved: ${binDir(d)}`;
}
