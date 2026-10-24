// The remote scripts, run for real with /bin/sh on this machine.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteBashOps } from "../src/routed/bash.ts";
import { grepScript } from "../src/routed/grep.ts";
import { findOps, lsOps, readOps, sniffImage } from "../src/routed/ops.ts";
import { downloadMany, uploadMany } from "../src/ssh/transfer.ts";
import { ramBase, Scratch } from "../src/sync/scratch.ts";
import { localRemote } from "./local-remote.ts";

const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "pss-test-"));
  made.push(d);
  return d;
};
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("probe: OS, home, and the tools the extension needs", async () => {
  const { remote } = await localRemote();
  assert.equal(remote.info.os, process.platform === "darwin" ? "darwin" : "linux");
  assert.deepEqual(remote.info.missing, []);
  assert.ok(remote.info.home.startsWith("/"));
});

test("bash: output streams, the exit code comes back, the working folder is the project", async () => {
  const { remote } = await localRemote();
  const dir = tmp();
  const ops = remoteBashOps(() => remote);
  let out = "";
  const r = await ops.exec("pwd; echo hi; echo err >&2; exit 3", dir, { onData: (d) => (out += d.toString()) });
  assert.equal(r.exitCode, 3);
  assert.match(out, new RegExp(`${dir}\\n`));
  assert.match(out, /hi\n/);
  assert.match(out, /err\n/);
});

test("bash: a background program doesn't hang the call, and keeps running after it", async () => {
  const { remote } = await localRemote();
  const dir = tmp();
  const ops = remoteBashOps(() => remote);
  const started = Date.now();
  const r = await ops.exec("(sleep 2; echo done > bg.txt) & echo started", dir, { onData: () => {} });
  assert.equal(r.exitCode, 0);
  assert.ok(Date.now() - started < 1500, "returned before the background program finished");
  await new Promise((res) => setTimeout(res, 2500));
  assert.equal(readFileSync(join(dir, "bg.txt"), "utf8"), "done\n");
});

test("bash: Esc stops the command and what it started; a timeout too", async () => {
  const { remote } = await localRemote();
  const dir = tmp();
  const ops = remoteBashOps(() => remote);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 600);
  await assert.rejects(ops.exec("(sleep 3; echo leaked > leak.txt) & sleep 30", dir, { onData: () => {}, signal: ac.signal }), /aborted/);
  await new Promise((res) => setTimeout(res, 3500));
  assert.ok(!existsSync(join(dir, "leak.txt")), "the child was stopped too");
  await assert.rejects(ops.exec("sleep 30", dir, { onData: () => {}, timeout: 1 }), /timeout:1/);
});

test("bash: a missing working folder is reported", async () => {
  const { remote } = await localRemote();
  await assert.rejects(remoteBashOps(() => remote).exec("true", "/nonexistent/x", { onData: () => {} }), /Working directory does not exist/);
});

test("files: read, image sniffing, kinds with sizes", async () => {
  const { remote } = await localRemote();
  const dir = tmp();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  writeFileSync(join(dir, "a.png"), png);
  assert.ok((await readOps(() => remote).readFile(join(dir, "a.png"))).equals(png));
  assert.equal(await readOps(() => remote).detectImageMimeType!(join(dir, "a.png")), "image/png");
  assert.equal(sniffImage(Buffer.from("hello")), null);
  assert.deepEqual(await remote.kinds([join(dir, "a.png"), dir, join(dir, "new.png"), "/nonexistent/x/y"]), [{ kind: "file", size: 11 }, { kind: "dir" }, { kind: "new" }, { kind: "none" }]);
});

