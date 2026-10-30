import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { cliVersion, findCli, log, spawnCli } from "../dist/index.js";

const root = mkdtempSync(join(tmpdir(), "engine-sdk-cli-"));
after(() => rmSync(root, { recursive: true, force: true }));
const posix = process.platform !== "win32";

function script(dir, name, body) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function logFile(name) {
  return join(root, "logs", name);
}

async function withPath(value, fn) {
  const saved = process.env.PATH;
  process.env.PATH = value;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
}

test("exports the engine SDK surface", () => {
  assert.equal(typeof findCli, "function");
  assert.equal(typeof spawnCli, "function");
  assert.equal(typeof cliVersion, "function");
  for (const level of ["info", "warn", "error"]) assert.equal(typeof log[level], "function");
});

test("findCli returns config.path when it exists", { skip: !posix }, () => {
  const bin = script(join(root, "cfg"), "claude", "exit 0");
  assert.equal(findCli({ path: bin }, "claude"), bin);
});

test("findCli reports a missing config.path", () => {
  const missing = join(root, "nope", "claude");
  assert.throws(() => findCli({ path: missing }, "claude"), { message: `${missing} not found` });
});

test("findCli does not fall back to PATH when config.path is set", { skip: !posix }, async () => {
  const dir = join(root, "pathdir1");
  script(dir, "claude", "exit 0");
  const missing = join(root, "nope", "claude");
  await withPath(dir, () => {
    assert.throws(() => findCli({ path: missing }, "claude"), { message: `${missing} not found` });
  });
});

test("findCli searches PATH when config.path is empty or absent", { skip: !posix }, async () => {
  const dir = join(root, "pathdir2");
  const bin = script(dir, "codex", "exit 0");
  await withPath(["/nonexistent-dir", dir].join(delimiter), () => {
    assert.equal(findCli({}, "codex"), bin);
    assert.equal(findCli({ path: "" }, "codex"), bin);
    assert.equal(findCli({ path: "   " }, "codex"), bin);
    assert.equal(findCli({ path: 7 }, "codex"), bin);
  });
});

test("findCli skips non-executable files on PATH", { skip: !posix }, async () => {
  const dir = join(root, "pathdir3");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pi"), "plain file\n");
  await withPath(dir, () => {
    assert.throws(() => findCli({}, "pi"), { message: "pi not found on PATH" });
  });
});

test("findCli reports a CLI missing from PATH", async () => {
  await withPath(join(root, "empty-dir"), () => {
    assert.throws(() => findCli({}, "claude"), { message: "claude not found on PATH" });
  });
});

test("spawnCli writes stdout and stderr to the log file", { skip: !posix }, async () => {
  const logPath = logFile("basic.log");
  const res = await spawnCli({
    command: "sh",
    args: ["-c", "echo out1; echo out2; echo err1 >&2"],
    cwd: root,
    logPath,
  });
  assert.equal(res.code, 0);
  assert.equal(res.signal, null);
  assert.equal(res.stderrTail, "err1\n");
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  assert.deepEqual([...lines].sort(), ["err1", "out1", "out2"]);
  assert.ok(lines.indexOf("out1") < lines.indexOf("out2"));
});

test("spawnCli creates missing log directories and truncates an existing log", { skip: !posix }, async () => {
  const logPath = join(root, "deep", "er", "trunc.log");
  mkdirSync(join(root, "deep", "er"), { recursive: true });
  writeFileSync(logPath, "old content that must disappear\n");
  await spawnCli({ command: "sh", args: ["-c", "echo fresh"], cwd: root, logPath });
  assert.equal(readFileSync(logPath, "utf8"), "fresh\n");
  const nested = join(root, "a", "b", "c", "new.log");
  await spawnCli({ command: "sh", args: ["-c", "echo nested"], cwd: root, logPath: nested });
  assert.equal(readFileSync(nested, "utf8"), "nested\n");
});

