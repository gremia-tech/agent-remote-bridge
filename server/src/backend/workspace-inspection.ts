// Adapted from herdr-mobile-relay (MIT), Copyright (c) 2026 Altan Sarisin.
// Full license and pinned source: ../../vendor/herdr-mobile-relay/.
import { O_NOFOLLOW, O_RDONLY } from "node:constants";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, parse, relative, resolve, sep } from "node:path";

import type {
  WorkspaceFileEntry,
  WorkspaceFileResponse,
  WorkspaceGitDiffResponse,
  WorkspaceGitFile,
  WorkspaceGitStatusResponse,
} from "./inspection-types.ts";

const MAX_TREE_ENTRIES = 12_000;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_IMAGE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DIFF_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 8_000;
const MAX_NEW_FILE_NUMSTAT_FILES = 256;
const NEW_FILE_NUMSTAT_TIMEOUT_MS = 4_000;

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".expo",
  ".next",
  ".turbo",
  ".vite",
  "Pods",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const TEXT_MEDIA_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".csv": "text/csv",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jsx": "text/javascript",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".sh": "text/x-shellscript",
  ".svg": "image/svg+xml",
  ".toml": "text/plain",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

export class WorkspaceInspectionError extends Error {
  constructor(
    readonly status: 400 | 404 | 413 | 422 | 429 | 500,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceInspectionError";
  }
}

export class GitSubprocessLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly maxActive: number,
    private readonly maxQueued: number,
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(): Promise<() => void> {
    if (this.active < this.maxActive) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(
        new WorkspaceInspectionError(429, "too many concurrent Git inspection commands"),
      );
    }
    return new Promise((resolve) => {
      this.waiters.push(() => resolve(this.makeRelease()));
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

const gitSubprocessLimiter = new GitSubprocessLimiter(4, 64);

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface GitRepositoryContext {
  root: string;
  workspacePrefix: string;
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.includes("\0") || isAbsolute(path)) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

async function resolveWorkspaceFile(
  root: string,
  path: string,
): Promise<{
  root: string;
  path: string;
  absolutePath: string;
  device: number;
  inode: number;
}> {
  if (!isSafeRelativePath(path)) {
    throw new WorkspaceInspectionError(400, "invalid workspace-relative file path");
  }
  const canonicalRoot = await realpath(root).catch(() => {
    throw new WorkspaceInspectionError(404, "workspace root is unavailable");
  });
  const candidate = resolve(canonicalRoot, path);
  if (!isContained(canonicalRoot, candidate)) {
    throw new WorkspaceInspectionError(400, "file path escapes the workspace root");
  }
  const fileInfo = await lstat(candidate).catch(() => {
    throw new WorkspaceInspectionError(404, "workspace file was not found");
  });
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
    throw new WorkspaceInspectionError(422, "workspace preview only supports regular files");
  }
  const canonicalFile = await realpath(candidate).catch(() => {
    throw new WorkspaceInspectionError(404, "workspace file was not found");
  });
  if (!isContained(canonicalRoot, canonicalFile)) {
    throw new WorkspaceInspectionError(400, "file path escapes the workspace root");
  }
  return {
    root: canonicalRoot,
    path,
    absolutePath: canonicalFile,
    device: fileInfo.dev,
    inode: fileInfo.ino,
  };
}

async function readBoundedFile(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) {
    throw new WorkspaceInspectionError(
      413,
      `workspace file exceeds the ${maxBytes} byte preview limit`,
    );
  }
  return buffer.subarray(0, offset);
}

export async function collectBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new WorkspaceInspectionError(413, "git output exceeded the preview limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    totalBytes,
  );
}

