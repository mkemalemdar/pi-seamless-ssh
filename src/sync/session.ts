// One connected chat: the connection, the project, the placeholders, and everything that moves files between home
// and the remote. All home-side changes go through the session record, so they can be undone exactly.
//
// Files cross in batches: every file a sweep, a message or a tool call needs moved goes in one transfer.

import { rmSync, statSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join, posix } from "node:path";
import { localAddresses, pathCandidates, setAt, strings, withPort } from "../core/candidates.ts";
import { branchCommand, type ContextFile, contextDirs, contextScript, parseContext } from "../core/context.ts";
import { RECONNECT_DELAYS } from "../core/errors.ts";
import type { RemoteFile } from "../core/listing.ts";
import { type NameRules, resolveClashes } from "../core/names.ts";
import { FROM_HOME, homeToRemote, isSharedRel, relInside, remoteAgent, remoteToHome, resolveRemote, type Workspace } from "../core/paths.ts";
import { planSweep } from "../core/plan.ts";
import { pathsInText } from "../core/textpaths.ts";
import type { Askpass } from "../ssh/askpass.ts";
import type { Connection } from "../ssh/connection.ts";
import type { Remote } from "../ssh/remote.ts";
import { downloadMany, type Download, type Outcome, type Upload, uploadMany } from "../ssh/transfer.ts";
import { homeState, makeParents, moveAside, realName, removeEmptyDirs, writePlaceholder } from "./home.ts";
import type { RecordStore, SessionRecord } from "./record.ts";
import type { Scratch } from "./scratch.ts";

export type LinkState = "connected" | "reconnecting" | "lost";

export interface SessionHooks {
  /** Something to tell the user (problems are "warning"/"error"). */
  notify(message: string, type: "info" | "warning" | "error"): void;
  /** The status line changed. */
  changed(): void;
  /** Reconnecting by itself failed, or needs a password: ask the user what to do. */
  askReconnect(): Promise<"retry" | "wait" | "home">;
  /**
   * A started askpass for reconnecting: with `person` false it only uses a saved password (an automatic try); with
   * `person` true it may ask the user.
   */
  askpass(person: boolean): Promise<Askpass>;
}

/** A transfer under way, for the status line. */
export interface Transfer {
  direction: "up" | "down";
  done: number;
  total: number;
}

/** Transfers this big get a progress bar; smaller ones finish too fast to show one. */
const PROGRESS_MIN_BYTES = 1024 * 1024;
/** How often the connection's speed is checked, and from what reply time it counts as slow. */
const PING_MS = 20_000;
export const SLOW_MS = 300;

export interface SessionParts {
  conn: Connection;
  remote: Remote;
  ws: Workspace;
  store: RecordStore;
  /** On the same disk as pi's agent folder (set-aside home files are renamed into it). */
  sessionDir: string;
  scratch: Scratch;
  localPorts: number[];
  /** How home's disk compares file names. */
  names: NameRules;
  hooks: SessionHooks;
}

interface CallState {
  /** Placeholders holding real content for this call: emptied again afterwards. */
  filled: string[];
  /** Scratch folders holding copies fetched for this call. */
  fetched: string[];
  /** Files the tool should save: home path → remote path. */
  outputs: Map<string, string>;
}

export class Session {
  readonly conn: Connection;
  readonly remote: Remote;
  readonly ws: Workspace;
  readonly store: RecordStore;
  readonly sessionDir: string;
  readonly scratch: Scratch;
  readonly localPorts: number[];
  readonly nameRules: NameRules;
  state: LinkState = "connected";
  /** When the connection was made: home files newer than this may be moved to the remote when mentioned. */
  readonly connectedAt = Date.now();
  /** The remote agent folder as of the last sweep; undefined means the next sweep lists everything. */
  private view: Map<string, RemoteFile> | undefined;
  /** Home names → remote names, for every file the model may see a path of. */
  private readonly moved = new Map<string, string>();
  private readonly calls = new Map<string, CallState>();
  private readonly forwards = new Map<number, number>();
  private readonly reported = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** The project's git branch, when it's a git repository (shown in the status line). */
  branch: string | undefined;
  /** The transfer under way, if it's big enough for a progress bar. */
  transfer: Transfer | undefined;
  /** The last measured reply time (ms) of a trivial command. */
  latency: number | undefined;
  private pinger: NodeJS.Timeout | undefined;
  /** The last instructions read from the remote, used if a later read fails. */
  private context: ContextFile[] | undefined;
  private readonly hooks: SessionHooks;

