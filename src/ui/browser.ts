// The folder browser shown after connecting, to pick the project folder. Folders only.
//   ↑ ↓          move                       →  expand: subfolders appear indented below
//   ←            collapse                   Enter  go into the folder (it becomes the view)
//   Esc, Delete  one folder up; at / back   Space  pick the highlighted folder ("This folder": the one you're in)
//   [.]          the dot key: show or hide hidden folders (hidden by default)
//
// Every listing brings one level more than shown, so opening or expanding a folder is instant; while something
// still loads, the rows already shown stay on screen.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { buildRows, type Children, folderNameProblem, parentOf, shortPath } from "../core/browser.ts";
import type { DirsTree } from "../core/listing.ts";
import { frameLines } from "./components.ts";

export interface BrowserIO {
  tree(dir: string): Promise<DirsTree>;
  mkdir(dir: string): Promise<void>;
  home: string;
  /** For the title. */
  machine: string;
}

type Mode = { kind: "browse" } | { kind: "new"; name: string; error?: string };

const PAD = "  ";
const NEW_ID = "\0new";
const HERE_ID = "\0here";

export class FolderBrowser implements Component {
  private view: string;
  private readonly expanded = new Set<string>();
  private readonly children = new Map<string, Children>();
  /** Folders whose next level was fetched (or is being fetched). */
  private readonly fetched = new Set<string>();
  private selectedPath: string | undefined;
  private mode: Mode = { kind: "browse" };
  private message: string | undefined;
  private showHidden = false;
  /** A folder being opened that isn't known yet: the current rows stay until it arrives. */
  private opening: string | undefined;

  private readonly theme: Theme;
  private readonly io: BrowserIO;
  private readonly render_: () => void;
  private readonly onPick: (dir: string) => void;
  private readonly onBack: () => void;
  private readonly maxVisible: () => number;

  constructor(theme: Theme, io: BrowserIO, start: string, render: () => void, onPick: (dir: string) => void, onBack: () => void, maxVisible: () => number) {
    this.theme = theme;
    this.io = io;
    this.view = start;
    this.render_ = render;
    this.onPick = onPick;
    this.onBack = onBack;
    this.maxVisible = maxVisible;
    this.go(start);
  }

  invalidate(): void {}

  /** Fetches `dir` and the level below it (once per folder). */
  private async fetch(dir: string): Promise<DirsTree | undefined> {
    if (this.fetched.has(dir) && Array.isArray(this.children.get(dir))) return undefined;
    this.fetched.add(dir);
    try {
      const tree = await this.io.tree(dir);
      for (const [path, names] of tree.children) this.children.set(path, names);
      return tree;
    } catch (e) {
      this.fetched.delete(dir);
      if (!Array.isArray(this.children.get(dir))) this.children.set(dir, { error: (e as Error).message });
      throw e;
    } finally {
      this.render_();
    }
  }

  /** Makes `dir` the view: at once when its subfolders are known, otherwise when they arrive. */
  private go(dir: string, select?: string): void {
    const show = (path: string) => {
      this.view = path;
      this.opening = undefined;
      this.selectedPath = select;
      // Fetch ahead: the subfolders' own subfolders, for the next step.
      void this.fetch(path).catch(() => {});
    };
    if (Array.isArray(this.children.get(dir))) return show(dir);
    this.opening = dir;
    this.fetch(dir)
      .then((tree) => {
        if (this.opening !== dir) return;
        show(tree?.path ?? dir);
      })
      .catch((e: Error) => {
        if (this.opening !== dir) return;
        this.opening = undefined;
        this.message = `Can't open ${shortPath(dir, this.io.home)}: ${e.message}`;
        // Nothing shown yet (the first folder): fall back to the folder above it.
        if (!Array.isArray(this.children.get(this.view)) && dir !== "/") this.go(parentOf(dir));
      })
      .finally(() => this.render_());
  }

  private rows() {
    return buildRows(this.view, this.expanded, this.children, this.showHidden);
  }

  /** Row ids: "new folder", "this folder", then the folders. */
  private ids(): string[] {
    return [NEW_ID, HERE_ID, ...this.rows().map((r) => r.path)];
  }

  private selectedIndex(): number {
    const ids = this.ids();
    const i = this.selectedPath ? ids.indexOf(this.selectedPath) : -1;
    return i >= 0 ? i : ids.length > 2 ? 2 : 1;
  }