async function runGit(
  root: string,
  args: string[],
  disableRepositoryFilters = true,
  timeoutMs = GIT_TIMEOUT_MS,
  stdin?: string,
): Promise<GitResult> {
  const startedAt = Date.now();
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  });
  const filterConfigArgs = disableRepositoryFilters
    ? await gitFilterConfigArgs(root, timeoutMs)
    : [];
  return await gitSubprocessLimiter.run(async () => {
    const commandTimeoutMs = timeoutMs - (Date.now() - startedAt);
    if (commandTimeoutMs <= 0) {
      throw new WorkspaceInspectionError(500, "git command timed out");
    }
    const child = Bun.spawn(
      [
        "git",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "color.ui=false",
        "-c",
        "color.diff=false",
        "-c",
        "diff.ignoreSubmodules=all",
        ...filterConfigArgs,
        "-C",
        root,
        ...args,
      ],
      {
        env,
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, commandTimeoutMs);
    try {
      const [code, stdoutBytes, stderrBytes] = await Promise.all([
        child.exited,
        collectBoundedStream(child.stdout, MAX_GIT_OUTPUT_BYTES),
        collectBoundedStream(child.stderr, MAX_GIT_OUTPUT_BYTES),
      ]);
      if (timedOut) throw new WorkspaceInspectionError(500, "git command timed out");
      return {
        code,
        stdout: new TextDecoder().decode(stdoutBytes),
        stderr: new TextDecoder().decode(stderrBytes),
      };
    } catch (error) {
      child.kill();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  });
}

async function gitFilterConfigArgs(root: string, timeoutMs: number): Promise<string[]> {
  const result = await runGit(
    root,
    [
      "config",
      "--includes",
      "-z",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|process|required|smudge)$",
    ],
    false,
    timeoutMs,
  );
  if (result.code !== 0) return [];
  const drivers = new Set<string>();
  for (const key of result.stdout.split("\0")) {
    const driver = key.match(/^filter\.(.+)\.(?:clean|process|required|smudge)$/)?.[1];
    if (!driver) continue;
    if (driver.includes("=")) {
      throw new WorkspaceInspectionError(422, "unsupported Git filter configuration");
    }
    drivers.add(driver);
  }
  return [...drivers].flatMap((driver) => [
    "-c",
    `filter.${driver}.clean=`,
    "-c",
    `filter.${driver}.process=`,
    "-c",
    `filter.${driver}.required=false`,
    "-c",
    `filter.${driver}.smudge=`,
  ]);
}

async function gitRepositoryContext(root: string): Promise<GitRepositoryContext | null> {
  const canonicalRoot = await realpath(root).catch(() => null);
  if (!canonicalRoot) return null;
  let checkoutRoot = canonicalRoot;
  while (true) {
    const marker = await lstat(resolve(checkoutRoot, ".git")).catch(() => null);
    if (marker?.isDirectory() || marker?.isFile()) break;
    const parent = dirname(checkoutRoot);
    if (parent === checkoutRoot) return null;
    checkoutRoot = parent;
  }
  const result = await runGit(canonicalRoot, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) return null;
  const repositoryRoot = await realpath(result.stdout.trim()).catch(() => null);
  if (
    !repositoryRoot ||
    repositoryRoot !== checkoutRoot ||
    !isContained(repositoryRoot, canonicalRoot)
  ) {
    return null;
  }
  return {
    root: repositoryRoot,
    workspacePrefix: relative(repositoryRoot, canonicalRoot).split(sep).join("/"),
  };
}

