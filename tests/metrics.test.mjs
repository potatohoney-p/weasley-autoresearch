import assert from "node:assert/strict";
import test from "node:test";
import { MetricCollector, METRIC_LIMITS, metricLimitWarning } from "../extensions/weasley-autoresearch/metrics.ts";

function collect(output) {
  const collector = new MetricCollector();
  collector.write("stdout", Buffer.from(output));
  collector.end("stdout");
  return collector.snapshot();
}

test("valid single-line grammar retains finite Number syntax and insertion order", () => {
  const { values, limits } = collect("METRIC latency=1.25\nMETRIC total_µs=-2e3\r\nMETRIC hex=0x10\rMETRIC binary=0b11\nMETRIC latency=+4\nMETRIC\tcache.hit=0.5 \t");
  assert.deepEqual([...values], [["latency", 4], ["total_µs", -2000], ["hex", 16], ["binary", 3], ["cache.hit", 0.5]]);
  assert.deepEqual(limits, []);
});

test("invalid names and nonfinite values cannot replace valid metrics", () => {
  const invalid = ["__proto__=1", "constructor=2", "prototype=3", "bad-name=1", "x/y=2", "x y=3", "latency=NaN", "latency=Infinity", "latency=1e999", "latency=1 trailing"];
  const { values } = collect("METRIC latency=2\n" + invalid.map((line) => `METRIC ${line}\n`).join("") + " METRIC indented=1\nmetric lower=2\n");
  assert.deepEqual([...values], [["latency", 2]]);
});

test("every byte boundary preserves split UTF-8 names, CRLF and final unterminated records", () => {
  const bytes = Buffer.from("METRIC total_µs=12.5\r\nMETRIC final=7");
  for (let split = 0; split <= bytes.length; split++) {
    const collector = new MetricCollector();
    collector.write("stdout", bytes.subarray(0, split));
    collector.write("stdout", bytes.subarray(split));
    collector.end("stdout");
    assert.deepEqual([...collector.snapshot().values], [["total_µs", 12.5], ["final", 7]], `split=${split}`);
  }
});

test("stdout and stderr cannot splice partial records or UTF-8 bytes together", () => {
  const collector = new MetricCollector();
  const bytes = Buffer.from("METRIC total_µs=1\n");
  const split = bytes.indexOf(0xc2) + 1;
  collector.write("stdout", bytes.subarray(0, split));
  collector.write("stderr", Buffer.from("METRIC other=2\n"));
  collector.write("stdout", bytes.subarray(split));
  collector.write("stdout", Buffer.from("METRIC partial="));
  collector.write("stderr", Buffer.from("3\n"));
  collector.end("stderr");
  collector.end("stdout");
  assert.deepEqual([...collector.snapshot().values], [["other", 2], ["total_µs", 1]]);
});

test("duplicates follow line-completion events, including stream end", () => {
  const collector = new MetricCollector();
  collector.write("stdout", Buffer.from("METRIC shared=1"));
  collector.write("stderr", Buffer.from("METRIC shared=2\n"));
  assert.equal(collector.snapshot().values.get("shared"), 2);
  collector.end("stdout");
  collector.end("stdout");
  collector.end("stderr");
  assert.equal(collector.snapshot().values.get("shared"), 1);
});

test("newline-spanning records are malformed while each complete line remains readable", () => {
  for (const newline of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
    const { values } = collect(`METRIC ${newline}bad=1${newline}METRIC good=2${newline}METRIC${newline}bad2=3`);
    assert.deepEqual([...values], [["good", 2]]);
  }
});

test("overlong lines are dropped whole with recovery at the next line", () => {
  const collector = new MetricCollector();
  const exact = "METRIC boundary=1";
  collector.write("stdout", Buffer.from(exact + " ".repeat(METRIC_LIMITS.lineBytes - Buffer.byteLength(exact)) + "\n"));
  collector.write("stdout", Buffer.from("METRIC lost=2" + " ".repeat(2 * 1024 * 1024)));
  collector.write("stdout", Buffer.from("METRIC fabricated=3\nMETRIC recovered=4\n"));
  collector.end("stdout");
  const { values, limits } = collector.snapshot();
  assert.deepEqual([...values], [["boundary", 1], ["recovered", 4]]);
  assert.deepEqual(limits, ["lineBytes"]);
});

test("line bounds count UTF-8 bytes instead of JavaScript characters", () => {
  const prefix = "METRIC x=1";
  const exact = prefix + "\u00a0".repeat((METRIC_LIMITS.lineBytes - prefix.length) / 2);
  assert.equal(Buffer.byteLength(exact), METRIC_LIMITS.lineBytes);
  const { values, limits } = collect(exact + "\n" + exact.replace("x=1", "x=2") + " \n");
  assert.equal(values.get("x"), 1);
  assert.deepEqual(limits, ["lineBytes"]);
});

test("metric name length is bounded independently of line size", () => {
  const name = "n".repeat(METRIC_LIMITS.nameChars);
  const { values, limits } = collect(`METRIC ${name}=1\nMETRIC ${name}x=2\n`);
  assert.deepEqual([...values], [[name, 1]]);
  assert.deepEqual(limits, ["nameChars"]);
});

test("distinct-name cap keeps admitted duplicates updatable without eviction", () => {
  const lines = Array.from({ length: METRIC_LIMITS.metrics + 20 }, (_, i) => `METRIC n${i}=${i}\n`).join("");
  const { values, limits } = collect(lines + "METRIC n0=999\nMETRIC n0=Infinity\n");
  assert.equal(values.size, METRIC_LIMITS.metrics);
  assert.equal(values.get("n0"), 999);
  assert.equal(values.has(`n${METRIC_LIMITS.metrics}`), false);
  assert.deepEqual(limits, ["metrics"]);
  assert.match(metricLimitWarning(limits), /256 distinct metric names.*Some metrics may be missing/);
});

test("invalid or incomplete UTF-8 cannot create a valid metric name", () => {
  const collector = new MetricCollector();
  collector.write("stdout", Buffer.concat([Buffer.from("METRIC x"), Buffer.from([0xc2]), Buffer.from("=1\nMETRIC valid=2\nMETRIC last="), Buffer.from([0xc2])]));
  collector.end("stdout");
  assert.deepEqual([...collector.snapshot().values], [["valid", 2]]);
});
