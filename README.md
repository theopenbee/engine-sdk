# @theopenbee/engine-sdk

Node.js SDK for building openbee engine plugins. An engine plugin wraps one agent CLI (Claude Code, Codex, pi, ...) so openbee can run it. The SDK implements the one-shot JSON protocol between openbee and the plugin and ships the helpers every wrapper needs: locating the CLI, spawning it with a log file, and reading its version.

Requires Node.js 20 or newer. Plugins also run on Bun.

```sh
npm install @theopenbee/engine-sdk
```

## How openbee calls a plugin

For every engine call openbee starts the plugin command (for example `node dist/index.js`) as a new process group, writes **one JSON request line** to its stdin and closes stdin, then reads **one JSON response line** from its stdout. The plugin starts the agent CLI as a child process, waits for it and answers. One process serves one call.

Request (protocol version `1`):

```json
{
  "protocol_version": 1,
  "method": "run",
  "openbee_version": "0.9.0",
  "engine_id": "claude",
  "language": "en",
  "config": { "path": "/usr/local/bin/claude" },
  "data_dir": "~/.openbee/plugins/data/claude/",
  "state_dir": "~/.openbee/.claude/",
  "params": {}
}
```

| Field | Description |
|---|---|
| `method` | `check`, `run`, `usage`, `models` or `transcript` |
| `config` | The plugin's configuration as set by the user (for example `path`) |
| `data_dir` | Private directory for the plugin, deleted when the plugin is uninstalled |
| `state_dir` | Directory for state that must survive an uninstall; openbee never deletes it |
| `params` | Method specific, see below |

Response, exactly one line:

```json
{"result": {}}
{"error": {"message": "what went wrong"}}
```

`runEngine` produces the response and exits with code 0, including for errors. An unknown method, an unsupported `protocol_version` or an exception thrown by the engine becomes an `{"error": ...}` response.

| Method | `params` | `result` |
|---|---|---|
| `check` | `{}` | `{ version, path }` |
| `run` | `{ role, work_dir, prompt, session_id, resume, extra_args, log_path, model?, mcp? }` | `{ text, error? }` |
| `usage` | `{ session_ids }` | `{ usage: { <session_id>: TokenUsage[] } }` |
| `models` | `{}` | `{ models: ModelInfo[] }` |
| `transcript` | `{ log_path }` | `{ steps: TranscriptStep[] }` |

`model` is the worker's model for this engine; openbee leaves it out when none is set, and the engine then uses its own default. `mcp` is `{ name, url, api_key_env }`: the MCP server the CLI should use and the name of the environment variable that holds its API key. `models` lists the models openbee suggests for a worker; `id` is what openbee later sends as `model`. openbee runs it with the Env settings but without `OPENBEE_API_KEY`, so provider keys set there are visible. `check`, `models` and `transcript` must finish within 30 seconds and `usage` within 60 seconds; `run` is only bounded by openbee stopping the task.

## The Engine interface

```ts
interface Engine {
  check(req: EngineRequest<Record<string, never>>): Promise<CheckResult>;
  run(req: EngineRequest<RunParams>): Promise<RunResult>;
  usage(req: EngineRequest<{ session_ids: string[] }>): Promise<Record<string, TokenUsage[]>>;
  models?(req: EngineRequest<Record<string, never>>): Promise<ModelInfo[]>;
  transcript?(req: EngineRequest<TranscriptParams>): Promise<TranscriptStep[]>;
}

interface CheckResult { version: string; path: string }
interface RunResult { text: string; error?: string }
interface TokenUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}
interface ModelInfo { id: string; name?: string }
interface TranscriptParams { log_path: string }
type ToolKind = "command" | "read" | "edit" | "search" | "web" | "message" | "other";
type TranscriptStep =
  | { type: "text" | "thinking" | "error"; text: string }
  | {
      type: "tool";
      kind: ToolKind;
      name: string;
      summary?: string;
      output?: string;
      status: "running" | "done" | "error";
      duration_ms?: number;
    };
```

`runEngine(engine)` reads the request, dispatches on `method` and writes the response. `usage` returns a map from session id to its token usage; `runEngine` wraps it as `{ "usage": ... }` for you. `models` is optional and returns the model list, wrapped as `{ "models": ... }`; an engine without it answers `{ "models": [] }`.

## Transcript

`transcript` is optional. openbee calls it to show what a finished or running task did: the engine reads the log file `run` wrote to `log_path` and returns the steps in order, oldest first. `runEngine` wraps the result as `{ "steps": ... }`; an engine without `transcript` answers `unknown method "transcript"`, which openbee treats as "no transcript available".

| Step | Fields |
|---|---|
| `text` | `text`: assistant reply text; consecutive text merges with a blank line |
| `thinking` | `text`: non-empty reasoning only |
| `tool` | `kind` (`command`, `read`, `edit`, `search`, `web`, `message` or `other`), `name` (tool name without the `mcp__<server>__` prefix), `summary` (one line, at most 300 characters), `output` (at most 4000 characters: the first 1000, `\n…\n`, then the last 2999 when longer), `status` (`running`, `done` or `error`), `duration_ms` (only when both timestamps are known) |
| `error` | `text` |

`text` is at most 20000 characters. Skip lines that are not JSON (the log also holds stderr), skip a truncated last line, and skip events of nested sub-agents. `message` is the openbee `send_message` tool; its `summary` is the message content. A tool that has no result yet stays `running`.