export async function resolveWorkspaceRoot(
  worktreeRoot: string | undefined,
  paneCwds: string[],
): Promise<string> {
  const unsafeRoots = new Set([
    parse(resolve(sep)).root,
    await realpath(homedir()).catch(() => resolve(homedir())),
  ]);
  if (worktreeRoot) {
    const canonicalRoot = await realpath(worktreeRoot).catch(() => {
      throw new WorkspaceInspectionError(404, "workspace root is unavailable");
    });
    if (unsafeRoots.has(canonicalRoot)) {
      throw new WorkspaceInspectionError(422, "workspace root is too broad to inspect safely");
    }
    const context = await gitRepositoryContext(canonicalRoot);
    if (!context || context.root !== canonicalRoot) {
      throw new WorkspaceInspectionError(422, "worktree metadata is not a trustworthy checkout root");
    }
    return canonicalRoot;
  }

  const repositoryRoots = new Set<string>();
  for (const cwd of new Set(paneCwds.filter(Boolean))) {
    const context = await gitRepositoryContext(cwd);
    if (context && !unsafeRoots.has(context.root)) repositoryRoots.add(context.root);
  }
  if (repositoryRoots.size > 1) {
    throw new WorkspaceInspectionError(
      422,
      "Workspace inspection is unavailable because this space spans multiple Git repositories.",
    );
  }
  if (repositoryRoots.size === 0) {
    throw new WorkspaceInspectionError(
      422,
      "workspace inspection requires one trustworthy Git or worktree root",
    );
  }
  return [...repositoryRoots][0]!;
}

async function isGitRepository(root: string): Promise<boolean> {
  return (await gitRepositoryContext(root)) !== null;
}

function gitPathspec(path: string): string {
  return `:(literal,top)${path}`;
}

function workspacePath(repositoryPath: string, workspacePrefix: string): string | null {
  const path = workspacePrefix
    ? repositoryPath.startsWith(`${workspacePrefix}/`)
      ? repositoryPath.slice(workspacePrefix.length + 1)
      : null
    : repositoryPath;
  return path && isSafeRelativePath(path) ? path : null;
}

function workspaceScopeArgs(workspacePrefix: string): string[] {
  return workspacePrefix ? ["--", gitPathspec(workspacePrefix)] : [];
}

async function listFallback(root: string): Promise<{
  entries: WorkspaceFileEntry[];
  truncated: boolean;
}> {
  const canonicalRoot = await realpath(root).catch(() => {
    throw new WorkspaceInspectionError(404, "workspace root is unavailable");
  });
  const entries: WorkspaceFileEntry[] = [];
  const pending = [canonicalRoot];
  let truncated = false;

  while (pending.length > 0) {
    const directory = pending.pop()!;
    const children = await readdir(directory, { withFileTypes: true }).catch(() => []);
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory() && IGNORED_DIRECTORY_NAMES.has(child.name)) continue;
      const absolutePath = resolve(directory, child.name);
      const workspacePath = relative(canonicalRoot, absolutePath).split(sep).join("/");
      if (!isSafeRelativePath(workspacePath)) continue;
      if (child.isDirectory()) {
        entries.push({ path: workspacePath, kind: "directory" });
        pending.push(absolutePath);
      } else if (child.isFile()) {
        entries.push({ path: workspacePath, kind: "file" });
      }
      if (entries.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        pending.length = 0;
        break;
      }
    }
  }
  return { entries, truncated };
}

