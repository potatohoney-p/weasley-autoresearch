import { createHash, type Hash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { sessionFileCandidates, sessionFilePath } from "./paths.ts";

function git(cwd: string, args: string[], optional = false): Buffer {
  const result = spawnSync("git", args, {
    cwd, timeout: 5000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error) throw result.error;
  if (optional && result.status === 1) return Buffer.alloc(0);
  if (result.status !== 0) throw new Error(`git ${args[0]} could not read candidate metadata`);
  return result.stdout;
}

function utf8(value: Buffer): string {
  const decoded = value.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(value)) {
    throw new Error("Candidate path metadata is not valid UTF-8");
  }
  return decoded;
}

function line(value: Buffer): string {
  return utf8(value).replace(/\r?\n$/, "");
}

function records(value: Buffer): string[] {
  if (!value.length) return [];
  if (value[value.length - 1] !== 0) throw new Error("Incomplete NUL-delimited Git metadata");
  return utf8(value.subarray(0, -1)).split("\0");
}

function frame(hash: Hash, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  hash.update(`${bytes.length}:`);
  hash.update(bytes);
}

function sessionArtifact(relative: string): boolean {
  const parts = relative.split("/");
  const legacyFiles = new Set([
    "autoresearch.jsonl", "autoresearch.md", "autoresearch.ideas.md",
    "autoresearch.checks.sh", "autoresearch.sh", "autoresearch.config.json",
  ]);
  return parts.some((part) => part === ".auto" || part === "autoresearch.hooks") ||
    legacyFiles.has(parts.at(-1)!);
}

function validatePath(relative: string): void {
  if (!relative || path.isAbsolute(relative) || relative.split("/").some((part) => part === "..")) {
    throw new Error("Unsupported candidate path metadata");
  }
}

function verifyCandidateAncestors(root: string, relative: string): void {
  let ancestor = root;
  for (const part of relative.split("/").slice(0, -1)) {
    ancestor = path.join(ancestor, part);
    try {
      const stat = fs.lstatSync(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Unsupported candidate ancestor type; restore the directory before benchmarking: ${ancestor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function fileDigest(file: string, indexMode: string | undefined, fileMode: boolean, symlinks: boolean): string[] {
  if (indexMode === "160000") throw new Error("Submodule provenance is unsupported; use a worktree without gitlinks");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ["absent"];
    throw new Error(`Cannot read candidate metadata: ${file}`, { cause: error });
  }
  if (stat.isSymbolicLink()) {
    return ["symlink", "120000", createHash("sha256").update(fs.readlinkSync(file, { encoding: "buffer" })).digest("hex")];
  }
  if (!stat.isFile()) throw new Error(`Unsupported candidate file kind: ${file}`);
  const mode = indexMode === "120000" && !symlinks ? "120000"
    : fileMode ? (stat.mode & 0o100 ? "100755" : "100644")
    : indexMode === "100755" ? "100755" : "100644";
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let length: number;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
  } finally {
    fs.closeSync(fd);
  }
  return ["file", mode, hash.digest("hex")];
}

function controlDigest(file: string, fileMode: boolean, symlinks: boolean): string[] {
  const fingerprint = fileDigest(file, undefined, fileMode, symlinks);
  if (fingerprint[0] === "absent") return fingerprint;
  // Parent directories can also be links: bind every existing control's target.
  const target = fs.realpathSync.native(file);
  if (fingerprint[0] !== "symlink") return [...fingerprint, target];
  return [...fingerprint, target, ...fileDigest(target, undefined, fileMode, symlinks)];
}

/** Resolve the literal benchmark path recognized by the existing command guard. */
export function resolveBenchmarkPath(workDir: string, benchmark: string | null): string | null {
  if (!benchmark) return null;
  if (process.platform === "win32" && benchmark.startsWith("/")) {
    const drive = /^\/([a-zA-Z])\/(.*)$/.exec(benchmark);
    if (!drive) throw new Error("Cannot resolve this Git Bash absolute benchmark path; use a cwd-relative path such as bash .auto/measure.sh");
    return path.resolve(`${drive[1]}:/${drive[2]}`);
  }
  return path.resolve(workDir, benchmark);
}

/**
 * Read-only digest of working-tree candidate paths considered by git add -A.
 * This is not an atomic snapshot or proof of all inputs read by shell commands.
 */
export function captureCandidateProvenance(workDir: string, invokedBenchmark: string | null = null): string {
  const root = fs.realpathSync.native(line(git(workDir, ["rev-parse", "--show-toplevel"])));
  const head = line(git(root, ["rev-parse", "--verify", "HEAD"]));
  const fileMode = line(git(root, ["config", "--bool", "--get", "core.filemode"], true)) !== "false";
  const symlinks = line(git(root, ["config", "--bool", "--get", "core.symlinks"], true)) !== "false";
  // These index flags can make add -A retain old blobs instead of tested bytes.
  // Read them without refreshing the index, including flags on session files.
  for (const entry of records(git(root, ["ls-files", "-v", "-z", "--full-name"]))) {
    const match = /^([A-Za-z?]) ([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("Unsupported Git index flag metadata");
    const [, tag, relative] = match;
    validatePath(relative);
    const flag = tag.toUpperCase() === "S" ? "skip-worktree" : tag !== tag.toUpperCase() ? "assume-unchanged" : null;
    if (flag) throw new Error(`Unsupported ${flag} index flag on ${relative}; clear the flag intentionally before benchmarking`);
  }
  const candidates = new Map<string, string | undefined>();
  for (const entry of records(git(root, ["ls-files", "--stage", "-z", "--full-name"]))) {
    const match = /^([0-7]{6}) [a-f0-9]+ ([0-3])\t([\s\S]+)$/.exec(entry);
    if (!match || match[2] !== "0") throw new Error("Unmerged or unsupported Git index metadata; resolve conflicts before benchmarking");
    const [, mode, , relative] = match;
    validatePath(relative);
    if (!sessionArtifact(relative)) candidates.set(relative, mode);
  }
  for (const relative of records(git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--full-name"]))) {
    validatePath(relative);
    if (!sessionArtifact(relative)) candidates.set(relative, undefined);
  }
  const hash = createHash("sha256");
  for (const value of ["candidate-v1", root, fs.realpathSync.native(workDir), head]) frame(hash, value);
  for (const relative of [...candidates.keys()].sort()) {
    verifyCandidateAncestors(root, relative);
    frame(hash, JSON.stringify(["candidate", relative, ...fileDigest(path.join(root, relative), candidates.get(relative), fileMode, symlinks)]));
  }
  // Both layouts are explicit, even if ignored or absent. Selected paths also
  // bind layout switches caused by creating other current-session artifacts.
  for (const kind of ["measure", "checks"] as const) {
    frame(hash, JSON.stringify([`selected-${kind}`, sessionFilePath(workDir, kind)]));
    for (const file of Object.values(sessionFileCandidates(workDir, kind))) {
      frame(hash, JSON.stringify(["control", file, ...controlDigest(file, fileMode, symlinks)]));
    }
  }
  if (invokedBenchmark) {
    const fingerprint = controlDigest(invokedBenchmark, fileMode, symlinks);
    if (fingerprint[0] === "absent") throw new Error("The recognized benchmark path cannot be read; use an explicit existing cwd-relative script path");
    frame(hash, JSON.stringify(["invoked", invokedBenchmark, ...fingerprint]));
  }
  return hash.digest("hex");
}
