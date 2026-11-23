import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptBuilder, readJsonLines, stripMcpPrefix } from "../dist/index.js";

const root = mkdtempSync(join(tmpdir(), "engine-sdk-transcript-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("text steps are listed in order", () => {
  const b = new TranscriptBuilder();
  b.text("hello");
  b.thinking("hmm");
  b.error("bad");
  assert.deepEqual(b.steps(), [
    { type: "text", text: "hello" },
    { type: "thinking", text: "hmm" },
    { type: "error", text: "bad" },
  ]);
});

test("consecutive text steps merge with a blank line", () => {
  const b = new TranscriptBuilder();
  b.text("one");
  b.text("two");
  b.text("three");
  assert.deepEqual(b.steps(), [{ type: "text", text: "one\n\ntwo\n\nthree" }]);
});

test("text separated by another step does not merge", () => {
  const b = new TranscriptBuilder();
  b.text("one");
  b.thinking("between");
  b.text("two");
  assert.deepEqual(
    b.steps().map((s) => s.type),
    ["text", "thinking", "text"],
  );
});

test("blank text and thinking are ignored", () => {
  const b = new TranscriptBuilder();
  b.text("");
  b.text("  \n\t ");
  b.thinking("");
  b.thinking("   ");
  assert.deepEqual(b.steps(), []);
});

test("a blank text does not break a merge", () => {
  const b = new TranscriptBuilder();
  b.text("one");
  b.text("  ");
  b.text("two");
  assert.deepEqual(b.steps(), [{ type: "text", text: "one\n\ntwo" }]);
});

test("text is clipped to 20000 characters with an ellipsis", () => {
  const b = new TranscriptBuilder();
  b.text("x".repeat(20000));
  b.text("y".repeat(5));
  const [step] = b.steps();
  assert.equal(step.text.length, 20000);
  assert.ok(step.text.endsWith("…"));
  assert.equal(step.text, "x".repeat(19999) + "…");
});

test("text of exactly 20000 characters is kept", () => {
  const b = new TranscriptBuilder();
  b.text("x".repeat(20000));
  assert.equal(b.steps()[0].text, "x".repeat(20000));
});

test("thinking and error text are clipped to 20000 characters", () => {
  const b = new TranscriptBuilder();
  b.thinking("t".repeat(30000));
  b.error("e".repeat(30000));
  const [thinking, error] = b.steps();
  assert.equal(thinking.text.length, 20000);
  assert.equal(error.text.length, 20000);
});

test("a tool step starts running", () => {
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "command", name: "Bash", summary: "ls -la" });
  assert.deepEqual(b.steps(), [{ type: "tool", kind: "command", name: "Bash", summary: "ls -la", status: "running" }]);
});

test("a tool step without a summary has no summary field", () => {
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "other", name: "Thing" });
  b.toolStart("b", { kind: "other", name: "Other", summary: "  \n " });
  const [a, other] = b.steps();
  assert.equal("summary" in a, false);
  assert.equal("summary" in other, false);
});

test("summary collapses to one line and is cut to 300 characters", () => {
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "command", name: "Bash", summary: "  echo   one\n\ttwo\r\n\nthree  " });
  b.toolStart("b", { kind: "command", name: "Bash", summary: "z".repeat(300) });
  b.toolStart("c", { kind: "command", name: "Bash", summary: "z".repeat(301) });
  const [a, exact, cut] = b.steps();
  assert.equal(a.summary, "echo one two three");
  assert.equal(exact.summary, "z".repeat(300));
  assert.equal(cut.summary.length, 300);
  assert.equal(cut.summary, "z".repeat(299) + "…");
});

test("toolEnd marks a tool done and sets its output", () => {
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "read", name: "Read", summary: "a.txt" });
  b.toolEnd("a", { output: "contents\n\n" });
  assert.deepEqual(b.steps(), [{ type: "tool", kind: "read", name: "Read", summary: "a.txt", output: "contents", status: "done" }]);
});

test("toolEnd with isError marks the tool as error", () => {
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "command", name: "Bash", summary: "false" });
  b.toolEnd("a", { output: "boom", isError: true });
  const [step] = b.steps();
  assert.equal(step.status, "error");
  assert.equal(step.output, "boom");
});

test("empty output leaves the output field out", () => {
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "edit", name: "Edit" });
  b.toolStart("b", { kind: "edit", name: "Edit" });
  b.toolEnd("a", {});
  b.toolEnd("b", { output: "  \n\n" });
  const [a, other] = b.steps();
  assert.equal(a.status, "done");
  assert.equal(other.status, "done");
  assert.equal("output" in a, false);
  assert.equal("output" in other, false);
});

test("output longer than 4000 characters keeps the head and the tail", () => {
  const head = "h".repeat(1000);
  const middle = "m".repeat(5000);
  const tail = "t".repeat(2999);
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "command", name: "Bash" });
  b.toolEnd("a", { output: head + middle + tail });
  assert.equal(b.steps()[0].output, head + "\n…\n" + tail);
});

test("output of exactly 4000 characters is kept", () => {
  const output = "o".repeat(4000);
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "command", name: "Bash" });
  b.toolEnd("a", { output });
  assert.equal(b.steps()[0].output, output);
});

