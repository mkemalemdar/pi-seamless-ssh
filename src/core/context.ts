// The instructions pi gives the model (AGENTS.md / CLAUDE.md), read on the remote by pi's own rules: in each folder
// the first of these names; the agent folder's file first, then the folders from / down to the working folder.
// While connected the agent folder is the project's own (<project>/.pi/agent), and the working folder the project.

import { posix } from "node:path";
import { q } from "./shell.ts";

export const CONTEXT_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

export interface ContextFile {
  path: string;
  content: string;
}

const FILE = "PSS_CTX ";
const BRANCH = "PSS_BRANCH ";
const DONE = "PSS_CTX_DONE";

/** The folders to look in, in pi's order: the agent folder, then / down to the project. */
export function contextDirs(agentDir: string, project: string): string[] {
  const chain: string[] = [];
  for (let dir = posix.resolve(project); ; dir = posix.dirname(dir)) {
    chain.unshift(dir);
    if (dir === "/") break;
  }
  return [agentDir, ...chain];
}

/**
 * Prints the project's git branch, as pi's footer shows it at home: the branch name (also before the first commit),
 * or the commit when no branch is checked out. Prints nothing outside a git repository.
 */
export function branchCommand(project: string): string {
  return `git -C ${q(project)} symbolic-ref --short -q HEAD 2>/dev/null || git -C ${q(project)} rev-parse --short HEAD 2>/dev/null`;
}

/** One command: each folder's context file (length-prefixed, so any content is safe) and the project's git branch. */
export function contextScript(dirs: readonly string[], project: string): string {
  const names = CONTEXT_NAMES.map(q).join(" ");
  return [
    `for d in ${dirs.map(q).join(" ")}; do for n in ${names}; do f="$d/$n"; if [ -f "$f" ]; then printf '${FILE}%s %s\\n' "$(wc -c < "$f" | tr -d ' ')" "$f"; cat "$f"; printf '\\n'; break; fi; done; done`,
    `b=$(${branchCommand(project)}) && printf '${BRANCH}%s\\n' "$b"`,
    `echo ${DONE}`,
  ].join("\n");
}

export function parseContext(out: Buffer): { files: ContextFile[]; branch?: string } {
  const files: ContextFile[] = [];
  let branch: string | undefined;
  let at = 0;
  const line = () => {
    const end = out.indexOf(0x0a, at);
    const text = out.subarray(at, end < 0 ? out.length : end).toString("utf8");
    at = end < 0 ? out.length : end + 1;
    return text;
  };
  let done = false;
  while (at < out.length) {
    const head = line();
    if (head.startsWith(FILE)) {
      const m = /^PSS_CTX (\d+) (.+)$/.exec(head);
      if (!m) break;
      const size = Number(m[1]);
      files.push({ path: m[2]!, content: out.subarray(at, at + size).toString("utf8").replace(/^﻿/, "") });
      at += size + 1;
    } else if (head.startsWith(BRANCH)) branch = head.slice(BRANCH.length).trim() || undefined;
    else if (head === DONE) {
      done = true;
      break;
    }
  }
  if (!done) throw new Error("the remote didn't send its instructions completely");
  return { files, ...(branch ? { branch } : {}) };
}
