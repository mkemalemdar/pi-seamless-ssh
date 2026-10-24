// The folder browser's rows: the current folder's subfolders, with expanded ones showing theirs indented below.

import { posix } from "node:path";

export type Children = string[] | "loading" | { error: string };

export interface BrowserRow {
  /** Absolute remote path. */
  path: string;
  name: string;
  depth: number;
  expanded: boolean;
  /** "loading…" or an error, under an expanded folder. */
  note?: string;
}

/** `showHidden` false leaves out folders whose name starts with a dot (.cache, .npm, …). */
export function buildRows(view: string, expanded: ReadonlySet<string>, children: ReadonlyMap<string, Children>, showHidden = true): BrowserRow[] {
  const rows: BrowserRow[] = [];
  const add = (dir: string, depth: number) => {
    const kids = children.get(dir);
    if (!Array.isArray(kids)) return;
    for (const name of kids) {
      if (!showHidden && name.startsWith(".")) continue;
      const path = posix.join(dir, name);
      const open = expanded.has(path);
      const sub = children.get(path);
      rows.push({
        path,
        name,
        depth,
        expanded: open,
        ...(open && sub === "loading" ? { note: "loading…" } : open && sub && typeof sub === "object" && !Array.isArray(sub) ? { note: sub.error } : {}),
      });
      if (open) add(path, depth + 1);
    }
  };
  add(view, 0);
  return rows;
}

/** One folder up; `/` stays `/`. */
export const parentOf = (path: string): string => (path === "/" ? "/" : posix.dirname(path));

/** A short form for titles: the remote home becomes `~`. */
export function shortPath(path: string, home: string): string {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

/** A new folder's name: one plain name, no slashes. */
export function folderNameProblem(name: string): string | undefined {
  const n = name.trim();
  if (!n) return "Type a name";
  if (n.includes("/")) return "One folder name, without /";
  if (n === "." || n === "..") return "Not a usable name";
  return undefined;
}
