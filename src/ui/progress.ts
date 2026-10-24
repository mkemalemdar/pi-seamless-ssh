// Inside the /ssh frame while connecting: each step as it happens ("Connecting…", "Checking the machine…"), and a
// problem in plain words with Esc to go back. Also a two-choice question (trusting a new host key).

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { frameLines, ListMenu } from "./components.ts";

const PAD = "  ";

export class ProgressView implements Component {
	private readonly steps: string[] = [];
	private problem: string | undefined;
	private stopping = false;
	/** What Esc does while a step is running: stop the attempt. */
	stop: (() => void) | undefined;

	private readonly theme: Theme;
	private readonly title: string;
	private readonly onBack: () => void;

	constructor(theme: Theme, title: string, onBack: () => void) {
		this.theme = theme;
		this.title = title;
		this.onBack = onBack;
	}

	/** The step now under way; earlier ones show as done. */
	step(text: string): void {
		this.steps.push(text);
	}

	fail(message: string): void {
		this.problem = message;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.problem) {
			// After a problem, Esc (or Enter) goes back.
			if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "return")) this.onBack();
			return;
		}
		// While working, Esc stops it.
		if (matchesKey(data, "escape") && this.stop && !this.stopping) {
			this.stopping = true;
			this.stop();
		}
	}

	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(10, width - PAD.length);
		const { top, bottom } = frameLines(t, this.title, width);
		const lines = [top, ""];
		const text = (line: string) => lines.push(truncateToWidth(PAD + line, width));
		this.steps.forEach((s, i) => {
			const last = i === this.steps.length - 1;
			if (!last) text(`${t.fg("success", "✓")} ${t.fg("dim", s)}`);
			else if (this.problem) text(`${t.fg("error", "✗")} ${s}`);
			else text(`${t.fg("accent", "…")} ${s}`);
		});
		text("");
		if (this.problem) {
			for (const line of wrapTextWithAnsi(t.fg("error", this.problem), inner)) text(line);
			text("");
			text(t.fg("dim", "Esc back"));
		} else text(t.fg("dim", this.stopping ? "stopping…" : "Esc stop"));
		lines.push(bottom, "");
		return lines;
	}
}

/** A yes/no question as a two-row menu. */
export function confirmMenu(theme: Theme, title: string, question: string, yes: string, no: string, answer: (ok: boolean) => void): ListMenu {
	return new ListMenu(theme, {
		title,
		description: question,
		items: [
			{ id: "yes", label: yes },
			{ id: "no", label: no },
		],
		initialId: "no",
		onSelect: (item) => answer(item.id === "yes"),
		onCancel: () => answer(false),
		hint: "↑↓ move · Enter choose · Esc no",
	});
}