  constructor(parts: SessionParts) {
    this.conn = parts.conn;
    this.remote = parts.remote;
    this.ws = parts.ws;
    this.store = parts.store;
    this.sessionDir = parts.sessionDir;
    this.scratch = parts.scratch;
    this.localPorts = parts.localPorts;
    this.nameRules = parts.names;
    this.hooks = parts.hooks;
    this.conn.onDrop(() => void this.reconnect());
    this.pinger = setInterval(() => void this.ping(), PING_MS);
    this.pinger.unref();
  }

  /** Measures how long a trivial command takes (only while nothing else runs, so it measures the link, not a queue). */
  private async ping(): Promise<void> {
    if (!this.usable || this.calls.size > 0) return;
    const t0 = Date.now();
    const r = await this.conn.run("true").catch(() => undefined);
    if (!r) return;
    const latency = Date.now() - t0;
    const wasSlow = (this.latency ?? 0) > SLOW_MS;
    this.latency = latency;
    if (wasSlow !== latency > SLOW_MS) this.hooks.changed();
  }

  /** A progress callback for a transfer: shown while it runs (when big enough), gone when it ends. */
  private progress(direction: Transfer["direction"]): { report: (done: number, total: number) => void; end: () => void } {
    let last = 0;
    return {
      report: (done, total) => {
        if (total < PROGRESS_MIN_BYTES) return;
        this.transfer = { direction, done, total };
        // At most a few updates a second.
        if (Date.now() - last > 200 || done >= total) {
          last = Date.now();
          this.hooks.changed();
        }
      },
      end: () => {
        if (!this.transfer) return;
        this.transfer = undefined;
        this.hooks.changed();
      },
    };
  }

  /** Uploads with a progress bar in the status line. */
  private async upload(items: readonly Upload[]): Promise<Outcome[]> {
    const p = this.progress("up");
    try {
      return await uploadMany(this.remote, items, this.scratch, p.report);
    } catch (e) {
      return items.map(() => ({ ok: false as const, error: (e as Error).message }));
    } finally {
      p.end();
    }
  }

  /** Downloads with a progress bar in the status line. */
  private async download(items: readonly Download[]): Promise<Outcome[]> {
    const p = this.progress("down");
    try {
      return await downloadMany(this.remote, items, this.scratch, p.report);
    } finally {
      p.end();
    }
  }

  get record(): SessionRecord {
    return this.store.record!;
  }

  get machine(): string {
    return this.conn.machine;
  }

  /** Routed tools may run. */
  get usable(): boolean {
    return this.state === "connected" && this.conn.isAlive();
  }

  private get agent(): string {
    return remoteAgent(this.ws);
  }

  /** The remote file keeping the last listing, so the next one sends only changes. */
  private get stateFile(): string {
    return posix.join(this.ws.remoteProject, ".pi", `.pss-list-${this.record.sessionId}`);
  }

  private home(rel: string): string {
    return `${this.ws.homeAgent}/${rel}`;
  }

