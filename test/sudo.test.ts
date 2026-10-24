// sudo on the remote: asked through the password helper, with a stand-in sudo that behaves like the real one with -A
// (asks the helper up to 3 times, runs the command when the password is "right").
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteBashOps, type SudoAsk, type SudoRequest } from "../src/routed/bash.ts";
import { SudoPasswords } from "../src/sudo.ts";
import { localRemote } from "./local-remote.ts";

const root = mkdtempSync(join(tmpdir(), "pss-sudo-"));
after(() => rmSync(root, { recursive: true, force: true }));
const fakeBin = join(root, "bin");
const runs = join(root, "tmp");
mkdirSync(fakeBin);
mkdirSync(runs);
writeFileSync(
  join(fakeBin, "sudo"),
  [
    "#!/bin/sh",
    '[ "$1" = -A ] || { echo "fake sudo: run without -A" >&2; exit 9; }',
    "shift",
    '[ -x "$SUDO_ASKPASS" ] || { echo "fake sudo: no askpass" >&2; exit 9; }',
    "for i in 1 2 3; do",
    '  pw=$("$SUDO_ASKPASS" "[sudo] password for tester: ") || exit 1',
    '  [ "$pw" = right ] && exec "$@"',
    '  echo "Sorry, try again." >&2',
    "done",
    'echo "sudo: 3 incorrect password attempts" >&2; exit 1',
  ].join("\n"),
);
chmodSync(join(fakeBin, "sudo"), 0o755);

async function machine() {
  const { conn, remote } = await localRemote();
  conn.env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, TMPDIR: runs };
  return remote;
}

async function run(command: string, sudo: SudoAsk | undefined, signal?: AbortSignal) {
  const remote = await machine();
  let out = "";
  const result = await remoteBashOps(() => remote, sudo).exec(command, root, { onData: (d) => (out += d.toString()), ...(signal ? { signal } : {}) });
  return { out, code: result.exitCode };
}

const answers = (...list: (string | undefined)[]) => {
  const seen: SudoRequest[] = [];
  const ask: SudoAsk = async (r) => {
    seen.push(r);
    return list.shift();
  };
  return { seen, ask };
};

test("sudo asks this computer: the prompt and the command come with it, the right password runs the command", async () => {
  const { seen, ask } = answers("right");
  const { out, code } = await run("sudo echo ran-as-root", ask);
  assert.equal(code, 0);
  assert.match(out, /ran-as-root/);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.prompt, /\[sudo\] password for tester:/);
  assert.equal(seen[0]!.command, "sudo echo ran-as-root");
  assert.equal(seen[0]!.retry, false);
  assert.deepEqual(readdirSync(runs), [], "the call's folder (helper, pipes) is gone");
});

test("a wrong password: the same sudo asks again, marked as a retry", async () => {
  const { seen, ask } = answers("wrong", "right");
  const { out, code } = await run("sudo echo second-try", ask);
  assert.equal(code, 0);
  assert.match(out, /Sorry, try again\.[\s\S]*second-try/);
  assert.deepEqual(seen.map((r) => r.retry), [false, true]);
});

test("two sudo commands in one call: each asks, neither is a retry", async () => {
  const { seen, ask } = answers("right", "right");
  const { out } = await run("sudo echo one; sudo echo two", ask);
  assert.match(out, /one[\s\S]*two/);
  assert.deepEqual(seen.map((r) => r.retry), [false, false]);
});

test("refused (Esc, or no terminal UI): the command is told so and fails, nothing runs", async () => {
  for (const sudo of [answers(undefined).ask, undefined]) {
    const { out, code } = await run("sudo echo should-not-run", sudo);
    assert.notEqual(code, 0);
    assert.match(out, /the password was not given \(declined on the computer running pi\)/);
    assert.doesNotMatch(out, /should-not-run/);
  }
  assert.deepEqual(readdirSync(runs), []);
});

test("the call ends while the box is open (Esc on the call): the question is withdrawn", async () => {
  const stop = new AbortController();
  let withdrawn = false;
  const ask: SudoAsk = (r) =>
    new Promise((resolve) => {
      r.signal.addEventListener("abort", () => {
        withdrawn = true;
        resolve(undefined);
      });
      stop.abort();
    });
  await assert.rejects(run("sudo echo never", ask, stop.signal), /aborted/);
  assert.ok(withdrawn);
  for (let i = 0; i < 50 && readdirSync(runs).length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(readdirSync(runs), []);
});

test("remembering: off asks every time; on asks once per connection; a wrong kept password is dropped", async () => {
  let remember = false;
  const memory = new SudoPasswords(() => remember);
  const request = (retry = false): SudoRequest => ({ prompt: "p", command: "c", retry, signal: new AbortController().signal });
  let asked = 0;
  const ask = async () => `pw${++asked}`;
  const a = {};
  assert.equal(await memory.answer(request(), a, ask), "pw1");
  assert.equal(await memory.answer(request(), a, ask), "pw2", "off: asked again");
  remember = true;
  assert.equal(await memory.answer(request(), a, ask), "pw3");
  assert.equal(await memory.answer(request(), a, ask), "pw3", "on: kept");
  assert.equal(await memory.answer(request(true), a, ask), "pw4", "sudo asked again: the kept one was wrong");
  assert.equal(await memory.answer(request(), {}, ask), "pw5", "another connection asks");
  memory.forget();
  assert.equal(await memory.answer(request(), a, ask), "pw6", "forgotten when the setting goes off");
  assert.equal(await memory.answer(request(), a, async () => undefined), "pw6");
});