`TranscriptBuilder` applies all of these limits, so an engine only translates its own log format:

```js
import { TranscriptBuilder, readJsonLines, stripMcpPrefix } from "@theopenbee/engine-sdk";

async transcript(req) {
  const builder = new TranscriptBuilder();
  for (const event of readJsonLines(req.params.log_path)) {
    if (event.type === "assistant_text") builder.text(event.text);
    if (event.type === "tool_call") {
      builder.toolStart(event.id, { kind: "command", name: stripMcpPrefix(event.name), summary: event.input }, event.at);
    }
    if (event.type === "tool_result") builder.toolEnd(event.id, { output: event.output, isError: event.failed }, event.at);
  }
  return builder.steps();
}
```

## Minimal plugin

```js
import { runEngine, findCli, spawnCli, cliVersion } from "@theopenbee/engine-sdk";

runEngine({
  async check(req) {
    const path = findCli(req.config, "mycli");
    return { version: await cliVersion(path), path };
  },

  async run(req) {
    const { work_dir, prompt, extra_args, log_path, model } = req.params;
    const command = findCli(req.config, "mycli");
    let text = "";
    const res = await spawnCli({
      command,
      args: ["--print", ...(model ? ["--model", model] : []), ...extra_args],
      cwd: work_dir,
      input: prompt,
      logPath: log_path,
      onStdoutLine(line) {
        text += line + "\n";
        return line;
      },
    });
    if (res.code !== 0) {
      return { text: text.trim(), error: res.stderrTail || `mycli exited with code ${res.code}` };
    }
    return { text: text.trim() };
  },

  async usage() {
    return {};
  },
});
```

## Helpers

| Helper | Description |
|---|---|
| `findCli(config, name)` | Returns `config.path` when it is set and exists, otherwise searches `PATH` (honouring `PATHEXT` on Windows). Throws `<path> not found` or `<name> not found on PATH`. |
| `spawnCli(opts)` | Spawns the CLI in the plugin's process group, writes `input` to stdin and closes it, and appends stdout lines and stderr to `logPath` (created or truncated). `onStdoutLine` sees every stdout line before it is logged: return the text to log or `null` to drop it. Resolves with `{ code, signal, stderrTail }` where `stderrTail` is the last 4 KB of stderr. `opts.env` is merged over the plugin's environment; a key set to `undefined` is removed. |
| `cliVersion(path, args?)` | Runs `<path> --version` (or `args`) with a 10 second timeout and returns the trimmed first line. |
| `execCli(path, args, options, callback)` | `execFile` for a CLI found with `findCli`: same options and callback, with stdout and stderr as strings. Use it for every other CLI call, such as listing models or reading usage. |
| `resolveCli(path)` | The command and leading arguments that start `path`. `spawnCli`, `cliVersion` and `execCli` use it, so plugins rarely need it. |
| `TranscriptBuilder` | Collects transcript steps. `text`, `thinking` and `error` add steps (blank `text` and `thinking` are ignored and consecutive `text` merges); `toolStart(id, { kind, name, summary? }, at?)` adds a running tool; `toolEnd(id, { output?, isError? }, at?)` finishes it (an unknown `id` is ignored) and sets `duration_ms` from the two `at` timestamps in milliseconds; `steps()` returns the steps with every limit applied. |
| `readJsonLines(path)` | Reads a log file and returns its JSON objects. Blank lines, lines that are not JSON, lines that are not objects and a truncated last line are skipped; a missing file gives `[]`. |
| `stripMcpPrefix(name)` | Removes the `mcp__<server>__` prefix: `mcp__openbee__send_message` becomes `send_message`. |
| `log.info/warn/error(msg)` | Writes a line to stderr. |

## Process rules

- **stdout carries only the response.** The SDK redirects `console.log`, `console.info` and `console.debug` to stderr as soon as `runEngine` starts, but never write to `process.stdout` yourself and do not let the CLI inherit your stdout.
- **Logs go to stderr.** Use `log.info/warn/error` or `console.error`; openbee collects the plugin's stderr.
- **Never spawn the CLI detached.** openbee starts the plugin as its own process group and kills the whole group when a task is stopped or times out. A detached child, a `setsid` wrapper or a daemonised helper escapes that and is left running. `spawnCli` never detaches.
- **Exit once you have answered.** `runEngine` exits with code 0 right after writing the response; a plugin that exits without a response, or non-zero, counts as failed.
- **Stay portable.** Use `node:` built-ins only so the plugin runs on Node 20+ and on Bun.
- **Start CLIs through the SDK on Windows.** npm installs CLIs on Windows as `.cmd` scripts, which Node cannot start without a shell, and a shell would interpret the prompt. `spawnCli`, `cliVersion` and `execCli` run such a script's JavaScript file with `node` instead, and a `.js` path the same way. A `.cmd` or `.bat` that is not an npm script fails with a message to set `path` to the CLI's `.exe` or `.js` file. Never call `execFile` or `spawn` on a path from `findCli` yourself, and never pass `shell: true`.

## Development

```sh
npm install
npm test
```

`npm install` also builds `dist/`; run `npm run build` after changing `src/`. The tests run the engine fixture in child `node` processes, and under Bun when it is installed (`bun` on `PATH` or `~/.openbee/runtime/bun-*/bun`).

## License

MIT
