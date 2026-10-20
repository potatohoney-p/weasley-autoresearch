import { StringDecoder } from "node:string_decoder";

export const METRIC_LIMITS = { lineBytes: 4096, nameChars: 128, metrics: 256 } as const;
export type MetricLimit = keyof typeof METRIC_LIMITS;
type Stream = "stdout" | "stderr";
type StreamState = {
  decoder: StringDecoder;
  line: string;
  bytes: number;
  dropping: boolean;
  ended: boolean;
};

const DENIED_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const LINE = /^METRIC[^\S\r\n\u2028\u2029]+([\w.µ]+)=(\S+)[^\S\r\n\u2028\u2029]*$/u;

/** Bounded metric capture independent of the rolling display buffer. */
export class MetricCollector {
  private readonly values = new Map<string, number>();
  private readonly limits = new Set<MetricLimit>();
  private readonly streams: Record<Stream, StreamState> = {
    stdout: { decoder: new StringDecoder("utf8"), line: "", bytes: 0, dropping: false, ended: false },
    stderr: { decoder: new StringDecoder("utf8"), line: "", bytes: 0, dropping: false, ended: false },
  };

  write(stream: Stream, data: Buffer): void {
    const state = this.streams[stream];
    if (state.ended) throw new Error("Cannot collect metrics after stream end");
    // Bound temporary decoding too, even if a caller supplies one enormous chunk.
    for (let offset = 0; offset < data.length; offset += METRIC_LIMITS.lineBytes) {
      this.consume(state, state.decoder.write(data.subarray(offset, offset + METRIC_LIMITS.lineBytes)));
    }
  }

  end(stream: Stream): void {
    const state = this.streams[stream];
    if (state.ended) return;
    this.consume(state, state.decoder.end());
    this.finishLine(state);
    state.ended = true;
  }

  snapshot(): { values: Map<string, number>; limits: MetricLimit[] } {
    return { values: new Map(this.values), limits: [...this.limits] };
  }

  private consume(state: StreamState, decoded: string): void {
    const parts = decoded.split(/[\r\n\u2028\u2029]/u);
    for (let i = 0; i < parts.length; i++) {
      if (!state.dropping) {
        const bytes = state.bytes + Buffer.byteLength(parts[i], "utf8");
        if (bytes > METRIC_LIMITS.lineBytes) {
          this.limits.add("lineBytes");
          state.line = "";
          state.bytes = 0;
          state.dropping = true;
        } else {
          state.line += parts[i];
          state.bytes = bytes;
        }
      }
      if (i < parts.length - 1) this.finishLine(state);
    }
  }

  private finishLine(state: StreamState): void {
    if (!state.dropping) {
      const match = LINE.exec(state.line);
      if (match && !DENIED_NAMES.has(match[1])) {
        const [, name, raw] = match;
        const value = Number(raw);
        if (name.length > METRIC_LIMITS.nameChars) {
          this.limits.add("nameChars");
        } else if (Number.isFinite(value)) {
          if (this.values.has(name) || this.values.size < METRIC_LIMITS.metrics) {
            // Map insertion order stays stable; the last valid duplicate wins.
            this.values.set(name, value);
          } else {
            this.limits.add("metrics");
          }
        }
      }
    }
    state.line = "";
    state.bytes = 0;
    state.dropping = false;
  }
}

export function metricLimitWarning(limits: MetricLimit[]): string {
  if (!limits.length) return "";
  const labels = {
    lineBytes: `${METRIC_LIMITS.lineBytes} UTF-8 bytes per output line`,
    nameChars: `${METRIC_LIMITS.nameChars} characters per metric name`,
    metrics: `${METRIC_LIMITS.metrics} distinct metric names`,
  };
  return `Structured metric capture exceeded ${limits.map((limit) => labels[limit]).join(", ")}. Some metrics may be missing; inspect full output or emit shorter/fewer metric records and rerun.`;
}
