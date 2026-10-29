import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { median } from "../bin/repeat-benchmark.mjs";

const tiny = Number.MIN_VALUE;
const cases = [
  { name: "positive subnormal midpoint", samples: [tiny, 2 * tiny], expected: 2 * tiny },
  { name: "opposite-sign cancellation", samples: [-tiny, 2 * tiny], expected: 0 },
  { name: "negative subnormal midpoint", samples: [-2 * tiny, -tiny], expected: -2 * tiny },
  { name: "equal subnormals", samples: [tiny, tiny], expected: tiny },
  { name: "positive overflow-safe midpoint", samples: [1e308, 1e308], expected: 1e308 },
  { name: "negative overflow-safe midpoint", samples: [-1e308, -1e308], expected: -1e308 },
  { name: "large cancellation", samples: [-1e308, 1e308], expected: 0 },
];

for (const { name, samples, expected } of cases) {
  test(`median preserves ${name}`, () => {
    const original = [...samples];
    assert.equal(median(samples), expected);
    assert.equal(median([...samples].reverse()), expected);
    assert.deepEqual(samples, original);
  });
}

test("CLI preserves subnormal median and MAD in both stdout and report", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "repeat-statistics-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "measure.mjs"), `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const index = existsSync('counter') ? Number(readFileSync('counter', 'utf8')) : 0;
writeFileSync('counter', String(index + 1));
console.log('METRIC same=' + [5e-324, 1e-323][index]);
console.log('METRIC opposite=' + [-5e-324, 1e-323][index]);
`);
  const cli = fileURLToPath(new URL("../bin/repeat-benchmark.mjs", import.meta.url));
  const stdout = execFileSync(process.execPath, [cli, "--metric", "same", "--runs", "2",
    "--report", "report.json", "--", process.execPath, "measure.mjs"], { cwd, encoding: "utf8", timeout: 10000 });
  assert.equal(stdout, "METRIC same=1e-323\nMETRIC opposite=0\n");
  const report = JSON.parse(readFileSync(join(cwd, "report.json"), "utf8"));
  assert.equal(report.status, "success");
  assert.equal(report.summary.same.median, 2 * tiny);
  assert.equal(report.summary.same.mad, 0);
  assert.equal(report.summary.opposite.median, 0);
  assert.equal(report.summary.opposite.mad, 2 * tiny);
  assert.deepEqual(report.trials.map(({ metrics }) => metrics.same), [tiny, 2 * tiny]);
});