  handleInput(data: string): void {
    this.message = undefined;
    if (this.mode.kind === "new") return this.handleNew(data);
    const ids = this.ids();
    const index = this.selectedIndex();
    const current = ids[index];
    const row = this.rows().find((r) => r.path === current);
    if (matchesKey(data, "escape") || matchesKey(data, "delete") || matchesKey(data, "backspace")) {
      // Up one folder; from / back out of the browser.
      if (this.view === "/") return this.onBack();
      this.go(parentOf(this.view), this.view);
    } else if (matchesKey(data, "up")) this.selectedPath = ids[(index - 1 + ids.length) % ids.length];
    else if (matchesKey(data, "down")) this.selectedPath = ids[(index + 1) % ids.length];
    else if (matchesKey(data, "right") && row) {
      this.expanded.add(row.path);
      void this.fetch(row.path).catch(() => {});
    } else if (matchesKey(data, "left") && row) {
      if (this.expanded.has(row.path)) this.expanded.delete(row.path);
      else if (row.depth > 0) {
        // Already closed: jump to the folder it sits in, and close that.
        const parent = parentOf(row.path);
        this.expanded.delete(parent);
        this.selectedPath = parent;
      }
    } else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      if (current === NEW_ID) this.mode = { kind: "new", name: "" };
      else if (current === HERE_ID) return this.onPick(this.view);
      else if (row) this.go(row.path);
    } else if (matchesKey(data, "space")) {
      if (current === NEW_ID) return;
      return this.onPick(current === HERE_ID || !row ? this.view : row.path);
    } else if (data === ".") {
      this.showHidden = !this.showHidden;
      if (this.selectedPath && !this.ids().includes(this.selectedPath)) this.selectedPath = undefined;
    }
    this.render_();
  }

  private handleNew(data: string): void {
    if (this.mode.kind !== "new") return;
    if (matchesKey(data, "escape")) this.mode = { kind: "browse" };
    else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const name = this.mode.name.trim();
      const problem = folderNameProblem(name);
      if (problem) this.mode = { ...this.mode, error: problem };
      else {
        const dir = this.view === "/" ? `/${name}` : `${this.view}/${name}`;
        const view = this.view;
        this.mode = { kind: "browse" };
        this.io
          .mkdir(dir)
          .then(async () => {
            this.fetched.delete(view);
            await this.fetch(view);
            this.selectedPath = dir;
          })
          .catch((e: Error) => {
            this.message = `Couldn't create ${name}: ${e.message}`;
          })
          .finally(() => this.render_());
      }
    } else if (matchesKey(data, "backspace")) this.mode = { ...this.mode, name: [...this.mode.name].slice(0, -1).join(""), error: undefined };
    else if (!data.startsWith("\x1b")) this.mode = { kind: "new", name: this.mode.name + [...data].filter((ch) => ch >= " " && ch !== "\x7f").join("") };
    this.render_();
  }

  render(width: number): string[] {
    const t = this.theme;
    const inner = Math.max(10, width - PAD.length);
    const { top, bottom } = frameLines(t, `ssh › ${this.io.machine} › project folder`, width);
    const lines: string[] = [top, ""];
    const text = (line: string) => lines.push(truncateToWidth(PAD + line, width));
    const where = `In ${t.bold(shortPath(this.view, this.io.home))}`;
    text(t.fg("muted", this.opening ? `${where}  ${t.fg("dim", `opening ${shortPath(this.opening, this.io.home)}…`)}` : where));
    text("");

    const index = this.selectedIndex();
    const rows = this.rows();
    const kids = this.children.get(this.view);
    const pointer = (i: number) => (i === index ? t.fg("accent", "→ ") : "  ");
    const all: string[] = [];
    all.push(`${pointer(0)}${t.fg(index === 0 ? "accent" : "dim", "+ New folder here")}`);
    all.push(`${pointer(1)}${index === 1 ? t.fg("accent", "● This folder") : "● This folder"}  ${t.fg("dim", shortPath(this.view, this.io.home))}`);
    if (kids === "loading" || kids === undefined) all.push(`  ${t.fg("dim", "loading…")}`);
    else if (!Array.isArray(kids)) all.push(`  ${t.fg("error", kids.error)}`);
    else if (rows.length === 0) {
      const hidden = kids.some((n) => n.startsWith("."));
      all.push(`  ${t.fg("dim", hidden && !this.showHidden ? "(only hidden folders here: press [.] to show them)" : "(no folders here)")}`);
    }
    rows.forEach((row, i) => {
      const selected = i + 2 === index;
      const label = `${"  ".repeat(row.depth)}${row.expanded ? "▾" : "▸"} ${row.name}/`;
      all.push(`${pointer(i + 2)}${selected ? t.fg("accent", label) : label}`);
      if (row.note) all.push(`  ${"  ".repeat(row.depth + 1)}${t.fg("dim", row.note)}`);
    });
    const max = this.maxVisible();
    const start = Math.max(0, Math.min(index - Math.floor(max / 2), all.length - max));
    for (const line of all.slice(start, start + max)) text(line);
    if (all.length > max) text(t.fg("dim", `(${index + 1}/${this.ids().length})`));

    text("");
    if (this.mode.kind === "new") {
      text(`New folder in ${shortPath(this.view, this.io.home)}: ${this.mode.name}${t.fg("accent", "▏")}`);
      text(this.mode.error ? t.fg("error", this.mode.error) : "");
      text(t.fg("dim", "Enter create · Esc cancel"));
    } else {
      for (const line of wrapTextWithAnsi(this.message ? t.fg("warning", this.message) : "", inner)) text(line);
      const hint = `↑↓ move · → open · ← close · Enter go in · Space pick · Esc/Del up${this.view === "/" ? " (back)" : ""} · [.] ${this.showHidden ? "hide" : "show"} hidden folders`;
      for (const line of wrapTextWithAnsi(hint, inner)) text(t.fg("dim", line));
    }
    lines.push(bottom, "");
    return lines;
  }
}
