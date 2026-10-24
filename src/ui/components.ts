// Building blocks for the /ssh menus (the same look as pi-modelctl's): a list menu, a text input step, and a stack that
// lets menus open deeper menus and go back with Esc.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface MenuItem {
  id: string;
  label: string;
  /** Shown in a column next to the label. */
  detail?: string;
  /** Shown under the list while this item is selected. */
  description?: string;
  /** Text before the label, e.g. "●", "[x]". */
  marker?: string;
  /** Indentation level. */
  indent?: number;
  /** Rendered as a button line, separated from the list. */
  button?: boolean;
  /** Can't be selected (section titles, spacing). */
  disabled?: boolean;
  /** Shown greyed out but still selectable, so its explanation can say why. */
  dimmed?: boolean;
  /** A section title: shown bold in the accent colour. */
  heading?: boolean;
}

export interface ListMenuOptions {
  /** Shown in the top border, e.g. "ssh › Settings". */
  title: string;
  description?: string;
  items: MenuItem[];
  /** Enter on an item. */
  onSelect?(item: MenuItem): void;
  /** Space on an item (defaults to onSelect). */
  onToggle?(item: MenuItem): void;
  onCancel(): void;
  hint?: string;
  initialId?: string;
  /** Rows shown before the list scrolls; a function follows the terminal's height. */
  maxVisible?: number | (() => number);
}

export type Tone = "info" | "ok" | "error";

/** Indent inside the frame, so the menu lines up with pi's own blocks. */
const PAD = "  ";

/** Top and bottom lines of a menu, like pi's own framed blocks. */
export function frameLines(theme: Theme, title: string, width: number): { top: string; bottom: string } {
  const label = ` ${title} `;
  const rest = Math.max(0, width - 2 - visibleWidth(label));
  return {
    top: truncateToWidth(theme.fg("borderMuted", "──") + theme.fg("accent", theme.bold(label)) + theme.fg("borderMuted", "─".repeat(rest)), width),
    bottom: theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
  };
}

export class ListMenu implements Component {
  private items: MenuItem[];
  private index = 0;
  /** A result shown next to its row (or under the list), cleared on the next key press. */
  private status: { text: string; tone: Tone; itemId?: string } | undefined;

  private readonly theme: Theme;
  private readonly options: ListMenuOptions;

  constructor(theme: Theme, options: ListMenuOptions) {
    this.theme = theme;
    this.options = options;
    this.items = options.items;
    const initial = options.initialId ? this.items.findIndex((item) => item.id === options.initialId) : -1;
    this.index = initial >= 0 ? initial : this.firstEnabled();
  }

  setItems(items: MenuItem[], keepId?: string): void {
    const currentId = keepId ?? this.items[this.index]?.id;
    this.items = items;
    const found = items.findIndex((item) => item.id === currentId);
    this.index = found >= 0 ? found : this.firstEnabled();
  }

  /** Replaces the text under the title (e.g. a note that depends on values just changed). */
  setDescription(description: string | undefined): void {
    this.options.description = description;
  }

  /** Shows a result. With `itemId` it appears next to that row. */
  setStatus(text: string | undefined, tone: Tone = "info", itemId?: string): void {
    this.status = text ? { text, tone, ...(itemId ? { itemId } : {}) } : undefined;
  }

  selected(): MenuItem | undefined {
    return this.items[this.index];
  }

  invalidate(): void {}