test("output of 4001 characters is clipped", () => {
  const output = "a".repeat(1000) + "b" + "c".repeat(3000);
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "command", name: "Bash" });
  b.toolEnd("a", { output });
  assert.equal(b.steps()[0].output, "a".repeat(1000) + "\n…\n" + "c".repeat(2999));
});

test("duration comes from the start and end timestamps", () => {
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "command", name: "Bash" }, 1000);
  b.toolEnd("a", { output: "ok" }, 3500);
  assert.equal(b.steps()[0].duration_ms, 2500);
});

test("duration is left out when a timestamp is missing or invalid", () => {
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "command", name: "Bash" }, 1000);
  b.toolEnd("a", {});
  b.toolStart("b", { kind: "command", name: "Bash" });
  b.toolEnd("b", {}, 2000);
  b.toolStart("c", { kind: "command", name: "Bash" }, Number.NaN);
  b.toolEnd("c", {}, 2000);
  b.toolStart("d", { kind: "command", name: "Bash" }, 5000);
  b.toolEnd("d", {}, 4000);
  for (const step of b.steps()) {
    assert.equal("duration_ms" in step, false);
  }
});

test("a zero duration is kept", () => {
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "command", name: "Bash" }, 1000);
  b.toolEnd("a", {}, 1000);
  assert.equal(b.steps()[0].duration_ms, 0);
});

test("toolEnd for an unknown id is ignored", () => {
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "command", name: "Bash" });
  b.toolEnd("nope", { output: "x", isError: true });
  assert.deepEqual(b.steps(), [{ type: "tool", kind: "command", name: "Bash", status: "running" }]);
});

test("a tool without toolEnd stays running", () => {
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "web", name: "WebFetch", summary: "https://example.com" });
  assert.equal(b.steps()[0].status, "running");
});

test("toolEnd updates the matching tool among several", () => {
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "command", name: "Bash", summary: "one" });
  b.toolStart("b", { kind: "read", name: "Read", summary: "two" });
  b.toolEnd("b", { output: "two out" });
  const [a, other] = b.steps();
  assert.equal(a.status, "running");
  assert.equal(other.status, "done");
  assert.equal(other.output, "two out");
});

test("toolStart with a reused id starts a new step", () => {
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "command", name: "Bash", summary: "first" });
  b.toolStart("a", { kind: "command", name: "Bash", summary: "second" });
  b.toolEnd("a", { output: "done" });
  const [first, second] = b.steps();
  assert.equal(first.status, "running");
  assert.equal(second.status, "done");
  assert.equal(second.output, "done");
});

test("steps returns a snapshot that later calls do not change", () => {
  const b = new TranscriptBuilder();
  b.toolStart("a", { kind: "command", name: "Bash" });
  const before = b.steps();
  b.toolEnd("a", { output: "late" });
  assert.equal(before[0].status, "running");
  assert.equal(b.steps()[0].status, "done");
});

test("steps keep tools and text in arrival order", () => {
  const b = new TranscriptBuilder();
  b.text("start");
  b.toolStart("a", { kind: "search", name: "Grep", summary: "needle" });
  b.text("middle");
  b.toolEnd("a", { output: "hit" });
  b.error("end");
  assert.deepEqual(
    b.steps().map((s) => s.type),
    ["text", "tool", "text", "error"],
  );
});

test("readJsonLines parses one object per line", () => {
  const path = join(root, "plain.log");
  writeFileSync(path, '{"a":1}\n{"b":"two"}\n');
  assert.deepEqual(readJsonLines(path), [{ a: 1 }, { b: "two" }]);
});

test("readJsonLines skips blank, non-JSON and non-object lines", () => {
  const path = join(root, "mixed.log");
  writeFileSync(path, ['{"a":1}', "", "   ", "stderr: warning", "42", '"str"', "null", "[1,2]", "true", '{"b":2}\r', ""].join("\n"));
  assert.deepEqual(readJsonLines(path), [{ a: 1 }, { b: 2 }]);
});

test("readJsonLines skips a truncated last line", () => {
  const path = join(root, "truncated.log");
  writeFileSync(path, '{"a":1}\n{"b":2}\n{"c":"cut o');
  assert.deepEqual(readJsonLines(path), [{ a: 1 }, { b: 2 }]);
});

test("readJsonLines returns an empty list for a missing file", () => {
  assert.deepEqual(readJsonLines(join(root, "missing.log")), []);
});

test("readJsonLines returns an empty list for an empty file", () => {
  const path = join(root, "empty.log");
  writeFileSync(path, "");
  assert.deepEqual(readJsonLines(path), []);
});

test("stripMcpPrefix removes the mcp server prefix", () => {
  assert.equal(stripMcpPrefix("mcp__openbee__send_message"), "send_message");
  assert.equal(stripMcpPrefix("mcp__my_server__do_thing"), "do_thing");
  assert.equal(stripMcpPrefix("mcp__srv__tool__x"), "tool__x");
});

test("stripMcpPrefix leaves other names alone", () => {
  assert.equal(stripMcpPrefix("Bash"), "Bash");
  assert.equal(stripMcpPrefix("send_message"), "send_message");
  assert.equal(stripMcpPrefix("mcp__noserver"), "mcp__noserver");
  assert.equal(stripMcpPrefix("my_mcp__tool"), "my_mcp__tool");
  assert.equal(stripMcpPrefix(""), "");
});
