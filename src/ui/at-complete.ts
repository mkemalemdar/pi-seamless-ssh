// `@` file suggestions in pi's input box, from the remote project while connected. pi's editor only inserts the
// `@path` text (the model then reads the file with its routed `read` tool), so only the suggestions need to come from
// the remote. At home, and for anything that isn't an `@` token, pi's own provider answers unchanged.
//
// The project's file list is fetched once and kept for a short while (refreshed in the background), so suggestions
// stay instant while typing.

import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { q } from "../core/shell.ts";
import type { Session } from "../sync/session.ts";

const MAX_FILES = 50_000;
const MAX_ITEMS = 20;
const FRESH_MS = 15_000;

/** The `@` token just before the cursor, as pi's own provider finds it: `@src/ma` or `@"docs/release no`. */
export function atToken(beforeCursor: string): { token: string; query: string; quoted: boolean } | undefined {
  const quoted = /(?:^|\s)(@"[^"]*)$/.exec(beforeCursor);
  if (quoted) return { token: quoted[1]!, query: quoted[1]!.slice(2), quoted: true };
  const plain = /(?:^|[\s(])(@[^\s"]*)$/.exec(beforeCursor);
  if (plain) return { token: plain[1]!, query: plain[1]!.slice(1), quoted: false };
  return undefined;
}

/** pi's format: `@path`, or `@"path"` when quoted or the path has a space. */
const completionValue = (path: string, quoted: boolean) => (quoted || /\s/.test(path) ? `@"${path}"` : `@${path}`);

/**
 * The best matches for `query` among the project's files and their folders: a query with a `/` matches the start of
 * the path; otherwise names containing it, names starting with it first.
 */
export function matchEntries(files: readonly string[], query: string, limit = MAX_ITEMS): { path: string; dir: boolean }[] {
  const dirs = new Set<string>();
  for (const f of files) for (let i = f.indexOf("/"); i > 0; i = f.indexOf("/", i + 1)) dirs.add(`${f.slice(0, i)}/`);
  const entries = [...[...dirs].map((path) => ({ path, dir: true })), ...files.map((path) => ({ path, dir: false }))];
  const ql = query.toLowerCase();
  const name = (p: string) => (p.endsWith("/") ? p.slice(0, -1) : p).split("/").at(-1)!.toLowerCase();
  if (query.includes("/")) {
    const slash = query.lastIndexOf("/");
    const dir = ql.slice(0, slash + 1);
    const rest = ql.slice(slash + 1);
    return entries
      // Entries directly inside that folder (not the folder itself, not deeper ones).
      .filter((e) => e.path.length > dir.length && e.path.toLowerCase().startsWith(dir) && !e.path.slice(dir.length).replace(/\/$/, "").includes("/") && name(e.path).startsWith(rest))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path))
      .slice(0, limit);
  }
  const score = (e: { path: string }) => (name(e.path).startsWith(ql) ? 0 : 1) + e.path.split("/").length * 0.01;
  return entries
    .filter((e) => name(e.path).includes(ql))
    .sort((a, b) => score(a) - score(b) || a.path.length - b.path.length)
    .slice(0, limit);
}

export function remoteAtProvider(current: AutocompleteProvider, session: () => Session | undefined): AutocompleteProvider {
  let cache: { key: string; files: string[]; at: number } | undefined;
  let refreshing: Promise<void> | undefined;

  const refresh = (s: Session, key: string): Promise<void> => {
    refreshing ??= (async () => {
      try {
        const list = s.remote.info.hasRg
          ? `cd ${q(s.ws.remoteProject)} && { rg --files --hidden --glob '!.git' 2>/dev/null; true; } | head -n ${MAX_FILES}`
          : `cd ${q(s.ws.remoteProject)} && { find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null | sed 's|^\\./||'; true; } | head -n ${MAX_FILES}`;
        const files = (await s.remote.sh(list)).toString("utf8").split("\n").filter(Boolean);
        cache = { key, files, at: Date.now() };
      } catch {
        // Keep the previous list; the next keystroke tries again.
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  };

  return {
    ...(current.triggerCharacters ? { triggerCharacters: current.triggerCharacters } : {}),
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const s = session();
      const at = s?.usable ? atToken((lines[cursorLine] ?? "").slice(0, cursorCol)) : undefined;
      if (!s || !at) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      const key = `${s.machine}:${s.ws.remoteProject}`;
      if (!cache || cache.key !== key) await refresh(s, key);
      else if (Date.now() - cache.at > FRESH_MS) void refresh(s, key);
      if (!cache || cache.key !== key || options.signal.aborted) return null;
      const items: AutocompleteItem[] = matchEntries(cache.files, at.query).map((e) => ({
        value: completionValue(e.path, at.quoted),
        label: `${e.path.replace(/\/$/, "").split("/").at(-1)}${e.dir ? "/" : ""}`,
        description: e.path,
      }));
      return items.length ? { items, prefix: at.token } : null;
    },
    // pi's own provider inserts an `@` completion (quotes, the space after a file, the cursor) the same way.
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
    ...(current.shouldTriggerFileCompletion ? { shouldTriggerFileCompletion: (l: string[], cl: number, cc: number) => current.shouldTriggerFileCompletion!(l, cl, cc) } : {}),
  };
}