test("spawnCli applies onStdoutLine to every stdout line and drops null results", { skip: !posix }, async () => {
  const logPath = logFile("filter.log");
  const seen = [];
  await spawnCli({
    command: "sh",
    args: ["-c", "echo keep; echo drop; echo shout; printf 'tail-no-newline'"],
    cwd: root,
    logPath,
    onStdoutLine: (line) => {
      seen.push(line);
      if (line === "drop") return null;
      if (line === "shout") return "SHOUT";
      return line;
    },
  });
  assert.deepEqual(seen, ["keep", "drop", "shout", "tail-no-newline"]);
  assert.equal(readFileSync(logPath, "utf8"), "keep\nSHOUT\ntail-no-newline\n");
});

test("spawnCli does not apply onStdoutLine to stderr", { skip: !posix }, async () => {
  const logPath = logFile("stderr-unfiltered.log");
  const seen = [];
  await spawnCli({
    command: "sh",
    args: ["-c", "echo to-err >&2"],
    cwd: root,
    logPath,
    onStdoutLine: (line) => {
      seen.push(line);
      return null;
    },
  });
  assert.deepEqual(seen, []);
  assert.equal(readFileSync(logPath, "utf8"), "to-err\n");
});

test("spawnCli keeps the original line when onStdoutLine throws", { skip: !posix }, async () => {
  const logPath = logFile("throws.log");
  await spawnCli({
    command: "sh",
    args: ["-c", "echo one; echo two"],
    cwd: root,
    logPath,
    onStdoutLine: (line) => {
      if (line === "one") throw new Error("parse failure");
      return line;
    },
  });
  assert.equal(readFileSync(logPath, "utf8"), "one\ntwo\n");
});

test("spawnCli splits stdout lines on newlines only and strips a trailing CR", { skip: !posix }, async () => {
  const seen = [];
  await spawnCli({
    command: "sh",
    args: ["-c", "printf 'a\\rb\\r\\nc\\n'"],
    cwd: root,
    logPath: logFile("cr.log"),
    onStdoutLine: (line) => {
      seen.push(line);
      return line;
    },
  });
  assert.deepEqual(seen, ["a\rb", "c"]);
});

test("spawnCli keeps only the last 4 KB of stderr but logs all of it", async () => {
  const logPath = logFile("tail.log");
  const code = 'process.stderr.write("a".repeat(6000) + "b".repeat(5000) + "END")';
  const res = await spawnCli({ command: process.execPath, args: ["-e", code], cwd: root, logPath });
  assert.equal(res.code, 0);
  assert.equal(Buffer.byteLength(res.stderrTail), 4096);
  assert.ok(res.stderrTail.endsWith("bbbbEND"));
  assert.equal(res.stderrTail, "b".repeat(4093) + "END");
  assert.equal(readFileSync(logPath, "utf8"), "a".repeat(6000) + "b".repeat(5000) + "END\n");
});

test("spawnCli stderr tail does not start in the middle of a multibyte character", async () => {
  const code = 'process.stderr.write("x".repeat(100) + "日".repeat(2000))';
  const res = await spawnCli({ command: process.execPath, args: ["-e", code], cwd: root, logPath: logFile("utf8.log") });
  assert.ok(!res.stderrTail.includes("�"));
  assert.ok(Buffer.byteLength(res.stderrTail) <= 4096);
  assert.ok(Buffer.byteLength(res.stderrTail) > 4090);
});

test("spawnCli reports exit code and signal", { skip: !posix }, async () => {
  const failed = await spawnCli({ command: "sh", args: ["-c", "echo bad >&2; exit 7"], cwd: root, logPath: logFile("exit7.log") });
  assert.equal(failed.code, 7);
  assert.equal(failed.signal, null);
  assert.equal(failed.stderrTail, "bad\n");
  const killed = await spawnCli({ command: "sh", args: ["-c", "kill -9 $$"], cwd: root, logPath: logFile("kill.log") });
  assert.equal(killed.code, null);
  assert.equal(killed.signal, "SIGKILL");
});

test("spawnCli writes input to stdin and closes it", { skip: !posix }, async () => {
  const input = "first line\nsecond \"quoted\" 😀 line\n".repeat(60000);
  const logPath = logFile("stdin.log");
  const res = await spawnCli({ command: "cat", args: [], cwd: root, logPath, input });
  assert.equal(res.code, 0);
  assert.ok(readFileSync(logPath, "utf8") === input);
});

test("spawnCli closes stdin when there is no input", { skip: !posix }, async () => {
  const res = await spawnCli({ command: "cat", args: [], cwd: root, logPath: logFile("noinput.log") });
  assert.equal(res.code, 0);
});

