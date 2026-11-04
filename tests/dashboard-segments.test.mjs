import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { reconstructJsonlState } from '../extensions/weasley-autoresearch/jsonl.ts';

const html = readFileSync(new URL('../assets/template.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const config = (name, metricName, metricUnit, bestDirection) => ({ type: 'config', name, metricName, metricUnit, bestDirection });
const run = (number, metric, status = 'keep') => ({ run: number, metric, status });
const old = [config('Latency', 'latency', 'ms', 'lower'), run(1, 100), run(2, 90)];
const current = [config('Throughput', 'throughput', 'ops/s', 'higher'), run(3, 500), run(4, 600)];
const jsonl = entries => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
const plain = value => JSON.parse(JSON.stringify(value));

function dashboard() {
  const elements = new Map(), drawing = [];
  const context = new Proxy({
    measureText: text => ({ width: String(text).length * 8 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  }, { get(target, key) {
    return key in target ? target[key] : (...args) => drawing.push([key, ...args]);
  } });
  const element = () => ({
    textContent: '', style: {}, children: [], clientWidth: 800, clientHeight: 300,
    classList: { add() {}, remove() {} }, addEventListener() {}, setAttribute() {},
    getContext: () => context, appendChild(child) { this.children.push(child); },
    set innerHTML(value) { this.html = value; this.children = []; }, get innerHTML() { return this.html; },
  });
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    createElement: element,
  };
  const scope = vm.createContext({ document, window: { addEventListener() {}, devicePixelRatio: 1 }, location: { protocol: 'file:' } });
  vm.runInContext(script + '\n;globalThis.api = { parseAutoresearchText, loadFromText, session, chartState, renderShareCard };', scope);
  return { ...scope.api, elements, drawing, document };
}

for (const format of ['JSONL', 'array', 'entries document']) {
  test(`${format} dashboard isolates the latest goal, metric and direction`, () => {
    const d = dashboard(), entries = [...old, ...current];
    const input = format === 'JSONL' ? jsonl(entries) : JSON.stringify(format === 'array' ? entries : { entries });
    const parsed = d.parseAutoresearchText(input);
    assert.equal(parsed.ok, true);
    assert.deepEqual(plain(parsed.config), { name: 'Throughput', metricName: 'throughput', metricUnit: 'ops/s', bestDirection: 'higher' });
    assert.deepEqual(plain(parsed.runs).map(r => r.run), [3, 4]);
    d.loadFromText(input);
    assert.equal(d.document.title, 'Throughput');
    assert.equal(d.session.baseline, 500);
    assert.equal(d.session.best, 600);
    assert.equal(d.elements.get('run-count').textContent, '2');
    assert.equal(d.elements.get('baseline-best').textContent, '500.00ops/s → 600.00ops/s');
    assert.equal(d.elements.get('improvement').textContent, '20.0%');
    assert.equal(d.elements.get('table-body').children.length, 2);
    assert.equal(d.chartState.points.length, 2);
  });
}

test('config-only refresh clears previous rows, metrics and chart before a new baseline', () => {
  const d = dashboard();
  d.loadFromText(jsonl(old));
  d.loadFromText(jsonl([...old, current[0]]));
  assert.equal(d.session.config.name, 'Throughput');
  assert.equal(d.session.baseline, null);
  assert.equal(d.session.best, null);
  assert.equal(d.elements.get('baseline-best').textContent, '— → —');
  assert.equal(d.elements.get('run-count').textContent, '0');
  assert.equal(d.elements.get('kept-count').textContent, '0/0');
  assert.equal(d.elements.get('table-body').children.length, 0);
  assert.equal(d.chartState.points.length, 0);
  assert.equal(d.chartState.geometry, null);
  assert.equal(d.document.title, 'Throughput');
  d.loadFromText(jsonl([...old, ...current]));
  assert.equal(d.session.baseline, 500);
  assert.equal(d.session.best, 600);
});

test('one config record is a valid empty dashboard, including CRLF and no final newline', () => {
  for (const input of [JSON.stringify(current[0]), jsonl([current[0]]).replaceAll('\n', '\r\n')]) {
    const d = dashboard(), result = d.parseAutoresearchText(input);
    assert.equal(result.ok, true);
    assert.equal(result.runs.length, 0);
    d.loadFromText(input);
    assert.equal(d.elements.get('title').textContent, 'Throughput');
  }
});

test('consecutive partial configs match runtime recovery metadata and current-segment runs', () => {
  const entries = [...old, { type: 'config', name: 'Next' }, { type: 'config', metricUnit: 'seconds', bestDirection: 'higher' }, run(3, 7)];
  const expected = reconstructJsonlState(jsonl(entries));
  const result = dashboard().parseAutoresearchText(jsonl(entries));
  assert.equal(result.ok, true);
  for (const key of ['name', 'metricName', 'metricUnit', 'bestDirection']) assert.equal(result.config[key], expected[key], key);
  assert.deepEqual(plain(result.runs).map(r => r.run), expected.results.filter(r => r.segment === expected.currentSegment).map(r => r.run));
});

test('hooks and unknown metadata do not become measurements or reset the active segment', () => {
  const entries = [...old, current[0], { type: 'hook', run: 99, metric: 1, status: 'keep' }, current[1], { type: 'future', run: 100, metric: 1, status: 'keep' }, current[2]];
  const result = dashboard().parseAutoresearchText(jsonl(entries));
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.runs).map(r => r.run), [3, 4]);
});

test('share-card rendering uses only current-segment labels and counts', () => {
  const d = dashboard();
  d.loadFromText(jsonl([...old, ...current]));
  d.drawing.length = 0;
  d.renderShareCard(d.document.createElement('canvas'));
  const labels = d.drawing.filter(([operation]) => operation === 'fillText').map(([, value]) => value);
  assert.ok(labels.includes('Throughput'));
  assert.ok(labels.includes('★ THROUGHPUT'));
  assert.ok(labels.includes('500.00ops/s'));
  assert.ok(labels.includes('600.00ops/s'));
  assert.equal(labels.includes('Latency'), false);
  assert.equal(labels.includes('4'), false);
});

for (const format of ['JSONL', 'array', 'runs document']) {
  test(`${format} single-segment input keeps existing behavior and run numbers`, () => {
    const input = format === 'JSONL' ? jsonl(old) : JSON.stringify(format === 'array' ? old : { config: old[0], runs: old.slice(1) });
    const d = dashboard(), result = d.parseAutoresearchText(input);
    assert.equal(result.ok, true);
    assert.equal(result.config.name, 'Latency');
    assert.deepEqual(plain(result.runs).map(r => r.run), [1, 2]);
    d.loadFromText(input);
    assert.equal(d.session.best, 90);
  });
}

test('malformed JSONL leaves the last successfully rendered segment intact', () => {
  const d = dashboard();
  d.loadFromText(jsonl(current));
  d.loadFromText(jsonl([...old, current[0]]) + '{"run":3');
  assert.equal(d.session.config.name, 'Throughput');
  assert.equal(d.session.baseline, 500);
  assert.match(d.elements.get('meta').textContent, /invalid JSON/);
});

test('reinitialization with identical metadata still resets the baseline', () => {
  const d = dashboard();
  d.loadFromText(jsonl([...old, old[0], run(3, 80)]));
  assert.equal(d.session.baseline, 80);
  assert.equal(d.session.runs.length, 1);
  assert.equal(d.elements.get('improvement').textContent, '0.0%');
});

test('empty or metadata-only input without a config remains invalid', () => {
  for (const input of ['', '[]', '{}', '{"type":"hook"}\n', '[null,1,"text",{"type":"hook"}]']) {
    assert.equal(dashboard().parseAutoresearchText(input).ok, false, input);
  }
});
