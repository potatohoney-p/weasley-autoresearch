import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkPathFromCommand } from "../extensions/weasley-autoresearch/benchmark-command.ts";

const accepted = [
  ["bash .auto/measure.sh", ".auto/measure.sh"],
  ["sh -eu -- .auto/measure.sh", ".auto/measure.sh"],
  ["bash -x -v ./.auto/measure.sh", "./.auto/measure.sh"],
  ["source -- ./.auto/measure.sh", "./.auto/measure.sh"],
  ["./autoresearch.sh --quick 3", "./autoresearch.sh"],
  ["bash autoresearch.sh", "autoresearch.sh"],
  ["bash ../nested/.auto/measure.sh", "../nested/.auto/measure.sh"],
  ["bash /tmp/project/.auto/measure.sh", "/tmp/project/.auto/measure.sh"],
  ['bash "path with spaces/.auto/measure.sh" "two words"', "path with spaces/.auto/measure.sh"],
  ["bash 'researcher'\\''s/.auto/measure.sh'", "researcher's/.auto/measure.sh"],
  ['bash path\\ with\\ spaces/.auto/measure.sh', "path with spaces/.auto/measure.sh"],
  ["RUNS=2 LABEL='two words' bash .auto/measure.sh", ".auto/measure.sh"],
  ["env -- RUNS=2 bash .auto/measure.sh", ".auto/measure.sh"],
  ["time -p bash .auto/measure.sh", ".auto/measure.sh"],
  ["nice -n +2 -- bash .auto/measure.sh", ".auto/measure.sh"],
  ["nice -n -2 bash .auto/measure.sh", ".auto/measure.sh"],
  ["nohup -- bash .auto/measure.sh", ".auto/measure.sh"],
  ["RUNS=2 time -p env LABEL=ok nice -n 0 nohup bash -- .auto/measure.sh --quick", ".auto/measure.sh"],
  ["bash .auto/measure.sh 'literal ; | & > < $(no) * ? # ~' \"escaped \\$value \\`value\\`\"", ".auto/measure.sh"],
  ["bash .auto/measure.sh '' 'two words' literal\\|pipe", ".auto/measure.sh"],
];
for (const [command, path] of accepted) {
  test(`recognizes literal invocation: ${command}`, () => {
    assert.equal(benchmarkPathFromCommand(command), path);
  });
}

const rejected = [
  "", "echo .auto/measure.sh", "bash .auto/measure.sh || true",
  "bash .auto/measure.sh ; true", "bash .auto/measure.sh && true",
  "bash .auto/measure.sh | cat", "bash .auto/measure.sh &", "bash .auto/measure.sh\ntrue",
  "bash .auto/measure.sh > .auto/output", "bash .auto/measure.sh 2>&1",
  "bash .auto/measure.sh $(true)", "bash .auto/measure.sh `true`",
  "bash .auto/measure.sh <(true)", 'bash "$SCRIPT"',
  "bash .auto/measure.sh $ARGS", 'bash .auto/measure.sh "$ARGS"',
  "bash .auto/measure.sh *.txt", "bash .auto/measure.sh {a,b}", "bash .auto/measure.sh ~",
  "bash .auto/measure.sh # comment", "bash .auto/measure.sh 'unterminated", 'bash "unterminated',
  "bash .auto/measure.sh \\", "bash .auto/measure.sh \\\nignored", "bash .auto/measure.sh \u0000",
  "bash -n .auto/measure.sh", "bash -en .auto/measure.sh", "bash -s .auto/measure.sh",
  "bash -c .auto/measure.sh", "bash -D .auto/measure.sh", "bash --help .auto/measure.sh",
  "bash --version .auto/measure.sh", "bash -o noexec .auto/measure.sh",
  "sh -n .auto/measure.sh", "source -n .auto/measure.sh",
  "env --help bash .auto/measure.sh", "env --version bash .auto/measure.sh",
  "env -S 'bash -n' .auto/measure.sh", "env -C elsewhere bash .auto/measure.sh",
  "nice --help bash .auto/measure.sh", "nice -n nope bash .auto/measure.sh",
  "nohup --help bash .auto/measure.sh", "time --help bash .auto/measure.sh",
  "BASH_ENV=skip.sh bash .auto/measure.sh", "ENV=skip.sh sh .auto/measure.sh",
  "env SHELLOPTS=noexec bash .auto/measure.sh", "env 'BASHOPTS=extdebug' bash .auto/measure.sh",
  "bash -n/.auto/measure.sh", "source autoresearch.sh", "autoresearch.sh",
  "bash .auto/measure.sh.backup", "bash custom.sh",
  "bash .auto/measure.sh\u00a0", "\u00a0bash .auto/measure.sh",
  "bash .auto/measure.sh\n", "bash .auto/measure.sh\r",
  "env source .auto/measure.sh", "nice source .auto/measure.sh", "nohup source .auto/measure.sh",
];
for (const command of rejected) {
  test(`rejects unsupported invocation: ${JSON.stringify(command)}`, () => {
    assert.equal(benchmarkPathFromCommand(command), null);
  });
}