  handleInput(data: string): void {
    // Results only describe what just happened: any key clears them.
    this.status = undefined;
    if (matchesKey(data, "up")) this.move(-1);
    else if (matchesKey(data, "down")) this.move(1);
    else if (matchesKey(data, "escape")) this.options.onCancel();
    else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const item = this.selected();
      if (item && !item.disabled) this.options.onSelect?.(item);
    } else if (matchesKey(data, "space")) {
      const item = this.selected();
      if (item && !item.disabled) (this.options.onToggle ?? this.options.onSelect)?.(item);
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const inner = Math.max(10, width - PAD.length);
    const { top, bottom } = frameLines(t, this.options.title, width);
    const lines: string[] = [top];
    const text = (line: string) => lines.push(truncateToWidth(PAD + line, width));
    const wrapped = (value: string, color: "muted" | "dim") => wrapTextWithAnsi(t.fg(color, value), inner);

    if (this.options.description) {
      // A gap under the title line, so the title and the explanation don't blur together.
      text("");
      for (const line of wrapped(this.options.description, "muted")) text(line);
    }
    text("");

    const statusText = (status: NonNullable<ListMenu["status"]>) =>
      t.fg(status.tone === "error" ? "error" : status.tone === "ok" ? "success" : "warning", status.text);
    const labelWidth = Math.min(
      // Buttons sit on their own line with no value, so they don't widen the label column.
      Math.max(...this.items.filter((item) => !item.button).map((item) => (item.indent ?? 0) * 2 + (item.marker ? visibleWidth(item.marker) + 1 : 0) + visibleWidth(item.label)), 10) + 2,
      Math.floor(inner * 0.6),
    );
    const mv = this.options.maxVisible;
    const maxVisible = typeof mv === "function" ? mv() : (mv ?? 16);
    const start = Math.max(0, Math.min(this.index - Math.floor(maxVisible / 2), this.items.length - maxVisible));
    let statusShown = false;
    this.items.slice(start, start + maxVisible).forEach((item, offset) => {
      const selected = start + offset === this.index;
      if (item.button) text("");
      const pointer = selected ? t.fg("accent", "→ ") : "  ";
      const body = `${"  ".repeat(item.indent ?? 0)}${item.marker ? `${item.marker} ` : ""}${item.label}`;
      const label = item.heading ? t.fg("accent", t.bold(body)) : item.disabled || item.dimmed ? t.fg("dim", body) : selected ? t.fg("accent", body) : body;
      const padded = label + " ".repeat(Math.max(1, labelWidth - visibleWidth(body)));
      const detail = item.detail ? t.fg("dim", item.detail) : "";
      // A result takes the place of the row's grey note; if it doesn't fit, it goes under the list.
      const result = this.status?.itemId === item.id ? statusText(this.status) : "";
      const fits = !!result && visibleWidth(`${pointer}${padded}${result}`) <= inner;
      if (fits) statusShown = true;
      const after = fits ? result : detail;
      text(after ? `${pointer}${padded}${after}` : `${pointer}${label}`);
    });
    if (this.items.length > maxVisible) text(t.fg("dim", `(${this.index + 1}/${this.items.length})`));
    if (this.status && !statusShown) for (const line of wrapTextWithAnsi(statusText(this.status), inner)) text(line);

    text("");
    // Same height for every row's explanation (blank when there is none), so the menu doesn't jump while moving.
    const explanation = (item: MenuItem | undefined) => (item && !item.disabled && item.description ? wrapped(item.description, "muted") : []);
    const reserved = Math.max(0, ...this.items.map((item) => explanation(item).length));
    const current = reserved > 0 ? explanation(this.selected()) : [];
    for (const line of [...current, ...Array<string>(reserved - current.length).fill("")]) text(line);
    // A gap between the row's explanation and the key hint.
    if (reserved > 0) text("");
    text(t.fg("dim", this.options.hint ?? "↑↓ move · Enter choose · Esc back"));
    lines.push(bottom);
    // A blank line keeps the menu apart from pi's own lines below it.
    lines.push("");
    return lines;
  }

  private firstEnabled(): number {
    const found = this.items.findIndex((item) => !item.disabled);
    return found >= 0 ? found : 0;
  }

  private move(step: number): void {
    if (this.items.length === 0) return;
    let next = this.index;
    for (let tries = 0; tries < this.items.length; tries++) {
      next = (next + step + this.items.length) % this.items.length;
      if (!this.items[next]!.disabled) break;
    }
    this.index = next;
  }
}

/** A single text field with a title and explanation. `onSubmit` returns an error to show, or undefined. */
export class InputStep implements Component {
  private readonly input = new Input();
  private error: string | undefined;

  private readonly theme: Theme;
  private readonly title: string;
  private readonly description: string;

  constructor(theme: Theme, title: string, description: string, initial: string, onSubmit: (value: string) => string | undefined, onCancel: () => void) {
    this.theme = theme;
    this.title = title;
    this.description = description;
    this.input.setValue(initial);
    // Cursor after the prefilled text, so Backspace edits it right away.
    this.input.handleInput("\x1b[F");
    this.input.focused = true;
    this.input.onSubmit = (value) => {
      this.error = onSubmit(value);
    };
    this.input.onEscape = onCancel;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  render(width: number): string[] {
    const t = this.theme;
    const inner = Math.max(10, width - PAD.length);
    const { top, bottom } = frameLines(t, this.title, width);
    const padded = (line: string) => truncateToWidth(PAD + line, width);
    return [
      top,
      "",
      ...wrapTextWithAnsi(t.fg("muted", this.description), inner).map(padded),
      "",
      ...this.input.render(inner).map(padded),
      "",
      padded(this.error ? t.fg("error", this.error) : ""),
      padded(t.fg("dim", "Enter save · Esc back")),
      bottom,
      "",
    ];
  }
}

/** Menus that open deeper menus; Esc on the first one closes the whole stack. */
export class MenuStack implements Component {
  private readonly stack: Component[] = [];
  private readonly onEmpty: () => void;
  /** Called whenever a menu closes and an earlier one is shown again. */
  private readonly onReturn: () => void;

  constructor(onEmpty: () => void, onReturn: () => void = () => {}) {
    this.onEmpty = onEmpty;
    this.onReturn = onReturn;
  }

  push(component: Component): void {
    this.stack.push(component);
  }

  /** Goes back one level, or closes when at the first menu. */
  pop(): void {
    this.stack.pop();
    if (this.stack.length === 0) this.onEmpty();
    else this.onReturn();
  }

  /** Goes back `levels` menus at once (e.g. past a choice menu after its number input). */
  popTo(levels: number): void {
    for (let i = 0; i < levels && this.stack.length > 1; i++) this.stack.pop();
    this.onReturn();
  }

  top(): Component | undefined {
    return this.stack.at(-1);
  }

  invalidate(): void {
    this.top()?.invalidate();
  }

  handleInput(data: string): void {
    this.top()?.handleInput?.(data);
  }

  render(width: number): string[] {
    return this.top()?.render(width) ?? [];
  }
}