export async function listWorkspaceFiles(root: string): Promise<{
  root: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
}> {
  const canonicalRoot = await realpath(root).catch(() => {
    throw new WorkspaceInspectionError(404, "workspace root is unavailable");
  });
  if (!(await isGitRepository(canonicalRoot))) {
    return { root: canonicalRoot, ...(await listFallback(canonicalRoot)) };
  }

  const context = await gitRepositoryContext(canonicalRoot);
  if (!context) return { root: canonicalRoot, ...(await listFallback(canonicalRoot)) };
  const result = await runGit(context.root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    ...workspaceScopeArgs(context.workspacePrefix),
  ]);
  if (result.code !== 0) {
    throw new WorkspaceInspectionError(500, "git file enumeration failed");
  }
  const paths = [
    ...new Set(
      result.stdout
        .split("\0")
        .map((path) => workspacePath(path, context.workspacePrefix))
        .filter((path): path is string => path !== null),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const entries: WorkspaceFileEntry[] = [];
  const includedPaths = new Set<string>();
  let truncated = false;
  pathLoop:
  for (const path of paths) {
    const info = await lstat(resolve(canonicalRoot, path)).catch(() => null);
    if (!info?.isFile()) continue;
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const directory = segments.slice(0, depth).join("/");
      if (includedPaths.has(directory)) continue;
      if (entries.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        break pathLoop;
      }
      entries.push({ path: directory, kind: "directory" });
      includedPaths.add(directory);
    }
    if (entries.length >= MAX_TREE_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push({ path, kind: "file" });
    includedPaths.add(path);
  }
  return {
    root: canonicalRoot,
    entries,
    truncated,
  };
}

export async function readWorkspaceFile(
  workspaceId: string,
  root: string,
  path: string,
): Promise<WorkspaceFileResponse> {
  const listing = await listWorkspaceFiles(root);
  if (!listing.entries.some((entry) => entry.kind === "file" && entry.path === path)) {
    throw new WorkspaceInspectionError(404, "workspace file was not found in the browsable tree");
  }
  const file = await resolveWorkspaceFile(root, path);
  const extension = extname(path).toLowerCase();
  const imageMediaType = IMAGE_MEDIA_TYPES[extension];
  const maxBytes = imageMediaType ? MAX_IMAGE_FILE_BYTES : MAX_TEXT_FILE_BYTES;
  const handle = await open(file.absolutePath, O_RDONLY | O_NOFOLLOW).catch(() => {
    throw new WorkspaceInspectionError(404, "workspace file was not found or changed");
  });
  try {
    const fileInfo = await handle.stat();
    if (!fileInfo.isFile()) {
      throw new WorkspaceInspectionError(422, "workspace preview only supports regular files");
    }
    if (fileInfo.dev !== file.device || fileInfo.ino !== file.inode) {
      throw new WorkspaceInspectionError(404, "workspace file was not found or changed");
    }
    if (fileInfo.size > maxBytes) {
      throw new WorkspaceInspectionError(
        413,
        `workspace file exceeds the ${maxBytes} byte preview limit`,
      );
    }
    const data = await readBoundedFile(handle, maxBytes);
    if (imageMediaType) {
      return {
        workspaceId,
        path,
        mediaType: imageMediaType,
        encoding: "base64",
        content: data.toString("base64"),
        size: data.byteLength,
      };
    }
    if (data.includes(0)) {
      throw new WorkspaceInspectionError(422, "binary file preview is not supported");
    }
    return {
      workspaceId,
      path,
      mediaType: TEXT_MEDIA_TYPES[extension] ?? "text/plain",
      encoding: "utf8",
      content: data.toString("utf8"),
      size: data.byteLength,
    };
  } finally {
    await handle.close();
  }
}

function parseBranchHeader(header: string): {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
} {
  let value = header.startsWith("## ") ? header.slice(3) : header;
  value = value.replace(/^No commits yet on /, "").replace(/^Initial commit on /, "");
  if (value === "HEAD (no branch)") {
    return { branch: null, upstream: null, ahead: 0, behind: 0 };
  }
  const counts = value.match(/ \[(.*?)\]$/)?.[1] ?? "";
  value = value.replace(/ \[.*\]$/, "");
  const [branch, upstream] = value.split("...", 2);
  const ahead = Number(counts.match(/ahead (\d+)/)?.[1] ?? 0);
  const behind = Number(counts.match(/behind (\d+)/)?.[1] ?? 0);
  return {
    branch: branch || null,
    upstream: upstream || null,
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

function statusLabel(indexStatus: string, worktreeStatus: string): string {
  const codes = `${indexStatus}${worktreeStatus}`;
  if (codes === "??") return "Untracked";
  if (codes.includes("U") || codes === "AA" || codes === "DD") return "Conflicted";
  if (codes.includes("R")) return "Renamed";
  if (codes.includes("D")) return "Deleted";
  if (codes.includes("A")) return "Added";
  if (codes.includes("M")) return "Modified";
  return "Changed";
}

interface ParsedGitFile extends WorkspaceGitFile {
  previousPath?: string;
}

export function parseGitStatus(output: string): {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: ParsedGitFile[];
} {
  const records = output.split("\0").filter(Boolean);
  const branch = parseBranchHeader(records.shift() ?? "");
  const files: ParsedGitFile[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4) continue;
    const indexStatus = record[0]!;
    const worktreeStatus = record[1]!;
    const path = record.slice(3);
    let previousPath: string | undefined;
    if (
      (indexStatus === "R" ||
        indexStatus === "C" ||
        worktreeStatus === "R" ||
        worktreeStatus === "C") &&
      index + 1 < records.length
    ) {
      previousPath = records[index + 1];
      index += 1;
    }
    if (!isSafeRelativePath(path)) continue;
    files.push({
      path,
      ...(previousPath && isSafeRelativePath(previousPath) ? { previousPath } : {}),
      status: statusLabel(indexStatus, worktreeStatus),
      indexStatus,
      worktreeStatus,
      insertions: 0,
      deletions: 0,
    });
  }
  return { ...branch, files };
}

function parseNumstat(output: string): Map<string, { insertions: number; deletions: number }> {
  const stats = new Map<string, { insertions: number; deletions: number }>();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 1 || secondTab < firstTab + 2) continue;
    const insertions = record.slice(0, firstTab);
    const deletions = record.slice(firstTab + 1, secondTab);
    if (!/^(?:\d+|-)$/.test(insertions) || !/^(?:\d+|-)$/.test(deletions)) continue;
    let path = record.slice(secondTab + 1);
    if (!path && index + 2 < records.length) {
      index += 2;
      path = records[index]!;
    }
    if (!path) continue;
    stats.set(path, {
      insertions: insertions === "-" ? 0 : Number(insertions),
      deletions: deletions === "-" ? 0 : Number(deletions),
    });
  }
  return stats;
}