test("transfers: many files in one stream, dates kept, folders made, nothing half written, compression when it pays", async () => {
  const { remote } = await localRemote();
  const dir = tmp();
  const scratch = new Scratch(`t${Date.now()}`, join(tmp(), "scratch"));
  const home = join(dir, "home.txt");
  writeFileSync(home, "from a home file");
  const big = Buffer.alloc(3 * 1024 * 1024, "compress me ");
  const ups = await uploadMany(remote, [
    { from: { data: Buffer.from("payload") }, to: join(dir, "deep", "x", "it's.bin"), mtime: 1700000000 },
    { from: { path: home }, to: join(dir, "copy.txt"), mtime: 1700000100 },
    { from: { data: big }, to: join(dir, "big.log"), mtime: 1700000200 },
  ], scratch);
  assert.deepEqual(ups, [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal(readFileSync(join(dir, "deep", "x", "it's.bin"), "utf8"), "payload");
  assert.equal(Math.floor(statSync(join(dir, "deep", "x", "it's.bin")).mtimeMs / 1000), 1700000000);
  assert.equal(Math.floor(statSync(join(dir, "copy.txt")).mtimeMs / 1000), 1700000100);
  assert.notEqual(Math.floor(statSync(home).mtimeMs / 1000), 1700000100, "the home file's own date is untouched");
  assert.ok(readFileSync(join(dir, "big.log")).equals(big));
  assert.ok(!existsSync(join(dir, "copy.txt.pss-part")));

  const back = tmp();
  const downs = await downloadMany(remote, [
    { from: join(dir, "deep", "x", "it's.bin"), to: join(back, "a"), size: 7 },
    { from: join(dir, "big.log"), to: join(back, "b"), size: big.length },
    { from: join(dir, "missing"), to: join(back, "c") },
  ], scratch);
  assert.deepEqual(downs.map((d) => d.ok), [true, true, false]);
  assert.equal(readFileSync(join(back, "a"), "utf8"), "payload");
  assert.equal(Math.floor(statSync(join(back, "a")).mtimeMs / 1000), 1700000000);
  assert.ok(readFileSync(join(back, "b")).equals(big));
  scratch.remove();
});

test("listing: full the first time, then only what changed; odd names counted, not listed", async () => {
  const { remote } = await localRemote();
  const dir = tmp();
  const state = join(tmp(), ".pss-list-test");
  mkdirSync(join(dir, "pi-harness-whatsapp", "inbox"), { recursive: true });
  writeFileSync(join(dir, "pi-harness-whatsapp", "inbox", "a b.jpg"), "12345");
  utimesSync(join(dir, "pi-harness-whatsapp", "inbox", "a b.jpg"), 1700000000, 1700000000);
  writeFileSync(join(dir, "pi-harness-whatsapp", "inbox", "keep.txt"), "k");
  writeFileSync(join(dir, "pi-harness-whatsapp", "inbox", "line\nbreak.txt"), "odd");
  const first = await remote.listAgent(dir, state, undefined);
  assert.deepEqual(first.files.get("pi-harness-whatsapp/inbox/a b.jpg"), { size: 5, mtime: 1700000000 });
  assert.equal(first.files.size, 2);
  assert.equal(first.odd, 1);

  writeFileSync(join(dir, "pi-harness-whatsapp", "inbox", "a b.jpg"), "1234567");
  utimesSync(join(dir, "pi-harness-whatsapp", "inbox", "a b.jpg"), 1700000500, 1700000500);
  rmSync(join(dir, "pi-harness-whatsapp", "inbox", "keep.txt"));
  mkdirSync(join(dir, "shots"));
  writeFileSync(join(dir, "shots", "s.png"), "png");
  const next = await remote.listAgent(dir, state, first.files);
  assert.deepEqual(Object.fromEntries(next.files), {
    "pi-harness-whatsapp/inbox/a b.jpg": { size: 7, mtime: 1700000500 },
    "shots/s.png": { size: 3, mtime: next.files.get("shots/s.png")!.mtime },
  });
  assert.equal((await remote.listAgent(join(dir, "missing"), join(tmp(), ".pss-x"), undefined)).files.size, 0);
  const tree = await remote.dirsTree(dir);
  assert.deepEqual(tree.children.get(tree.path), ["pi-harness-whatsapp", "shots"]);
  assert.deepEqual(tree.children.get(`${tree.path}/pi-harness-whatsapp`), ["inbox"], "one level ahead");
});

test("ram scratch: used exactly when this machine has a tmpfs /dev/shm", () => {
  const s = new Scratch(`t${Date.now()}r`, join(tmp(), "scratch"));
  const base = ramBase();
  assert.equal(s.ram !== undefined, base !== undefined);
  if (base) assert.ok(s.dir(10).startsWith(`${base}/`), "small copies go to RAM");
  assert.ok(s.owns(s.dir(10)));
  s.remove();
});

test("ls and find: one listing per folder, globs and ignores", async () => {
  const { remote } = await localRemote();
  const dir = tmp();
  mkdirSync(join(dir, "src", "x"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "");
  writeFileSync(join(dir, "src", "x", "b.spec.ts"), "");
  writeFileSync(join(dir, "README.md"), "");
  const ls = lsOps(() => remote);
  assert.deepEqual((await ls.readdir(dir)).sort(), ["README.md", "src"]);
  assert.equal((await ls.stat(join(dir, "src"))).isDirectory(), true);
  const found = await findOps(() => remote).glob("**/*.spec.ts", dir, { ignore: [], limit: 10 });
  assert.deepEqual(found, ["src/x/b.spec.ts"]);
});

test("grep script: flags and the pattern are passed as words, never pasted", () => {
  const s = grepScript({ pattern: "a'b; rm -rf /", ignoreCase: true, glob: "*.ts" }, "/p", true);
  assert.match(s, /'-e' |-e 'a'\\''b; rm -rf \/'/);
  assert.match(s, /--ignore-case/);
});

test("bash: a command's text is in no process's arguments, so `pkill -f <its own text>` can't kill the runner", async () => {
  const { remote } = await localRemote();
  const ops = remoteBashOps(() => remote);
  let out = "";
  const r = await ops.exec("pkill -f 'pss-selfkill-marker-42'; echo after-pkill", tmp(), { onData: (d) => (out += d.toString()) });
  assert.equal(r.exitCode, 0);
  assert.match(out, /after-pkill/);
});

test("bash: a command containing quotes, heredoc-like lines and $ survives intact", async () => {
  const { remote } = await localRemote();
  let out = "";
  const cmd = `printf '%s\\n' "it's \\$HOME" 'PSS_CMD_x'\ncat <<'EOF2'\nline $x\nEOF2`;
  await remoteBashOps(() => remote).exec(cmd, tmp(), { onData: (d) => (out += d.toString()) });
  assert.equal(out, "it's $HOME\nPSS_CMD_x\nline $x\n");
});

test("bash: output arrives exactly once, also when the command ends while a part of it is being sent", async () => {
  const { conn, remote } = await localRemote();
  // A slow `tail` (the send loop's) makes the command end while the loop is in the middle of sending.
  const bin = tmp();
  const real = execFileSync("sh", ["-c", "command -v tail"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "tail"), `#!/bin/sh\nsleep 0.3\nexec ${real} "$@"\n`);
  chmodSync(join(bin, "tail"), 0o755);
  conn.env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  let out = "";
  await remoteBashOps(() => remote).exec("echo once; sleep 0.15", tmp(), { onData: (d) => (out += d.toString()) });
  assert.equal(out, "once\n");
});
