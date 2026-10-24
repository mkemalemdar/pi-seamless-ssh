// pi's file tools (read, write, edit, ls, find) doing their work on the remote, through pi's own "operations"
// interfaces, so the tools keep pi's look, diffs and output limits. Paths arrive already resolved against the remote
// project (the tools are run with the remote project as their working folder).

import type { EditOperations, FindOperations, LsOperations, ReadOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import { posix } from "node:path";
import { q } from "../core/shell.ts";
import { basenameEre, globToRegExp } from "../core/glob.ts";
import type { Remote } from "../ssh/remote.ts";

/** The image types pi's read tool shows as images, by their first bytes. */
export function sniffImage(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 6 && /^GIF8[79]a/.test(head.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

const accessError = (path: string, what: string) => Object.assign(new Error(`${what}: ${path}`), { code: "ENOENT" });

export function readOps(remote: () => Remote): ReadOperations {
  return {
    readFile: (p) => remote().readFile(p),
    access: async (p) => {
      if (!(await remote().test("-r", p))) throw accessError(p, "File not found or not readable");
    },
    detectImageMimeType: async (p) => sniffImage(await remote().head(p, 16)),
  };
}

export function writeOps(remote: () => Remote): WriteOperations {
  return {
    writeFile: async (p, content) => {
      await remote().writeFile(p, content);
    },
    mkdir: async (d) => {
      await remote().mkdirp(d);
    },
  };
}

export function editOps(remote: () => Remote): EditOperations {
  return {
    readFile: (p) => remote().readFile(p),
    writeFile: async (p, content) => {
      await remote().writeFile(p, content);
    },
    access: async (p) => {
      if (!(await remote().test("-r -w", p))) throw accessError(p, "File not found or not writable");
    },
  };
}

/** ls asks for each entry's type; one listing answers all of them, so it's one command per folder, not per entry. */
export function lsOps(remote: () => Remote): LsOperations {
  const dirs = new Map<string, boolean>();
  return {
    exists: (p) => remote().test("-e", p),
    stat: async (p) => {
      const known = dirs.get(p);
      const isDir = known ?? (await remote().test("-d", p));
      return { isDirectory: () => isDir };
    },
    readdir: async (p) => {
      const out = (await remote().sh(`cd -- ${q(p)} && ls -1Ap`)).toString("utf8");
      const names: string[] = [];
      for (const line of out.split("\n")) {
        if (!line) continue;
        const isDir = line.endsWith("/");
        const name = isDir ? line.slice(0, -1) : line;
        dirs.set(posix.join(p, name), isDir);
        names.push(name);
      }
      return names;
    },
  };
}

/** find: the remote's `rg --files` (which honors .gitignore) when it has ripgrep, plain `find` otherwise. */
export function findOps(remote: () => Remote): FindOperations {
  return {
    exists: (p) => remote().test("-e", p),
    glob: async (pattern, cwd, { ignore, limit }) => {
      const r = remote();
      // The remote sends only files whose name can match; the exact match is done here.
      const narrow = basenameEre(pattern);
      const filter = narrow ? ` | LC_ALL=C grep -E -- ${q(narrow)}` : "";
      const list = r.info.hasRg
        ? `cd -- ${q(cwd)} && { rg --files --hidden --glob '!.git' 2>/dev/null${filter}; true; }`
        : `cd -- ${q(cwd)} && { find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null | sed 's|^\\./||'${filter}; true; }`;
      const files = (await r.sh(list)).toString("utf8").split("\n").filter(Boolean);
      const want = globToRegExp(pattern);
      const skip = ignore.map(globToRegExp);
      const hits: string[] = [];
      for (const f of files) {
        if (!want.test(f) && !want.test(posix.basename(f))) continue;
        if (skip.some((s) => s.test(f))) continue;
        hits.push(f);
        if (hits.length >= limit) break;
      }
      return hits;
    },
  };
}