function mergeNumstat(
  target: Map<string, { insertions: number; deletions: number }>,
  source: Map<string, { insertions: number; deletions: number }>,
): void {
  for (const [path, stats] of source) {
    const current = target.get(path);
    target.set(path, {
      insertions: (current?.insertions ?? 0) + stats.insertions,
      deletions: (current?.deletions ?? 0) + stats.deletions,
    });
  }
}

async function readNewWorktreeNumstat(
  root: string,
  files: ParsedGitFile[],
): Promise<Map<string, { insertions: number; deletions: number }>> {
  const candidates = files.filter((file) => file.worktreeStatus !== "D");
  if (candidates.length > MAX_NEW_FILE_NUMSTAT_FILES) {
    throw new WorkspaceInspectionError(413, "new workspace files exceed the Git preview limit");
  }
  const deadline = Date.now() + NEW_FILE_NUMSTAT_TIMEOUT_MS;
  const stats = new Map<string, { insertions: number; deletions: number }>();
  for (const file of candidates) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new WorkspaceInspectionError(413, "new workspace files exceed the Git preview budget");
    }
    const result = await runGit(
      root,
      [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        "-z",
        "--",
        "/dev/null",
        file.path,
      ],
      true,
      remainingMs,
    ).catch((error) => {
      if (error instanceof WorkspaceInspectionError && error.message === "git command timed out") {
        throw new WorkspaceInspectionError(
          413,
          "new workspace files exceed the Git preview budget",
        );
      }
      throw error;
    });
    if (result.code !== 0 && result.code !== 1) {
      throw new WorkspaceInspectionError(500, "unborn repository diff failed");
    }
    const fileStats = parseNumstat(result.stdout).values().next().value;
    if (fileStats) stats.set(file.path, fileStats);
  }
  return stats;
}

async function rejectFilterManagedFiles(root: string, files: ParsedGitFile[]): Promise<void> {
  if (files.length === 0) return;
  const result = await runGit(
    root,
    ["check-attr", "-z", "--stdin", "filter"],
    true,
    GIT_TIMEOUT_MS,
    files.map((file) => `${file.path}\0`).join(""),
  );
  if (result.code !== 0) {
    throw new WorkspaceInspectionError(500, "git attribute inspection failed");
  }
  const records = result.stdout.split("\0");
  for (let index = 0; index + 2 < records.length; index += 3) {
    const value = records[index + 2];
    if (value && value !== "unspecified" && value !== "unset") {
      throw new WorkspaceInspectionError(
        422,
        "Git inspection does not support filter-managed workspace files",
      );
    }
  }
}

