// What a sweep has to do, worked out from three facts: what the remote has, which placeholders this session made,
// and what is at each of those places on home now. Pure, so every case is a unit test.

import type { RemoteFile } from "./listing.ts";

/** What is at a placeholder's place on home. */
export type HomeState =
	| { kind: "missing" }
	| { kind: "file"; size: number; mtime: number }
	/** A folder, a link, anything that isn't a plain file: left alone. */
	| { kind: "other" };

export type Action =
	/** Make a placeholder (nothing is there on home). */
	| { do: "create"; rel: string; file: RemoteFile }
	/** A home file of that name is there: set it aside for the session, then make the placeholder. */
	| { do: "set-aside"; rel: string; file: RemoteFile }
	/** The remote file changed: the placeholder takes its new size and date. */
	| { do: "refresh"; rel: string; file: RemoteFile }
	/** The remote file is gone: remove the placeholder. */
	| { do: "remove"; rel: string }
	/** An extension deleted the placeholder: delete the remote file. */
	| { do: "delete-remote"; rel: string }
	/** An extension wrote real content into the placeholder: copy it to the remote, then make it a placeholder again. */
	| { do: "upload"; rel: string }
	/** The placeholder and the remote file are both gone: forget it. */
	| { do: "forget"; rel: string };

const same = (a: { size: number; mtime: number }, b: { size: number; mtime: number }) => a.size === b.size && a.mtime === b.mtime;

export function planSweep(
	remote: ReadonlyMap<string, RemoteFile>,
	placeholders: ReadonlyMap<string, RemoteFile>,
	home: (rel: string) => HomeState,
): Action[] {
	const actions: Action[] = [];
	for (const [rel, file] of remote) {
		const made = placeholders.get(rel);
		const now = home(rel);
		if (!made) {
			if (now.kind === "missing") actions.push({ do: "create", rel, file });
			else if (now.kind === "file") actions.push({ do: "set-aside", rel, file });
			continue;
		}
		if (now.kind === "missing") actions.push({ do: "delete-remote", rel });
		else if (now.kind === "file" && !same(now, made)) actions.push({ do: "upload", rel });
		else if (now.kind === "file" && !same(file, made)) actions.push({ do: "refresh", rel, file });
	}
	for (const [rel, made] of placeholders) {
		if (remote.has(rel)) continue;
		const now = home(rel);
		if (now.kind === "file" && same(now, made)) actions.push({ do: "remove", rel });
		else if (now.kind === "file") actions.push({ do: "upload", rel });
		else actions.push({ do: "forget", rel });
	}
	return actions;
}
