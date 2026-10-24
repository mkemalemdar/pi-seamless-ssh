// The password screen, inside the /ssh frame:
//
//   me@192.168.1.20's password:
//
//   › ••••••••
//
//   [x] Save the password             in the macOS Keychain
//   [ ] Set up key login on vm        no password from now on
//
// Typing goes into the field (spaces too). ↑↓ moves to the boxes, Space ticks one; ticking one unticks the other, so
// it's one of them or neither. Enter connects from anywhere. Esc cancels the connection (not just this try).

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Keep } from "../core/settings.ts";
import { frameLines } from "./components.ts";

const PAD = "  ";

export interface PasswordAnswer {
  password: string;
  keep?: Keep;
}

export interface PasswordOptions {
  /** Offer the two boxes (not when reconnecting by itself, where the choice was made before). */
  offerKeep: boolean;
  /** Ticked at the start (a saved machine's choice). */
  preset?: Keep;
  /** Where a saved password goes, e.g. "in the macOS Keychain". */
  where: string;
  /** Shown above the field, e.g. "The saved password didn't work." */
  note?: string;
  /** The key line, when it isn't a connection's (e.g. sudo's). */
  hint?: string;
}

export class PasswordPrompt implements Component {
  private value = "";
  /** 0 = the field, 1 = save the password, 2 = key login. */
  private focus = 0;
  private keep: Keep | undefined;

  private readonly theme: Theme;
  private readonly title: string;
  private readonly prompt: string;
  private readonly machine: string;
  private readonly options: PasswordOptions;
  private readonly onSubmit: (answer: PasswordAnswer) => void;
  private readonly onCancel: () => void;

  constructor(theme: Theme, machine: string, prompt: string, options: PasswordOptions, onSubmit: (answer: PasswordAnswer) => void, onCancel: () => void) {
    this.theme = theme;
    this.title = `ssh › ${machine}`;
    this.machine = machine;
    this.prompt = prompt.trim() || "Password:";
    this.options = options;
    this.keep = options.offerKeep ? options.preset : undefined;
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const rows = this.options.offerKeep ? 3 : 1;
    if (matchesKey(data, "escape")) return this.onCancel();
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const answer: PasswordAnswer = { password: this.value, ...(this.keep ? { keep: this.keep } : {}) };
      this.value = "";
      return this.onSubmit(answer);
    }
    if (matchesKey(data, "up")) this.focus = (this.focus - 1 + rows) % rows;
    else if (matchesKey(data, "down") || matchesKey(data, "tab")) this.focus = (this.focus + 1) % rows;
    else if (this.focus > 0) {
      if (matchesKey(data, "space")) {
        const box: Keep = this.focus === 1 ? "password" : "key";
        this.keep = this.keep === box ? undefined : box;
      }
    } else if (matchesKey(data, "backspace")) this.value = [...this.value].slice(0, -1).join("");
    else if (!data.startsWith("\x1b")) this.value += [...data].filter((ch) => ch >= " " && ch !== "\x7f").join("");
  }

  render(width: number): string[] {
    const t = this.theme;
    const inner = Math.max(10, width - PAD.length);
    const { top, bottom } = frameLines(t, this.title, width);
    const lines = [top, ""];
    const text = (line: string) => lines.push(truncateToWidth(PAD + line, width));
    if (this.options.note) for (const line of wrapTextWithAnsi(t.fg("warning", this.options.note), inner)) text(line);
    for (const line of wrapTextWithAnsi(t.fg("muted", this.prompt), inner)) text(line);
    text("");
    const field = `${this.focus === 0 ? t.fg("accent", "› ") : "  "}${"•".repeat([...this.value].length)}${this.focus === 0 ? t.fg("accent", "▏") : ""}`;
    text(field);
    if (this.options.offerKeep) {
      text("");
      const boxes: [Keep, string, string][] = [
        ["password", "Save the password", this.options.where],
        ["key", `Set up key login on ${this.machine}`, "no password from now on"],
      ];
      const labelWidth = Math.max(...boxes.map(([, label]) => visibleWidth(label))) + 4;
      boxes.forEach(([box, label, detail], i) => {
        const focused = this.focus === i + 1;
        const mark = this.keep === box ? "[x]" : "[ ]";
        const body = `${mark} ${label}`;
        text(`${focused ? t.fg("accent", "→ ") : "  "}${focused ? t.fg("accent", body) : body}${" ".repeat(Math.max(1, labelWidth - visibleWidth(label)))}${t.fg("dim", detail)}`);
      });
    }
    text("");
    text(t.fg("dim", this.options.hint ?? (this.options.offerKeep ? "Enter connect · ↑↓ move · Space tick · Esc cancel the connection" : "Enter connect · Esc cancel the connection")));
    lines.push(bottom, "");
    return lines;
  }
}