type WorkspaceGitStatusInternal = Omit<WorkspaceGitStatusResponse, "files"> & {
  files: ParsedGitFile[];
};

async function inspectWorkspaceGitStatus(
  workspaceId: string,
  root: string,
): Promise<WorkspaceGitStatusInternal> {
  const canonicalRoot = await realpath(root).catch(() => {
    throw new WorkspaceInspectionError(404, "workspace root is unavailable");
  });
  if (!(await isGitRepository(canonicalRoot))) {
    return {
      workspaceId,
      isRepo: false,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      insertions: 0,
      deletions: 0,
      files: [],
    };
  }
  const context = await gitRepositoryContext(canonicalRoot);
  if (!context) throw new WorkspaceInspectionError(500, "Git repository root is unavailable");
  const statusResult = await runGit(context.root, [
    "status",
    "--porcelain=v1",
    "-z",
    "-b",
    "--ahead-behind",
    "--ignore-submodules=all",
    "--untracked-files=all",
    ...workspaceScopeArgs(context.workspacePrefix),
  ]);
  if (statusResult.code !== 0) {
    throw new WorkspaceInspectionError(500, "git status failed");
  }
  const parsed = parseGitStatus(statusResult.stdout);
  const statusPaths = new Set<string>();
  for (const file of parsed.files) {
    if (statusPaths.has(file.path)) {
      throw new WorkspaceInspectionError(
        422,
        "Git inspection does not support multiple workspace changes at one path",
      );
    }
    statusPaths.add(file.path);
  }
  await rejectFilterManagedFiles(context.root, parsed.files);
  const numstatResult = await runGit(context.root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--numstat",
    "-z",
    "HEAD",
    ...workspaceScopeArgs(context.workspacePrefix),
  ]);
  const repositoryNumstat = new Map<string, { insertions: number; deletions: number }>();
  let untrackedIncluded = false;
  if (numstatResult.code === 0) {
    mergeNumstat(repositoryNumstat, parseNumstat(numstatResult.stdout));
  } else {
    const head = await runGit(context.root, ["rev-parse", "--verify", "HEAD"]);
    if (head.code !== 0) {
      mergeNumstat(
        repositoryNumstat,
        await readNewWorktreeNumstat(
          context.root,
          parsed.files.filter(
            (file) =>
              file.indexStatus === "A" ||
              (file.indexStatus === "?" && file.worktreeStatus === "?"),
          ),
        ),
      );
      untrackedIncluded = true;
    } else {
      const baseArgs = ["--no-ext-diff", "--no-textconv", "--numstat", "-z"];
      const [cached, worktree] = await Promise.all([
        runGit(context.root, [
          "diff",
          "--cached",
          ...baseArgs,
          ...workspaceScopeArgs(context.workspacePrefix),
        ]),
        runGit(context.root, ["diff", ...baseArgs, ...workspaceScopeArgs(context.workspacePrefix)]),
      ]);
      if (cached.code !== 0 || worktree.code !== 0) {
        throw new WorkspaceInspectionError(500, "git numstat failed");
      }
      mergeNumstat(repositoryNumstat, parseNumstat(cached.stdout));
      mergeNumstat(repositoryNumstat, parseNumstat(worktree.stdout));
    }
  }
  if (!untrackedIncluded) {
    mergeNumstat(
      repositoryNumstat,
      await readNewWorktreeNumstat(
        context.root,
        parsed.files.filter(
          (file) => file.indexStatus === "?" && file.worktreeStatus === "?",
        ),
      ),
    );
  }
  const numstat = new Map<string, { insertions: number; deletions: number }>();
  for (const [path, stats] of repositoryNumstat) {
    const normalized = workspacePath(path, context.workspacePrefix);
    if (normalized) numstat.set(normalized, stats);
  }
  const files = parsed.files
    .map((file) => {
      const path = workspacePath(file.path, context.workspacePrefix);
      if (!path) return null;
      const { previousPath: repositoryPreviousPath, ...rest } = file;
      const previousPath = repositoryPreviousPath
        ? workspacePath(repositoryPreviousPath, context.workspacePrefix)
        : null;
      return {
        ...rest,
        path,
        ...(previousPath ? { previousPath } : {}),
        ...numstat.get(path),
      };
    })
    .filter((file): file is ParsedGitFile => file !== null);
  return {
    workspaceId,
    isRepo: true,
    branch: parsed.branch,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    insertions: files.reduce((total, file) => total + file.insertions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    files,
  };
}

