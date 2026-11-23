import { format } from "node:util";

import type { Engine, EngineRequest, RunParams } from "./types.js";

const PROTOCOL_VERSION = 1;

function writeStderr(line: string): void {
  process.stderr.write(line + "\n");
}

export const log = {
  info(msg: string): void {
    writeStderr(`[info] ${msg}`);
  },
  warn(msg: string): void {
    writeStderr(`[warn] ${msg}`);
  },
  error(msg: string): void {
    writeStderr(`[error] ${msg}`);
  },
};

function redirectConsole(): void {
  const toStderr = (...args: unknown[]) => {
    writeStderr(format(...args));
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

function installCrashHandlers(): void {
  const crash = (err: unknown) => {
    writeStderr(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseRequest(raw: string): EngineRequest<unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid request: ${errorMessage(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid request: expected a JSON object");
  }
  const req = parsed as EngineRequest<unknown>;
  if (req.protocol_version !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version ${String(req.protocol_version)}`);
  }
  return req;
}

async function dispatch(engine: Engine, req: EngineRequest<unknown>): Promise<unknown> {
  switch (req.method) {
    case "check":
      return engine.check(req as EngineRequest<Record<string, never>>);
    case "run":
      return engine.run(req as EngineRequest<RunParams>);
    case "usage":
      return { usage: await engine.usage(req as EngineRequest<{ session_ids: string[] }>) };
    case "models":
      return { models: engine.models ? await engine.models(req as EngineRequest<Record<string, never>>) : [] };
    default:
      throw new Error(`unknown method "${String(req.method)}"`);
  }
}

async function handle(engine: Engine): Promise<string> {
  try {
    const req = parseRequest(await readStdin());
    const result = await dispatch(engine, req);
    return JSON.stringify({ result: result ?? {} });
  } catch (err) {
    return JSON.stringify({ error: { message: errorMessage(err) } });
  }
}

export async function runEngine(engine: Engine): Promise<void> {
  redirectConsole();
  installCrashHandlers();
  const line = await handle(engine);
  await new Promise<void>((resolve) => {
    process.stdout.write(line + "\n", () => resolve());
  });
  process.exit(0);
}
