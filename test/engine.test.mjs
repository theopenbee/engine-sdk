import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "engine.mjs");
const scratch = mkdtempSync(join(tmpdir(), "engine-sdk-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function findBun() {
  const probe = spawnSync("bun", ["--version"]);
  if (probe.status === 0) return "bun";
  const runtime = join(homedir(), ".openbee", "runtime");
  if (!existsSync(runtime)) return null;
  for (const entry of readdirSync(runtime)) {
    const candidate = join(runtime, entry, "bun");
    if (entry.startsWith("bun-") && existsSync(candidate)) return candidate;
  }
  return null;
}

const bun = findBun();
const runtimes = [
  { name: "node", command: process.execPath, skip: false },
  { name: "bun", command: bun, skip: bun ? false : "bun is not installed" },
];

function baseRequest(method, params) {
  return {
    protocol_version: 1,
    method,
    openbee_version: "9.9.9",
    engine_id: "fake",
    language: "en",
    config: { path: "/opt/fake" },
    data_dir: join(scratch, "data"),
    state_dir: join(scratch, "state"),
    params,
  };
}

function runPlugin(runtime, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.command, [fixture], { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input) + "\n");
  });
}

function singleResponse(res) {
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.split("\n").filter((l) => l !== "");
  assert.equal(lines.length, 1, `expected exactly one stdout line, got: ${res.stdout}`);
  assert.ok(res.stdout.endsWith("\n"));
  return JSON.parse(lines[0]);
}

for (const runtime of runtimes) {
  const t = (name, optsOrFn, maybeFn) => {
    const opts = typeof optsOrFn === "function" ? {} : optsOrFn;
    const fn = typeof optsOrFn === "function" ? optsOrFn : maybeFn;
    test(`[${runtime.name}] ${name}`, { skip: runtime.skip || opts.skip || false }, fn);
  };

  t("check round trip", async () => {
    const res = singleResponse(await runPlugin(runtime, baseRequest("check", {})));
    assert.deepEqual(res, { result: { version: "1.2.3", path: "/usr/local/bin/fake" } });
  });

  t("run round trip passes request fields through", async () => {
    const params = {
      role: "worker",
      work_dir: "/tmp/work",
      prompt: "context",
      session_id: "s1",
      resume: true,
      extra_args: ["--a", "b"],
      log_path: join(scratch, "run.log"),
      mcp: { name: "openbee", url: "http://127.0.0.1:1/mcp", api_key_env: "OPENBEE_TOKEN" },
    };
    const res = singleResponse(await runPlugin(runtime, baseRequest("run", params)));
    const echoed = JSON.parse(res.result.text);
    assert.deepEqual(echoed, {
      protocol_version: 1,
      method: "run",
      openbee_version: "9.9.9",
      engine_id: "fake",
      language: "en",
      config: { path: "/opt/fake" },
      data_dir: join(scratch, "data"),
      state_dir: join(scratch, "state"),
      role: "worker",
      work_dir: "/tmp/work",
      resume: true,
      extra_args: ["--a", "b"],
      mcp: params.mcp,
    });
  });

  t("run result carries the error field", async () => {
    const res = singleResponse(await runPlugin(runtime, baseRequest("run", { prompt: "with-error" })));
    assert.deepEqual(res, { result: { text: "with-error", error: "cli failed" } });
  });

  t("usage wraps the map in a usage key", async () => {
    const res = singleResponse(await runPlugin(runtime, baseRequest("usage", { session_ids: ["a", "b"] })));
    assert.deepEqual(res, {
      result: {
        usage: {
          a: [{ model: "m-a", input_tokens: 1, output_tokens: 2, cache_creation_tokens: 3, cache_read_tokens: 4 }],
          b: [{ model: "m-b", input_tokens: 1, output_tokens: 2, cache_creation_tokens: 3, cache_read_tokens: 4 }],
        },
      },
    });
  });

  t("large unicode prompt survives byte for byte", async () => {
    const unit = 'line "quoted" \\ back\tslash 😀 日本語   \n\r\n';
    const prompt = unit.repeat(Math.ceil((3 * 1024 * 1024) / Buffer.byteLength(unit)));
    const res = singleResponse(await runPlugin(runtime, baseRequest("run", { prompt })));
    assert.equal(res.result.text.length, prompt.length);
    assert.ok(res.result.text === prompt);
  });

  t("unknown method returns an error response", async () => {
    const res = await runPlugin(runtime, baseRequest("restart", {}));
    assert.deepEqual(singleResponse(res), { error: { message: 'unknown method "restart"' } });
  });

  t("wrong protocol version returns an error response", async () => {
    const res = await runPlugin(runtime, { ...baseRequest("check", {}), protocol_version: 2 });
    assert.deepEqual(singleResponse(res), { error: { message: "unsupported protocol version 2" } });
  });

  t("missing protocol version returns an error response", async () => {
    const { protocol_version, ...rest } = baseRequest("check", {});
    const res = await runPlugin(runtime, rest);
    assert.match(singleResponse(res).error.message, /unsupported protocol version/);
  });

  t("invalid JSON returns an error response", async () => {
    const res = await runPlugin(runtime, "{not json\n");
    assert.match(singleResponse(res).error.message, /^invalid request/);
  });

  t("empty stdin returns an error response", async () => {
    const res = await runPlugin(runtime, "");
    assert.match(singleResponse(res).error.message, /^invalid request/);
  });

  t("engine exception becomes an error response", async () => {
    const res = await runPlugin(runtime, baseRequest("run", { prompt: "boom" }));
    assert.deepEqual(singleResponse(res), { error: { message: "engine exploded" } });
  });

  t("console output lands on stderr and never on stdout", async () => {
    const res = await runPlugin(runtime, baseRequest("run", { prompt: "stray" }));
    assert.deepEqual(singleResponse(res), { result: { text: "ok" } });
    assert.match(res.stderr, /stray log line/);
    assert.match(res.stderr, /stray info line/);
    assert.match(res.stderr, /stray debug line/);
    assert.match(res.stderr, /sdk info line/);
  });

  t("spawnCli child shares the plugin process group", { skip: process.platform === "win32" }, async () => {
    const res = singleResponse(await runPlugin(runtime, baseRequest("run", { prompt: "pgid", log_path: join(scratch, "pgid.log") })));
    const seen = JSON.parse(res.result.text);
    assert.equal(seen.code, 0);
    assert.match(seen.child, /^\d+$/);
    assert.equal(seen.child, seen.own);
  });
}
