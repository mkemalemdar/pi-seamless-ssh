// The password for sudo on the remote. By default every sudo asks (the box shows the command), so the model never has
// sudo without you seeing what for. With "Remember the sudo password" on, the first password given is kept in memory
// (never saved) for that connection and given to every sudo after it, until disconnecting or the setting goes off.

import type { SudoRequest } from "./routed/bash.ts";

export class SudoPasswords {
  private kept: { connection: object; password: string } | undefined;
  private readonly remember: () => boolean;

  constructor(remember: () => boolean) {
    this.remember = remember;
  }

  /** The kept password for `connection`, or what `ask` returns (kept when remembering). */
  async answer(request: SudoRequest, connection: object, ask: (request: SudoRequest) => Promise<string | undefined>): Promise<string | undefined> {
    // A sudo asking again: the last answer was wrong, so a kept one is dropped.
    if (request.retry || !this.remember() || this.kept?.connection !== connection) this.kept = undefined;
    if (this.kept) return this.kept.password;
    const password = await ask(request);
    if (password !== undefined && this.remember()) this.kept = { connection, password };
    return password;
  }

  forget(): void {
    this.kept = undefined;
  }
}
