import { readFileSync } from "node:fs";

import type { ToolKind, TranscriptStep } from "./types.js";

const MAX_TEXT = 20000;
const MAX_SUMMARY = 300;
const MAX_OUTPUT = 4000;
const OUTPUT_HEAD = 1000;
const OUTPUT_TAIL = 2997;
const OUTPUT_GAP = "\n…\n";

type ToolStep = Extract<TranscriptStep, { type: "tool" }>;

interface RunningTool {
  step: ToolStep;
  at?: number;
}

function clipText(text: string): string {
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + "…" : text;
}

function clipSummary(summary: string): string {
  const line = summary.replace(/\s+/g, " ").trim();
  return line.length > MAX_SUMMARY ? line.slice(0, MAX_SUMMARY - 1) + "…" : line;
}

function clipOutput(output: string): string {
  const trimmed = output.trimEnd();
  if (trimmed.length <= MAX_OUTPUT) {
    return trimmed;
  }
  return trimmed.slice(0, OUTPUT_HEAD) + OUTPUT_GAP + trimmed.slice(trimmed.length - OUTPUT_TAIL);
}

function truncateLine(line: string, max: number): string {
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function takeLines(lines: string[], budget: number): string[] {
  const taken: string[] = [];
  let length = 0;
  for (const line of lines) {
    const next = length + line.length + (taken.length > 0 ? 1 : 0);
    if (next > budget) {
      break;
    }
    taken.push(line);
    length = next;
  }
  return taken;
}

function clipDiff(diff: string): string {
  const trimmed = diff.trimEnd();
  if (trimmed.length <= MAX_OUTPUT) {
    return trimmed;
  }
  const lines = trimmed.split("\n");
  if (lines.length === 1) {
    return truncateLine(trimmed, MAX_OUTPUT);
  }
  let head = takeLines(lines, OUTPUT_HEAD);
  const consumed = head.length === 0 ? 1 : head.length;
  if (head.length === 0) {
    head = [truncateLine(lines[0], OUTPUT_HEAD)];
  }
  const rest = lines.slice(consumed);
  let tail = takeLines([...rest].reverse(), OUTPUT_TAIL).reverse();
  if (tail.length === 0) {
    tail = [truncateLine(rest[rest.length - 1], OUTPUT_TAIL)];
  }
  const omitted = rest.length - tail.length;
  return head.join("\n") + (omitted > 0 ? OUTPUT_GAP : "\n") + tail.join("\n");
}

function isBlank(text: string): boolean {
  return text.trim() === "";
}

export class TranscriptBuilder {
  private readonly list: TranscriptStep[] = [];
  private readonly tools = new Map<string, RunningTool>();

  text(t: string): void {
    if (isBlank(t)) {
      return;
    }
    const last = this.list[this.list.length - 1];
    if (last && last.type === "text") {
      last.text = clipText(last.text + "\n\n" + t);
      return;
    }
    this.list.push({ type: "text", text: clipText(t) });
  }

  thinking(t: string): void {
    if (isBlank(t)) {
      return;
    }
    this.list.push({ type: "thinking", text: clipText(t) });
  }

  error(t: string): void {
    this.list.push({ type: "error", text: clipText(t) });
  }

  toolStart(id: string, tool: { kind: ToolKind; name: string; summary?: string; diff?: string }, at?: number): void {
    const step: ToolStep = { type: "tool", kind: tool.kind, name: tool.name, status: "running" };
    const summary = tool.summary === undefined ? "" : clipSummary(tool.summary);
    if (summary !== "") {
      step.summary = summary;
    }
    const diff = tool.diff === undefined ? "" : clipDiff(tool.diff);
    if (diff.trim() !== "") {
      step.diff = diff;
    }
    this.list.push(step);
    this.tools.set(id, { step, at });
  }

  toolEnd(id: string, result: { output?: string; isError?: boolean; diff?: string }, at?: number): void {
    const running = this.tools.get(id);
    if (!running) {
      return;
    }
    const { step } = running;
    step.status = result.isError ? "error" : "done";
    const output = result.output === undefined ? "" : clipOutput(result.output);
    if (output !== "") {
      step.output = output;
    }
    const diff = result.diff === undefined ? "" : clipDiff(result.diff);
    if (diff.trim() !== "") {
      step.diff = diff;
    }
    const start = running.at;
    if (typeof start === "number" && typeof at === "number" && Number.isFinite(start) && Number.isFinite(at) && at >= start) {
      step.duration_ms = Math.round(at - start);
    }
  }

  steps(): TranscriptStep[] {
    return this.list.map((step) => ({ ...step }));
  }
}

export function readJsonLines(path: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const objects: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      objects.push(parsed as Record<string, unknown>);
    }
  }
  return objects;
}

export function stripMcpPrefix(name: string): string {
  const stripped = name.replace(/^mcp__.+?__/, "");
  return stripped === "" ? name : stripped;
}
