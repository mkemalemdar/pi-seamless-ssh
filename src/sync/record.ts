// The `current-session` file: everything a connection has changed on home, so a disconnect, or the next start after
// a crash, undoes exactly that and never touches anything else. Written atomically on every change.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RemoteFile } from "../core/listing.ts";

export interface SessionRecord {
	version: 1;
	/** The pi that made it; a record whose pi is gone is a leftover from a crash. */
	pid: number;
	machine: string;
	destination: string;
	port?: number;
	controlPath: string;
	project: string;
	remoteHome: string;
	/** Placeholders made on home, by their place under the agent folder, with the size and date they were given. */
	placeholders: Record<string, RemoteFile>;
	/** Home files set aside because a remote file has the same name: place → where it waits, and its own real name. */
	setAside: Record<string, { aside: string; original: string }>;
	/** This connection's id: names its scratch space and its listing state file on the remote. */
	sessionId: string;
	/** The scratch space in RAM, if the home has one (removed after a crash too). */
	scratchRam?: string;
	/** Folders made on home for placeholders (removed again when empty). */
	createdDirs: string[];
}

export class RecordStore {
	readonly path: string;
	record: SessionRecord | undefined;

	constructor(dir: string) {
		this.path = join(dir, "current-session.json");
	}

	read(): SessionRecord | undefined {
		if (!existsSync(this.path)) return undefined;
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf8")) as SessionRecord;
			if (raw?.version !== 1 || typeof raw.pid !== "number") return undefined;
			raw.placeholders ??= {};
			raw.setAside ??= {};
			raw.sessionId ??= "unknown";
			raw.createdDirs ??= [];
			return raw;
		} catch {
			return undefined;
		}
	}

	start(record: SessionRecord): void {
		this.record = record;
		this.save();
	}

	save(): void {
		if (!this.record) return;
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.record, null, 2), { mode: 0o600 });
		renameSync(tmp, this.path);
	}

	clear(): void {
		this.record = undefined;
		rmSync(this.path, { force: true });
	}
}

/** Is that process still running? */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}
