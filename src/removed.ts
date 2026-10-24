// "Remove everything": once the extension's files are deleted, nothing may write files again in this pi process
// (settings, sessions, the debug log, sockets), or the cleanup would leave new leftovers. The flag lives on
// globalThis so it also holds if pi loads the extension again (/new, /reload).

const state = globalThis as typeof globalThis & { __piSeamlessSshRemoved?: boolean };

export function markRemoved(): void {
	state.__piSeamlessSshRemoved = true;
}

/** True after "Remove everything" ran in this process: the extension stays inert. */
export function isRemoved(): boolean {
	return state.__piSeamlessSshRemoved === true;
}
