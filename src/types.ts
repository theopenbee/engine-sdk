export interface EngineRequest<P> {
  protocol_version: number;
  method: "run" | "check" | "usage" | "models" | "transcript";
  openbee_version: string;
  engine_id: string;
  language: string;
  config: Record<string, unknown>;
  data_dir: string;
  state_dir: string;
  params: P;
}

export interface RunParams {
  role: "bee" | "worker";
  work_dir: string;
  prompt: string;
  session_id: string;
  resume: boolean;
  extra_args: string[];
  log_path: string;
  model?: string;
  mcp?: { name: string; url: string; api_key_env: string };
}

export interface RunResult {
  text: string;
  error?: string;
}

export interface CheckResult {
  version: string;
  path: string;
}

export interface TokenUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}

export interface ModelInfo {
  id: string;
  name?: string;
}

export type ToolKind = "command" | "read" | "edit" | "search" | "web" | "message" | "other";

export type TranscriptStep =
  | { type: "text" | "thinking" | "error"; text: string }
  | {
      type: "tool";
      kind: ToolKind;
      name: string;
      summary?: string;
      diff?: string;
      output?: string;
      status: "running" | "done" | "error";
      duration_ms?: number;
    };

export interface TranscriptParams {
  log_path: string;
}

export interface Engine {
  check(req: EngineRequest<Record<string, never>>): Promise<CheckResult>;
  run(req: EngineRequest<RunParams>): Promise<RunResult>;
  usage(req: EngineRequest<{ session_ids: string[] }>): Promise<Record<string, TokenUsage[]>>;
  models?(req: EngineRequest<Record<string, never>>): Promise<ModelInfo[]>;
  transcript?(req: EngineRequest<TranscriptParams>): Promise<TranscriptStep[]>;
}
