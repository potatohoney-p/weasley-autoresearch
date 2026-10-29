export type JsonlEntry = Record<string, unknown>;

export interface AutoresearchConfigEntry extends JsonlEntry {
  type: "config";
  name?: string;
  metricName?: string;
  metricUnit?: string;
  bestDirection?: "lower" | "higher";
}

export interface AutoresearchRunEntry extends JsonlEntry {
  run: number;
  metric: number;
  status: "keep" | "discard" | "crash" | "checks_failed";
}

export interface ReconstructedMetricDef {
  name: string;
  unit: string;
}

export interface ReconstructedRun {
  run: number;
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  timestamp: number;
  segment: number;
  confidence: number | null;
  asi?: Record<string, unknown>;
}

export interface ReconstructedJsonlState {
  name: string | null;
  metricName: string;
  metricUnit: string;
  bestDirection: "lower" | "higher";
  currentSegment: number;
  results: ReconstructedRun[];
  secondaryMetrics: ReconstructedMetricDef[];
}

const DEFAULT_METRIC_NAME = "metric";
const DEFAULT_METRIC_UNIT = "";
const DEFAULT_DIRECTION = "lower" as const;

function isObjectRecord(value: unknown): value is JsonlEntry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter(Boolean);
}

function inferMetricUnit(name: string): string {
  if (name.endsWith("µs")) return "µs";
  if (name.endsWith("_ms")) return "ms";
  if (name.endsWith("_s") || name.endsWith("_sec")) return "s";
  if (name.endsWith("_kb")) return "kb";
  if (name.endsWith("_mb")) return "mb";
  return "";
}

function metricMapFrom(value: unknown): Record<string, number> {
  if (!isObjectRecord(value)) return {};

  // Define data properties rather than invoking Object.prototype setters.
  return Object.fromEntries(
    Object.entries(value).filter(([, metric]) => typeof metric === "number" && Number.isFinite(metric))
  );
}

function directionFrom(value: unknown): ReconstructedJsonlState["bestDirection"] {
  return value === "higher" ? "higher" : DEFAULT_DIRECTION;
}

function asiFrom(value: unknown): Record<string, unknown> | undefined {
  return isObjectRecord(value) ? value : undefined;
}

function reconstructedState(): ReconstructedJsonlState {
  return {
    name: null,
    metricName: DEFAULT_METRIC_NAME,
    metricUnit: DEFAULT_METRIC_UNIT,
    bestDirection: DEFAULT_DIRECTION,
    currentSegment: 0,
    results: [],
    secondaryMetrics: [],
  };
}

function updateConfig(state: ReconstructedJsonlState, entry: AutoresearchConfigEntry): void {
  if (typeof entry.name === "string") state.name = entry.name;
  if (typeof entry.metricName === "string") state.metricName = entry.metricName;
  if (typeof entry.metricUnit === "string") state.metricUnit = entry.metricUnit;
  state.bestDirection = directionFrom(entry.bestDirection);
}

function nextSegment(state: ReconstructedJsonlState, segment: number): number {
  if (state.results.length === 0) return segment;
  state.secondaryMetrics = [];
  return segment + 1;
}

function runFrom(entry: AutoresearchRunEntry, segment: number): ReconstructedRun {
  return {
    run: entry.run,
    commit: typeof entry.commit === "string" ? entry.commit : "",
    metric: entry.metric,
    metrics: metricMapFrom(entry.metrics),
    status: entry.status,
    description: typeof entry.description === "string" ? entry.description : "",
    timestamp: typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp) ? entry.timestamp : 0,
    segment,
    confidence: typeof entry.confidence === "number" && Number.isFinite(entry.confidence) ? entry.confidence : null,
    asi: asiFrom(entry.asi),
  };
}

function registerSecondaryMetrics(state: ReconstructedJsonlState, metrics: Record<string, number>): void {
  for (const name of Object.keys(metrics)) {
    if (state.secondaryMetrics.find((metric) => metric.name === name)) continue;
    state.secondaryMetrics.push({ name, unit: inferMetricUnit(name) });
  }
}

export function parseJsonlEntry(line: string): JsonlEntry | null {
  try {
    const parsed = JSON.parse(line);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isAutoresearchConfigEntry(entry: unknown): entry is AutoresearchConfigEntry {
  return isObjectRecord(entry) && entry.type === "config";
}

export function isAutoresearchRunEntry(entry: unknown): entry is AutoresearchRunEntry {
  return isObjectRecord(entry) && entry.type === undefined &&
    typeof entry.run === "number" && Number.isSafeInteger(entry.run) && entry.run > 0 &&
    typeof entry.metric === "number" && Number.isFinite(entry.metric) &&
    (entry.status === "keep" || entry.status === "discard" ||
     entry.status === "crash" || entry.status === "checks_failed");
}

function firstConfigEntry(jsonlContent: string): AutoresearchConfigEntry | null {
  for (const line of nonEmptyLines(jsonlContent)) {
    const entry = parseJsonlEntry(line);
    if (isAutoresearchConfigEntry(entry)) return entry;
  }
  return null;
}

export function hasAutoresearchConfigHeader(jsonlContent: string): boolean {
  return firstConfigEntry(jsonlContent) !== null;
}

export function extractAutoresearchSessionName(jsonlContent: string): string {
  return firstConfigEntry(jsonlContent)?.name || "Autoresearch";
}

export function reconstructJsonlState(jsonlContent: string): ReconstructedJsonlState {
  const state = reconstructedState();
  let segment = 0;

  for (const line of nonEmptyLines(jsonlContent)) {
    const entry = parseJsonlEntry(line);
    if (!entry) continue;

    if (isAutoresearchConfigEntry(entry)) {
      updateConfig(state, entry);
      segment = nextSegment(state, segment);
      state.currentSegment = segment;
      continue;
    }

    if (!isAutoresearchRunEntry(entry)) continue;

    const run = runFrom(entry, segment);
    state.results.push(run);
    registerSecondaryMetrics(state, run.metrics);
  }

  return state;
}
