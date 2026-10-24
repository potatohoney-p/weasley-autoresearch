import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

import { hasAutoresearchConfigHeader } from "./jsonl.ts";
import { hookScriptPath } from "./paths.ts";

const TIMEOUT_MS = 30_000;
const OUTPUT_MAX_BYTES = 8 * 1024;

/** Retain a bounded byte prefix; decoding after collection preserves split UTF-8. */
export function createHookOutputCollector(stream: "stdout" | "stderr") {
  const buffer = Buffer.alloc(OUTPUT_MAX_BYTES);
  let length = 0;
  let truncated = false;
  return {
    append(chunk: Buffer) {
      const kept = Math.min(chunk.length, OUTPUT_MAX_BYTES - length);
      chunk.copy(buffer, length, 0, kept);
      length += kept;
      if (kept < chunk.length) truncated = true;
    },
    text(): string {
      const bytes = buffer.subarray(0, length);
      if (!truncated) return bytes.toString("utf8");
      // An incomplete final code point at the byte cap must not become U+FFFD.
      const decoder = new StringDecoder("utf8");
      const prefix = decoder.write(bytes);
      return prefix + `\n…[truncated: hook ${stream} exceeded 8KB]`;
    },
  };
}

export type HookStage = "before" | "after";

export interface SessionSnapshot {
  metric_name: string;
  metric_unit: string;
  direction: "lower" | "higher";
  baseline_metric: number | null;
  best_metric: number | null;
  run_count: number;
  goal: string;
}

export interface BeforeHookPayload {
  event: "before";
  cwd: string;
  next_run: number;
  last_run: Record<string, unknown> | null;
  session: SessionSnapshot;
}

export interface AfterHookPayload {
  event: "after";
  cwd: string;
  run_entry: Record<string, unknown>;
  session: SessionSnapshot;
}

export type HookPayload = BeforeHookPayload | AfterHookPayload;

export interface HookResult {
  fired: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

const notFired: HookResult = {
  fired: false,
  stdout: "",
  stderr: "",
  exitCode: null,
  timedOut: false,
  durationMs: 0,
};

export async function runHook(payload: HookPayload): Promise<HookResult> {
  const script = hookScriptPath(payload.cwd, payload.event);
  if (!isExecutableFile(script)) return notFired;

  const t0 = Date.now();
  return new Promise<HookResult>((resolve) => {
    const child = spawn("bash", [script], { cwd: payload.cwd, timeout: TIMEOUT_MS });

    const stdout = createHookOutputCollector("stdout");
    const stderr = createHookOutputCollector("stderr");
    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));

    const finish = (exitCode: number | null, extraErr = "") => {
      if (extraErr) stderr.append(Buffer.from(`\n${extraErr}`, "utf8"));
      resolve({
        fired: true,
        stdout: stdout.text(),
        stderr: stderr.text(),
        exitCode,
        timedOut: child.killed,
        durationMs: Date.now() - t0,
      });
    };

    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(code));

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

export function steerMessageFor(stage: HookStage, result: HookResult): string | null {
  if (!result.fired) return null;
  if (result.timedOut) return `[${stage} hook timed out after ${TIMEOUT_MS / 1000}s]`;
  if (result.exitCode !== 0) {
    const parts = [`[${stage} hook exited ${result.exitCode}]`];
    const err = result.stderr.trim();
    const out = result.stdout.trim();
    if (err) parts.push(err);
    if (out) parts.push(out);
    return parts.join("\n");
  }
  return result.stdout.trim() || null;
}

export function hookLogEntry(stage: HookStage, result: HookResult): Record<string, unknown> {
  return {
    type: "hook",
    stage,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    stdout_bytes: Buffer.byteLength(result.stdout, "utf8"),
    timed_out: result.timedOut,
  };
}

function hasConfigHeader(jsonlPath: string): boolean {
  if (!fs.existsSync(jsonlPath)) return false;
  try {
    return hasAutoresearchConfigHeader(fs.readFileSync(jsonlPath, "utf-8"));
  } catch {
    return false;
  }
}

export function appendHookLogEntryIfConfigured(
  jsonlPath: string,
  stage: HookStage,
  result: HookResult,
): boolean {
  if (!result.fired) return false;
  if (!hasConfigHeader(jsonlPath)) return false;

  try {
    fs.appendFileSync(jsonlPath, JSON.stringify(hookLogEntry(stage, result)) + "\n");
    return true;
  } catch {
    return false;
  }
}
