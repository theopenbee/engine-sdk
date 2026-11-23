import { execFile, spawn } from "node:child_process";
import type { ChildProcess, ExecFileException, ExecFileOptions } from "node:child_process";
import { accessSync, constants, createWriteStream, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, delimiter, dirname, extname, join, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { log } from "./main.js";

const STDERR_TAIL_BYTES = 4096;
const VERSION_TIMEOUT_MS = 10_000;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  if (!isFile(path)) return false;
  if (process.platform === "win32") return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const own = extname(name).toLowerCase();
  if (own && exts.some((ext) => ext.toLowerCase() === own)) return [name];
  return exts.map((ext) => name + ext);
}

export function findCli(config: Record<string, unknown>, name: string): string {
  const configured = typeof config.path === "string" ? config.path.trim() : "";
  if (configured) {
    if (!isFile(configured)) throw new Error(`${configured} not found`);
    return configured;
  }
  const dirs = (process.env.PATH ?? process.env.Path ?? "")
    .split(delimiter)
    .map((dir) => dir.replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  const names = candidateNames(name);
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = join(dir, candidate);
      if (isExecutable(full)) return full;
    }
  }
  throw new Error(`${name} not found on PATH`);
}

export interface CliCommand {
  command: string;
  args: string[];
}

const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const SHIM_TARGET = /"%~?dp0%?\\?([^"]*)"\s+%\*/g;
const SHIM_FALLBACK_PROGRAM = /SET "_prog=([^"%]*)"/i;
const SHIM_NODE_PROGRAM = /(?:^|[\s&"(])node(?:\.exe)?"?\s+"%~?dp0%?/im;

function cmdShimTarget(content: string): string | undefined {
  let target: string | undefined;
  for (const match of content.matchAll(SHIM_TARGET)) target = match[1];
  return target;
}

export function parseCmdShim(content: string, shimPath: string): { target: string; node: boolean } | undefined {
  const relative = cmdShimTarget(content);
  if (!relative) return undefined;
  const target = win32.join(win32.dirname(shimPath), relative);
  const fallback = SHIM_FALLBACK_PROGRAM.exec(content)?.[1];
  if (fallback !== undefined) {
    return fallback.toLowerCase() === "node" ? { target, node: true } : undefined;
  }
  if (SHIM_NODE_PROGRAM.test(content)) return { target, node: true };
  const ext = win32.extname(target).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(ext)) return { target, node: true };
  if (ext === ".exe" || ext === ".com") return { target, node: false };
  return undefined;
}

function nodeFor(shimDir: string): string {
  const local = join(shimDir, "node.exe");
  if (isFile(local)) return local;
  try {
    return findCli({}, "node");
  } catch {
    if (/^node(\.exe)?$/i.test(basename(process.execPath))) return process.execPath;
    throw new Error("node not found on PATH");
  }
}

export function resolveCli(path: string, platform: NodeJS.Platform = process.platform): CliCommand {
  if (platform !== "win32") return { command: path, args: [] };
  const ext = extname(path).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(ext)) return { command: nodeFor(dirname(path)), args: [path] };
  if (ext !== ".cmd" && ext !== ".bat") return { command: path, args: [] };
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const shim = parseCmdShim(content, path);
  if (!shim) {
    throw new Error(`${path} is a batch file that cannot be started safely; set the path setting to the CLI's .exe or .js file`);
  }
  return shim.node ? { command: nodeFor(dirname(path)), args: [shim.target] } : { command: shim.target, args: [] };
}

export function execCli(
  path: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
): ChildProcess | undefined {
  let cli: CliCommand;
  try {
    cli = resolveCli(path);
  } catch (err) {
    callback(err as ExecFileException, "", "");
    return undefined;
  }
  return execFile(cli.command, [...cli.args, ...args], { ...options, encoding: "utf8" }, (error, stdout, stderr) =>
    callback(error, String(stdout), String(stderr)),
  );
}

function lineSplitter(onLine: (line: string) => void) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const emit = (line: string) => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  return {
    push(chunk: Buffer): void {
      pending += decoder.write(chunk);
      let start = 0;
      for (let idx = pending.indexOf("\n", start); idx >= 0; idx = pending.indexOf("\n", start)) {
        emit(pending.slice(start, idx));
        start = idx + 1;
      }
      pending = pending.slice(start);
    },
    end(): void {
      pending += decoder.end();
      if (pending) emit(pending);
      pending = "";
    },
  };
}

function decodeTail(tail: Buffer): string {
  let start = 0;
  while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
  return tail.subarray(start).toString("utf8");
}

export function spawnCli(opts: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  logPath: string;
  onStdoutLine?: (line: string) => string | null;
}): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(opts.logPath), { recursive: true });
    const logStream = createWriteStream(opts.logPath, { flags: "w" });
    logStream.on("error", (err) => log.warn(`writing ${opts.logPath} failed: ${err.message}`));
    const logClosed = new Promise<void>((done) => logStream.once("close", () => done()));

    let cli: CliCommand;
    try {
      cli = resolveCli(opts.command);
    } catch (err) {
      logStream.end();
      void logClosed.then(() => reject(err));
      return;
    }
    const child = spawn(cli.command, [...cli.args, ...opts.args], {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
      windowsHide: true,
    });

    let settled = false;

    const stdoutLines = lineSplitter((line) => {
      let out: string | null = line;
      if (opts.onStdoutLine) {
        try {
          out = opts.onStdoutLine(line);
        } catch (err) {
          log.warn(`onStdoutLine failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (out !== null) logStream.write(out + "\n");
    });
    const stderrLines = lineSplitter((line) => {
      logStream.write(line + "\n");
    });

    let tail: Buffer = Buffer.alloc(0);

    child.stdout.on("data", (chunk: Buffer) => stdoutLines.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderrLines.push(chunk);
      const joined = Buffer.concat([tail, chunk]);
      tail = Buffer.from(joined.subarray(Math.max(0, joined.length - STDERR_TAIL_BYTES)));
    });
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      logStream.end();
      void logClosed.then(() => reject(err));
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      stdoutLines.end();
      stderrLines.end();
      logStream.end();
      void logClosed.then(() => resolve({ code, signal, stderrTail: decodeTail(tail) }));
    });

    child.stdin.end(opts.input);
  });
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.trim() ?? "";
}

export async function cliVersion(path: string, args: string[] = ["--version"]): Promise<string> {
  const command = [path, ...args].join(" ");
  return new Promise((resolve, reject) => {
    execCli(
      path,
      args,
      { timeout: VERSION_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as { killed?: boolean }).killed) {
            reject(new Error(`${command} timed out after ${VERSION_TIMEOUT_MS / 1000}s`));
            return;
          }
          const detail = firstLine(String(stderr));
          if (detail && typeof (err as { code?: unknown }).code === "number") {
            reject(new Error(`${command} failed: ${detail}`));
            return;
          }
          reject(err);
          return;
        }
        resolve(firstLine(String(stdout)) || firstLine(String(stderr)));
      },
    );
  });
}
