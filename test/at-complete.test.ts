import { test } from "node:test";
import assert from "node:assert/strict";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { atToken, matchEntries, remoteAtProvider } from "../src/ui/at-complete.ts";

test("the @ token before the cursor, plain or quoted; anything else isn't one", () => {
  assert.deepEqual(atToken("look at @src/ma"), { token: "@src/ma", query: "src/ma", quoted: false });
  assert.deepEqual(atToken('see @"docs/release no'), { token: '@"docs/release no', query: "docs/release no", quoted: true });
  assert.deepEqual(atToken("@"), { token: "@", query: "", quoted: false });
  assert.equal(atToken("mail me at a@b.com"), undefined, "an @ inside a word isn't a file mention");
  assert.equal(atToken("plain text"), undefined);
});

test("matching: names containing the query, starting with it first; a / means 'inside this folder'", () => {
  const files = ["src/main.ts", "src/util/strings.ts", "README.md", "docs/release notes.md", "test/main.test.ts"];
  assert.deepEqual(matchEntries(files, "main").map((e) => e.path), ["src/main.ts", "test/main.test.ts"]);
  assert.deepEqual(matchEntries(files, "src/").map((e) => e.path), ["src/util/", "src/main.ts"], "folders first, one level");
  assert.deepEqual(matchEntries(files, "src/u").map((e) => e.path), ["src/util/"]);
  assert.ok(matchEntries(files, "rel").some((e) => e.path === "docs/release notes.md"));
});

test("while connected the suggestions come from the remote project; at home pi's own provider answers", async () => {
  const calls: string[] = [];
  const current: AutocompleteProvider = {
    getSuggestions: async () => {
      calls.push("pi");
      return { items: [{ value: "@home.txt", label: "home.txt" }], prefix: "@h" };
    },
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
  };
  let connected = true;
  const session = {
    get usable() {
      return connected;
    },
    machine: "vm",
    ws: { remoteProject: "/home/me/project" },
    remote: { info: { hasRg: true }, sh: async (script: string) => (calls.push(script.includes("rg --files") ? "remote" : "?"), Buffer.from("src/main.ts\ndocs/release notes.md\n")) },
  };
  const p = remoteAtProvider(current, () => session as never);
  const signal = new AbortController().signal;
  const remote = await p.getSuggestions(["open @mai"], 0, 9, { signal });
  assert.deepEqual(remote, { items: [{ value: "@src/main.ts", label: "main.ts", description: "src/main.ts" }], prefix: "@mai" });
  const spaced = await p.getSuggestions(["@rele"], 0, 5, { signal });
  assert.equal(spaced?.items[0]?.value, '@"docs/release notes.md"', "a path with a space is quoted, as pi does");
  assert.equal(calls.filter((c) => c === "remote").length, 1, "the file list is fetched once, then kept");
  await p.getSuggestions(["/model"], 0, 6, { signal });
  connected = false;
  await p.getSuggestions(["@h"], 0, 2, { signal });
  assert.deepEqual(calls.filter((c) => c === "pi").length, 2, "non-@ input, and anything at home, go to pi's provider");
});
