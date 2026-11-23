import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliVersion, execCli, findCli, resolveCli, spawnCli } from "../dist/index.js";
import { parseCmdShim } from "../dist/cli.js";

const shims = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "shims");
const root = mkdtempSync(join(tmpdir(), "engine-sdk-shim-"));
after(() => rmSync(root, { recursive: true, force: true }));
const windows = process.platform === "win32";
const npmDir = "C:\\Users\\me\\AppData\\Roaming\\npm";

function fixture(name) {
  return readFileSync(join(shims, name), "utf8");
}

test("parseCmdShim reads the script behind an npm node shim", () => {
  assert.deepEqual(parseCmdShim(fixture("npm-node.cmd"), `${npmDir}\\claude.cmd`), {
    target: `${npmDir}\\node_modules\\@scope\\tool\\bin\\cli.js`,
    node: true,
  });
});

test("parseCmdShim reads the legacy npm and pnpm shim", () => {
  assert.deepEqual(parseCmdShim(fixture("legacy-node.cmd"), "C:\\pnpm\\bin\\claude.cmd"), {
    target: "C:\\pnpm\\@scope\\tool\\bin\\cli.js",
    node: true,
  });
});

test("parseCmdShim runs an executable target directly", () => {
  assert.deepEqual(parseCmdShim(fixture("npm-exe.cmd"), `${npmDir}\\opencode.cmd`), {
    target: `${npmDir}\\node_modules\\tool-exe\\bin\\tool.exe`,
    node: false,
  });
});

test("parseCmdShim refuses shims that need another interpreter or are not shims", () => {
  assert.equal(parseCmdShim(fixture("npm-sh.cmd"), `${npmDir}\\tool.cmd`), undefined);
  assert.equal(parseCmdShim("@echo off\r\ncall claude %*\r\n", `${npmDir}\\claude.cmd`), undefined);
  assert.equal(parseCmdShim('"%dp0%\\tool.ps1" %*', `${npmDir}\\tool.cmd`), undefined);
});

test("resolveCli leaves commands alone outside Windows", () => {
  assert.deepEqual(resolveCli("/usr/local/bin/claude.cmd", "darwin"), { command: "/usr/local/bin/claude.cmd", args: [] });
  assert.deepEqual(resolveCli("/opt/cli.js", "linux"), { command: "/opt/cli.js", args: [] });
});

test("resolveCli runs an npm shim's script with the node next to it", () => {
  const dir = join(root, "with-node");
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(shims, "npm-node.cmd"), join(dir, "claude.cmd"));
  writeFileSync(join(dir, "node.exe"), "");
  const cli = resolveCli(join(dir, "claude.cmd"), "win32");
  assert.equal(cli.command, join(dir, "node.exe"));
  assert.equal(cli.args.length, 1);
  assert.match(cli.args[0], /node_modules\\@scope\\tool\\bin\\cli\.js$/);
});

test("resolveCli falls back to node on PATH", () => {
  const dir = join(root, "without-node");
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(shims, "npm-node.cmd"), join(dir, "claude.cmd"));
  const cli = resolveCli(join(dir, "claude.cmd"), "win32");
  assert.equal(cli.command, findCli({}, "node"));
  assert.equal(cli.args.length, 1);
});

test("resolveCli runs JavaScript with node and other files directly on Windows", () => {
  const dir = join(root, "plain");
  mkdirSync(dir, { recursive: true });
  const js = join(dir, "cli.mjs");
  writeFileSync(js, "");
  assert.deepEqual(resolveCli(js, "win32"), { command: findCli({}, "node"), args: [js] });
  assert.deepEqual(resolveCli(join(dir, "claude.exe"), "win32"), { command: join(dir, "claude.exe"), args: [] });
});

test("resolveCli explains batch files it cannot start", () => {
  const dir = join(root, "batch");
  mkdirSync(dir, { recursive: true });
  const bat = join(dir, "claude.bat");
  writeFileSync(bat, "@echo off\r\nclaude-real %*\r\n");
  assert.throws(() => resolveCli(bat, "win32"), {
    message: `${bat} is a batch file that cannot be started safely; set the path setting to the CLI's .exe or .js file`,
  });
  assert.throws(() => resolveCli(join(dir, "missing.cmd"), "win32"), /^Error: read /);
});

test("execCli runs the command and returns its output", { skip: windows }, async () => {
  const bin = join(root, "echo-args");
  writeFileSync(bin, '#!/bin/sh\nprintf "%s|" "$@"\n');
  chmodSync(bin, 0o755);
  const out = await new Promise((resolve, reject) => {
    execCli(bin, ["a b", "c"], {}, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
  assert.equal(out, "a b|c|");
});

function installShimmedCli(dir) {
  const pkg = join(dir, "pkg");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "shim-probe", version: "1.2.3", bin: { "shim-probe": "bin/cli.js" } }),
  );
  writeFileSync(
    join(pkg, "bin", "cli.js"),
    '#!/usr/bin/env node\nif (process.argv[2] === "--version") { console.log("shim-probe 1.2.3"); process.exit(0) }\nlet input = ""\nprocess.stdin.on("data", (d) => (input += d)).on("end", () => console.log(JSON.stringify({ args: process.argv.slice(2), input })))\n',
  );
  const prefix = join(dir, "prefix");
  execFileSync("npm", ["install", "--global", "--prefix", prefix, pkg], { shell: true, stdio: "ignore" });
  return prefix;
}

test("a real npm shim starts on Windows without a shell", { skip: !windows }, async () => {
  const prefix = installShimmedCli(join(root, "real"));
  const saved = process.env.PATH;
  process.env.PATH = `${prefix};${saved}`;
  try {
    const path = findCli({}, "shim-probe");
    assert.match(path, /shim-probe\.cmd$/i);
    assert.equal(await cliVersion(path), "shim-probe 1.2.3");
    const tricky = 'say "hi" & echo pwned | more > out.txt %PATH% ^\nsecond line';
    const logPath = join(root, "real", "run.log");
    const outcome = await spawnCli({ command: path, args: ["--prompt", tricky], cwd: root, input: "stdin text", logPath });
    assert.equal(outcome.code, 0);
    assert.deepEqual(JSON.parse(readFileSync(logPath, "utf8").trim()), { args: ["--prompt", tricky], input: "stdin text" });
  } finally {
    process.env.PATH = saved;
  }
});