test("spawnCli survives a child that exits without reading its input", { skip: !posix }, async () => {
  const res = await spawnCli({
    command: "sh",
    args: ["-c", "exit 3"],
    cwd: root,
    logPath: logFile("unread.log"),
    input: "x".repeat(4 * 1024 * 1024),
  });
  assert.equal(res.code, 3);
});

test("spawnCli runs in cwd and inherits the environment plus extras", { skip: !posix }, async () => {
  const dir = realpathSync(mkdtempSync(join(root, "cwd-")));
  process.env.ENGINE_SDK_INHERITED = "from-parent";
  try {
    const logPath = logFile("env.log");
    await spawnCli({
      command: "sh",
      args: ["-c", 'pwd; echo "$ENGINE_SDK_INHERITED"; echo "$ENGINE_SDK_EXTRA"'],
      cwd: dir,
      env: { ENGINE_SDK_EXTRA: "from-opts" },
      logPath,
    });
    assert.equal(readFileSync(logPath, "utf8"), `${dir}\nfrom-parent\nfrom-opts\n`);
    const unset = logFile("env-unset.log");
    await spawnCli({
      command: "sh",
      args: ["-c", 'echo "[$ENGINE_SDK_INHERITED]"'],
      cwd: dir,
      env: { ENGINE_SDK_INHERITED: undefined },
      logPath: unset,
    });
    assert.equal(readFileSync(unset, "utf8"), "[]\n");
  } finally {
    delete process.env.ENGINE_SDK_INHERITED;
  }
});

test("spawnCli inherits the environment when env is omitted", { skip: !posix }, async () => {
  process.env.ENGINE_SDK_INHERITED = "plain";
  try {
    const logPath = logFile("env-default.log");
    await spawnCli({ command: "sh", args: ["-c", 'echo "$ENGINE_SDK_INHERITED"'], cwd: root, logPath });
    assert.equal(readFileSync(logPath, "utf8"), "plain\n");
  } finally {
    delete process.env.ENGINE_SDK_INHERITED;
  }
});

test("spawnCli rejects when the command cannot be started", async () => {
  await assert.rejects(
    spawnCli({ command: join(root, "does-not-exist"), args: [], cwd: root, logPath: logFile("enoent.log") }),
    { code: "ENOENT" },
  );
});

test("spawnCli child shares the parent's process group", { skip: !posix }, async () => {
  const seen = [];
  const res = await spawnCli({
    command: "sh",
    args: ["-c", "ps -o pgid= -p $$"],
    cwd: root,
    logPath: logFile("pgid.log"),
    onStdoutLine: (line) => {
      seen.push(line.trim());
      return null;
    },
  });
  assert.equal(res.code, 0);
  const own = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)]).toString().trim();
  assert.match(seen[0], /^\d+$/);
  assert.equal(seen[0], own);
});

test("cliVersion returns the trimmed first line of --version", { skip: !posix }, async () => {
  const bin = script(join(root, "ver"), "claude", 'echo "  1.2.3 (Claude Code)  "; echo "second line"');
  assert.equal(await cliVersion(bin), "1.2.3 (Claude Code)");
});

test("cliVersion passes custom args", { skip: !posix }, async () => {
  const bin = script(join(root, "ver"), "echo-args", 'echo "args:$*"');
  assert.equal(await cliVersion(bin), "args:--version");
  assert.equal(await cliVersion(bin, ["version", "-s"]), "args:version -s");
});

test("cliVersion falls back to stderr when stdout is empty", { skip: !posix }, async () => {
  const bin = script(join(root, "ver"), "stderr-ver", 'echo "0.9.1" >&2');
  assert.equal(await cliVersion(bin), "0.9.1");
});

test("cliVersion rejects when the CLI exits non-zero", { skip: !posix }, async () => {
  const bin = script(join(root, "ver"), "bad-ver", 'echo "unknown flag" >&2; exit 2');
  await assert.rejects(cliVersion(bin), /unknown flag/);
});

test("cliVersion rejects when the CLI is missing", async () => {
  await assert.rejects(cliVersion(join(root, "ver", "missing")), { code: "ENOENT" });
});