  /** Tells the user once (per text) about something that keeps being true. */
  private once(key: string, message: string): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.hooks.notify(message, "warning");
  }

  /** One thing at a time: sweeps, moves and calls never overlap. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  // ------------------------------------------------------------------ sweeps

  sweep(): Promise<void> {
    return this.serial(() => this.sweepNow());
  }

  private async sweepNow(): Promise<void> {
    // The link, not `usable`: a reconnect lists the files before tools may run again.
    if (!this.conn.isAlive()) return;
    let listing;
    try {
      listing = await this.remote.listAgent(this.agent, this.stateFile, this.view);
    } catch {
      // A listing that failed is never read as "the remote is empty": nothing is deleted, and the next sweep lists
      // everything again.
      this.view = undefined;
      return;
    }
    this.view = listing.files;
    if (listing.odd > 0) {
      this.once(`odd:${listing.odd}`, `pi-seamless-ssh: ${listing.odd} file(s) in ${this.agent} have a line break or another control character in their name; they aren't shown on this machine.`);
    }

    const shared = [...listing.files.keys()].filter(isSharedRel);
    const { shown, hidden } = resolveClashes(shared, this.nameRules);
    for (const [kept, others] of hidden) {
      this.once(`clash:${kept}`, `pi-seamless-ssh: this machine's disk doesn't tell apart ${[kept, ...others].join(", ")}; only ${kept} is shown here.`);
    }
    const remote = new Map([...shown].map((rel) => [rel, listing.files.get(rel)!]));
    const made = new Map(Object.entries(this.record.placeholders));

    const uploads: string[] = [];
    const deletes: string[] = [];
    for (const action of planSweep(remote, made, (rel) => homeState(this.home(rel)))) {
      const path = this.home(action.rel);
      try {
        switch (action.do) {
          case "create":
          case "refresh":
            this.place(action.rel, action.file);
            break;
          case "set-aside": {
            // On a disk that folds names, the home file may be called differently: keep its real name for putting back.
            const original = realName(path, this.nameRules);
            const aside = join(this.sessionDir, "set-aside", action.rel);
            moveAside(original, aside);
            this.record.setAside[action.rel] = { aside, original };
            this.place(action.rel, action.file);
            break;
          }
          case "remove":
            unlinkSync(path);
            delete this.record.placeholders[action.rel];
            break;
          case "forget":
            delete this.record.placeholders[action.rel];
            break;
          case "upload":
            uploads.push(action.rel);
            break;
          case "delete-remote":
            deletes.push(action.rel);
            break;
        }
      } catch (e) {
        this.hooks.notify(`pi-seamless-ssh: couldn't sync ${action.rel}: ${(e as Error).message}`, "warning");
      }
    }
    await this.uploadAgentFiles(uploads);
    if (deletes.length) {
      try {
        await this.remote.removeAll(deletes.map((rel) => posix.join(this.agent, rel)));
        for (const rel of deletes) delete this.record.placeholders[rel];
      } catch (e) {
        // Kept in the record: the next sweep tries again.
        this.hooks.notify(`pi-seamless-ssh: couldn't delete ${deletes.join(", ")} on ${this.machine}: ${(e as Error).message}`, "warning");
      }
    }
    this.store.save();
  }

  private place(rel: string, file: RemoteFile): void {
    const path = this.home(rel);
    makeParents(path, (dir) => this.record.createdDirs.push(dir));
    writePlaceholder(path, file);
    this.record.placeholders[rel] = file;
  }

  /** Home files in the agent folder go to the same place in the project's agent folder; each leaves a placeholder. */
  private async uploadAgentFiles(rels: readonly string[]): Promise<void> {
    const items = rels.map((rel): Upload & { rel: string; size: number } => {
      const st = statSync(this.home(rel));
      return { rel, size: st.size, from: { path: this.home(rel) }, to: posix.join(this.agent, rel), mtime: Math.floor(st.mtimeMs / 1000) };
    });
    const outcomes = await this.upload(items);
    items.forEach((it, i) => {
      const outcome = outcomes[i]!;
      if (outcome.ok) this.place(it.rel, { size: it.size, mtime: it.mtime });
      else this.hooks.notify(`pi-seamless-ssh: couldn't copy ${it.rel} to ${this.machine} (it stays here and is tried again): ${outcome.error}`, "warning");
    });
  }

  // ------------------------------------------------------------------ moving mentioned files

  /** Home files a message mentions, made while connected: moved to the remote. */
  moveMentioned(text: string): Promise<void> {
    return this.serial(async () => {
      await this.moveMentionedNow(text);
      this.store.save();
    });
  }

  private async moveMentionedNow(text: string): Promise<void> {
    if (!this.usable) return;
    const inAgent: string[] = [];
    const elsewhere: { path: string; to: string; mtime: number }[] = [];
    for (const path of pathsInText(text)) {
      if (this.moved.has(path)) continue;
      const st = homeState(path);
      if (st.kind !== "file") continue;
      const rel = relInside(this.ws.homeAgent, path);
      if (rel !== undefined) {
        // In pi's folder: only extension file folders, and only files that aren't untouched placeholders.
        const made = this.record.placeholders[rel];
        if (isSharedRel(rel) && !(made && made.size === st.size && made.mtime === st.mtime)) inAgent.push(rel);
        continue;
      }
      if (this.scratch.owns(path)) continue;
      // Elsewhere on home: only files made since connecting (a screenshot the browser just saved, etc.).
      if (statSync(path).mtimeMs < this.connectedAt - 2000) continue;
      elsewhere.push({ path, to: posix.join(this.agent, FROM_HOME, `${Date.now().toString(36)}-${basename(path)}`), mtime: st.mtime });
    }
    await this.uploadAgentFiles([...new Set(inAgent)]);
    if (elsewhere.length === 0) return;
    const outcomes = await this.upload(elsewhere.map((e) => ({ from: { path: e.path }, to: e.to, mtime: e.mtime })));
    elsewhere.forEach((e, i) => {
      const outcome = outcomes[i]!;
      if (!outcome.ok) return this.hooks.notify(`pi-seamless-ssh: couldn't move ${e.path} to ${this.machine}: ${outcome.error}`, "warning");
      unlinkSync(e.path);
      this.moved.set(e.path, e.to);
    });
  }

  // ------------------------------------------------------------------ home tool calls

  /** Before a home tool runs: remote files it's given are made available, save paths point into the scratch space. */
  prepareCall(callId: string, input: unknown): Promise<string | undefined> {
    return this.serial(async () => {
      if (!this.usable) return undefined;
      const state: CallState = { filled: [], fetched: [], outputs: new Map() };
      this.calls.set(callId, state);
      try {
        await this.preparePaths(input, state);
        await this.prepareForwards(input);
      } catch (e) {
        return `pi-seamless-ssh couldn't prepare this call on ${this.machine}: ${(e as Error).message}`;
      } finally {
        this.store.save();
      }
      return undefined;
    });
  }

  private async preparePaths(input: unknown, state: CallState): Promise<void> {
    const found = pathCandidates(input);
    if (found.length === 0) return;
    const remotePaths = found.map((c) => resolveRemote(c.value, this.ws));
    const kinds = await this.remote.kinds(remotePaths);
    const downloads: (Download & { slot: (typeof found)[number]["slot"]; rel?: string })[] = [];
    found.forEach((c, i) => {
      const remotePath = remotePaths[i]!;
      const kind = kinds[i]!;
      if (kind.kind === "file") {
        const home = remoteToHome(remotePath, this.ws);
        const rel = home ? relInside(this.ws.homeAgent, home) : undefined;
        if (home && rel && isSharedRel(rel)) {
          // A file in the project's agent folder: its placeholder gets the real content for this call.
          makeParents(home, (dir) => this.record.createdDirs.push(dir));
          downloads.push({ from: remotePath, to: home, size: kind.size, slot: c.slot, rel });
        } else {
          const dir = this.scratch.dir(kind.size);
          state.fetched.push(dir);
          downloads.push({ from: remotePath, to: join(dir, basename(remotePath) || "file"), size: kind.size, slot: c.slot });
        }
      } else if (kind.kind === "new") {
        const dir = this.scratch.dir();
        state.fetched.push(dir);
        const local = join(dir, basename(remotePath) || "file");
        state.outputs.set(local, remotePath);
        this.moved.set(local, remotePath);
        setAt(input, c.slot, local);
      }
    });
    const outcomes = await this.download(downloads);
    downloads.forEach((d, i) => {
      const outcome = outcomes[i]!;
      if (!outcome.ok) throw new Error(`couldn't get ${d.from}: ${outcome.error}`);
      if (d.rel) {
        const st = homeState(d.to);
        if (st.kind === "file") this.record.placeholders[d.rel] = { size: st.size, mtime: st.mtime };
        state.filled.push(d.rel);
      } else this.moved.set(d.to, d.from);
      setAt(input, d.slot, d.to);
    });
  }

  private async prepareForwards(input: unknown): Promise<void> {
    for (const c of strings(input)) {
      let value = c.value;
      for (const address of localAddresses(c.value)) {
        if (this.localPorts.includes(address.port)) continue;
        const local = await this.forward(address.port);
        if (local !== address.port) value = withPort(value, address, local);
      }
      if (value !== c.value) setAt(input, c.slot, value);
    }
  }

  /** The port forwards open now: the remote's port → the home port that reaches it. */
  forwardsList(): { remote: number; local: number }[] {
    return [...this.forwards].map(([remote, local]) => ({ remote, local })).sort((a, b) => a.remote - b.remote);
  }

  /** Closes a port forward (it's set up again if a tool uses that port later). */
  async closeForward(remotePort: number): Promise<void> {
    const local = this.forwards.get(remotePort);
    if (local === undefined) return;
    await this.conn.cancelForward(local, remotePort);
    this.forwards.delete(remotePort);
  }

  /** Home port that leads to the remote's `port` (the same number when it's free on home). */
  private async forward(port: number): Promise<number> {
    const known = this.forwards.get(port);
    if (known !== undefined) return known;
    const local = port >= 1024 && (await portFree(port)) ? port : await freePort();
    await this.conn.forward(local, port);
    this.forwards.set(port, local);
    return local;
  }

  /** After a home tool ran: files it saved go to the remote, filled placeholders are emptied, copies removed. */
  finishCall(callId: string, resultText: string): Promise<void> {
    return this.serial(async () => {
      const state = this.calls.get(callId);
      this.calls.delete(callId);
      if (state) {
        const saved = [...state.outputs].filter(([local]) => homeState(local).kind === "file");
        if (saved.length) {
          const items = saved.map(([local, to]) => ({ from: { path: local }, to, mtime: Math.floor(statSync(local).mtimeMs / 1000) }));
          const outcomes = await this.upload(items);
          saved.forEach(([local, to], i) => {
            const outcome = outcomes[i]!;
            if (!outcome.ok) this.hooks.notify(`pi-seamless-ssh: couldn't save ${to} on ${this.machine}: ${outcome.error}`, "warning");
            else unlinkSync(local);
          });
        }
        for (const rel of state.filled) {
          const file = this.record.placeholders[rel];
          if (file) writePlaceholder(this.home(rel), file);
        }
        for (const dir of state.fetched) rmSync(dir, { recursive: true, force: true });
      }
      await this.moveMentionedNow(resultText).catch(() => {});
      this.store.save();
    });
  }

  /**
   * The instructions for the model, read on the remote at the start of every run (so an edited AGENTS.md applies at
   * once), and the project's git branch with them. If the remote can't be read, the last ones read are used.
   */
  async remoteContext(): Promise<ContextFile[] | undefined> {
    if (!this.usable) return this.context;
    try {
      const out = await this.remote.sh(contextScript(contextDirs(this.agent, this.ws.remoteProject), this.ws.remoteProject));
      const { files, branch } = parseContext(out);
      this.context = files;
      if (branch !== this.branch) {
        this.branch = branch;
        this.hooks.changed();
      }
    } catch {
      // Keep the last ones.
    }
    return this.context;
  }

  /** Reads the project's git branch again (after a bash command, which may have switched it). */
  async refreshBranch(): Promise<void> {
    if (!this.usable) return;
    const r = await this.conn.run(branchCommand(this.ws.remoteProject)).catch(() => undefined);
    if (!r) return;
    const branch = r.code === 0 ? r.stdout.toString("utf8").trim() || undefined : undefined;
    if (branch !== this.branch) {
      this.branch = branch;
      this.hooks.changed();
    }
  }

  /** Every home name the model must see as a remote name. */
  names(): Map<string, string> {
    const names = new Map(this.moved);
    for (const rel of Object.keys(this.record.placeholders)) names.set(this.home(rel), homeToRemote(this.home(rel), this.ws)!);
    return names;
  }

  // ------------------------------------------------------------------ dropped connection

  private async reconnect(): Promise<void> {
    if (this.closed) return;
    this.state = "reconnecting";
    this.hooks.changed();
    // By itself first: a key, the agent, or a saved password log in without anyone.
    for (const seconds of RECONNECT_DELAYS) {
      await sleep(seconds * 1000);
      if (this.closed) return;
      if (await this.tryReconnect(false)) return;
    }
    this.state = "lost";
    this.hooks.changed();
    for (;;) {
      const choice = await this.hooks.askReconnect();
      if (this.closed) return;
      if (choice === "home") return void (await this.close());
      if (choice === "wait") {
        await sleep(30_000);
        if (this.closed) return;
      }
      if (await this.tryReconnect(true)) return;
    }
  }

  /** One reconnect attempt; any failure (the login helper included) is just a failed attempt. */
  private async tryReconnect(person: boolean): Promise<boolean> {
    let askpass: Askpass | undefined;
    try {
      askpass = await this.hooks.askpass(person);
      await this.conn.open(askpass);
      await this.afterReconnect();
      return true;
    } catch (e) {
      if (person) this.hooks.notify(`Still can't reach ${this.machine}: ${(e as Error).message}`, "warning");
      return false;
    } finally {
      askpass?.stop();
    }
  }

  /** Back in shape before anything may run again: the port forwards, and the files listed again. */
  private async afterReconnect(): Promise<void> {
    // Whatever happened while away is unknown: list everything again.
    this.view = undefined;
    const ports = [...this.forwards.entries()];
    this.forwards.clear();
    for (const [remotePort, local] of ports) {
      try {
        await this.conn.forward(local, remotePort);
        this.forwards.set(remotePort, local);
      } catch {
        // Set up again the next time a tool uses it.
      }
    }
    await this.remote.cleanLeftovers(posix.join(this.ws.remoteProject, ".pi")).catch(() => {});
    // Read again (it may have changed); if it can't be read now, the one from before stays.
    await this.remote.useLoginPath();
    await this.sweep();
    this.state = "connected";
    this.hooks.notify(`Reconnected to ${this.machine}.`, "info");
    this.hooks.changed();
  }

  // ------------------------------------------------------------------ disconnect

  /** Back home: last sync, placeholders removed, home files put back, connection closed. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.serial(async () => {
      this.closed = true;
      clearInterval(this.pinger);
      if (this.usable) {
        await this.sweepNow().catch(() => {});
        await this.remote.removeAll([this.stateFile]).catch(() => {});
      }
      const left = undoHomeChanges(this.record, this.ws.homeAgent, (rel) => this.hooks.notify(`pi-seamless-ssh kept ${rel}: an extension wrote to it while ${this.machine} was offline.`, "warning"));
      this.scratch.remove();
      // Set-aside home files that couldn't go back are kept, never deleted.
      if (left.length === 0) rmSync(this.sessionDir, { recursive: true, force: true });
      else this.hooks.notify(`pi-seamless-ssh couldn't put back ${left.join(", ")}; they are in ${join(this.sessionDir, "set-aside")}.`, "warning");
      await this.conn.close();
      this.store.clear();
      this.hooks.changed();
    });
  }
}

/**
 * Removes this session's placeholders (only untouched ones: one an extension wrote real content into is kept and
 * reported), puts set-aside home files back under their own names and removes the folders it made. Used on disconnect
 * and after a crash. Returns the set-aside files that couldn't be put back.
 */
export function undoHomeChanges(record: SessionRecord, homeAgent: string, kept: (rel: string) => void): string[] {
  for (const [rel, file] of Object.entries(record.placeholders)) {
    const path = `${homeAgent}/${rel}`;
    const now = homeState(path);
    if (now.kind === "file" && now.size === file.size && now.mtime === file.mtime) unlinkSync(path);
    else if (now.kind === "file") kept(rel);
  }
  const left: string[] = [];
  for (const [rel, { aside, original }] of Object.entries(record.setAside)) {
    try {
      if (homeState(original).kind === "missing") moveAside(aside, original);
      else left.push(rel);
    } catch {
      left.push(rel);
    }
  }
  removeEmptyDirs(record.createdDirs);
  return left;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      s.close(() => resolve(port));
    });
  });
}