export async function readWorkspaceGitStatus(
  workspaceId: string,
  root: string,
): Promise<WorkspaceGitStatusResponse> {
  const status = await inspectWorkspaceGitStatus(workspaceId, root);
  return {
    ...status,
    files: status.files.map(({ previousPath: _previousPath, ...file }) => file),
  };
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const data = Buffer.from(value);
  if (data.byteLength <= maxBytes) return { value, truncated: false };
  return { value: data.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export async function readWorkspaceGitDiff(
  workspaceId: string,
  root: string,
  path: string,
): Promise<WorkspaceGitDiffResponse> {
  if (!isSafeRelativePath(path)) {
    throw new WorkspaceInspectionError(400, "invalid workspace-relative diff path");
  }
  const canonicalRoot = await realpath(root).catch(() => {
    throw new WorkspaceInspectionError(404, "workspace root is unavailable");
  });
  const status = await inspectWorkspaceGitStatus(workspaceId, canonicalRoot);
  const file = status.files.find((candidate) => candidate.path === path);
  if (!file) throw new WorkspaceInspectionError(404, "changed workspace file was not found");

  let patch = "";
  if (file.status === "Untracked") {
    const result = await runGit(canonicalRoot, [
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=3",
      "--",
      "/dev/null",
      path,
    ]);
    if (result.code === 0) patch = `Untracked empty file ${path}.`;
    else if (result.code === 1) patch = result.stdout;
    else throw new WorkspaceInspectionError(500, "untracked file diff failed");
  } else {
    const context = await gitRepositoryContext(canonicalRoot);
    if (!context) throw new WorkspaceInspectionError(500, "Git repository root is unavailable");
    const literalPathspecs = [file.previousPath, path]
      .filter((candidate): candidate is string => candidate !== undefined)
      .map((candidate) =>
        gitPathspec(
          context.workspacePrefix ? `${context.workspacePrefix}/${candidate}` : candidate,
        ),
      );
    const result = await runGit(context.root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=3",
      "HEAD",
      "--",
      ...literalPathspecs,
    ]);
    if (result.code === 0) {
      patch = result.stdout;
    } else if (file.status === "Added") {
      const againstEmpty = await runGit(canonicalRoot, [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--unified=3",
        "--",
        "/dev/null",
        path,
      ]);
      if (againstEmpty.code === 0) patch = `Added empty file ${path}.`;
      else if (againstEmpty.code === 1) patch = againstEmpty.stdout;
      else throw new WorkspaceInspectionError(500, "added file diff failed");
    } else if (file.indexStatus === "A" && file.worktreeStatus === "D") {
      const head = await runGit(context.root, ["rev-parse", "--verify", "HEAD"]);
      if (head.code === 0) {
        throw new WorkspaceInspectionError(500, "tracked file diff failed");
      }
      patch = "";
    } else {
      throw new WorkspaceInspectionError(500, "tracked file diff failed");
    }
  }
  const bounded = truncateUtf8(
    patch || `No textual diff is available for ${path}.`,
    MAX_DIFF_BYTES,
  );
  return { workspaceId, path, patch: bounded.value, truncated: bounded.truncated };
}
