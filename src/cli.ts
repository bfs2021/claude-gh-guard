import fs from "node:fs";
import path from "node:path";
import { realDeps } from "./deps.ts";
import type { Deps } from "./deps.ts";
import { stateDir } from "./paths.ts";
import { runStatusline } from "./commands/statusline.ts";
import { runLearn } from "./commands/learn.ts";

function readStdin(): string {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function logError(d: Deps, e: unknown): void {
  try {
    const file = path.join(stateDir(d), "error.log");
    const line = `${new Date(d.now()).toISOString()} ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`;
    d.writeFile(file, (d.readFile(file) ?? "") + line);
  } catch {
    // nothing more to do
  }
}

export async function main(argv: string[]): Promise<number> {
  let d: Deps | null = null;
  try {
    d = realDeps();
    const [cmd, ...rest] = argv;
    switch (cmd) {
      case "statusline":
        process.stdout.write(runStatusline(readStdin(), rest, d) + "\n");
        return 0;
      case "learn":
        await runLearn(rest, d);
        return 0;
      case "hook":
      case "init":
      case "uninstall":
      case "doctor":
        process.stderr.write(`claude-gh-guard: ${cmd} is not available yet\n`);
        return 0;
      default:
        process.stderr.write("usage: claude-gh-guard <statusline|hook|init|uninstall|doctor|learn>\n");
        return 0;
    }
  } catch (e) {
    if (d) logError(d, e);
    return 0;
  }
}

if (/^(cli\.(js|ts)|claude-gh-guard)$/.test(path.basename(process.argv[1] ?? ""))) {
  main(process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(0));
}
