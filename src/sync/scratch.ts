// Where the session keeps short-lived copies: files fetched for one tool call, files a tool saves before they go to the
// remote, transfer staging. On a Linux home with a RAM file system at /dev/shm they live in memory, never written to
// disk; otherwise (macOS, or no /dev/shm) in the session folder. A file too big for the RAM space left goes to disk.

import { mkdirSync, mkdtempSync, rmdirSync, rmSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ramFolder } from "../runtime.ts";

/** RAM that stays free for everything else on the machine. */
const RAM_MARGIN = 256 * 1024 * 1024;

export class Scratch {
	/** Memory-backed folder for this session, if the home has one. */
	readonly ram: string | undefined;
	readonly disk: string;

	constructor(sessionId: string, diskDir: string) {
		const base = ramFolder();
		this.ram = base ? join(base, sessionId) : undefined;
		if (this.ram) mkdirSync(this.ram, { recursive: true, mode: 0o700 });
		this.disk = diskDir;
		mkdirSync(this.disk, { recursive: true, mode: 0o700 });
	}

	/** A fresh private folder for `bytes` of data: in RAM when it fits, on disk otherwise. */
	dir(bytes = 0): string {
		return mkdtempSync(join(this.ram && this.fitsInRam(bytes) ? this.ram : this.disk, "x-"));
	}

	private fitsInRam(bytes: number): boolean {
		try {
			const fs = statfsSync(this.ram!);
			return fs.bavail * fs.bsize - bytes > RAM_MARGIN;
		} catch {
			return false;
		}
	}

	/** Is `path` one of this session's own scratch files? */
	owns(path: string): boolean {
		return [this.ram, this.disk].some((base) => base !== undefined && path.startsWith(`${base}/`));
	}

	/** Removes everything this session put here. */
	remove(): void {
		if (this.ram) {
			rmSync(this.ram, { recursive: true, force: true });
			// The setup's RAM folder goes too once no session uses it (another pi's session keeps it).
			try {
				rmdirSync(dirname(this.ram));
			} catch {
				// Not empty, or gone already.
			}
		}
		rmSync(this.disk, { recursive: true, force: true });
	}
}
