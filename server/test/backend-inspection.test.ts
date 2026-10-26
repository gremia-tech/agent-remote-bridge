// Extracted from herdr-plugin-mobile-relay (MIT), Copyright (c) 2026 Altan Sarisin.
// See ../vendor/herdr-mobile-relay/LICENSE and README.md.
import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  appendFile,
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectBoundedStream,
  GitSubprocessLimiter,
  listWorkspaceFiles,
  parseGitStatus,
  readWorkspaceFile,
  readWorkspaceGitDiff,
  readWorkspaceGitStatus,
  resolveWorkspaceRoot,
  WorkspaceInspectionError,
} from "../src/backend/workspace-inspection.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "herdr-workspace-inspection-"));
  temporaryDirectories.push(path);
  return path;
}

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

describe("workspace inspection", () => {
  test("parses branch tracking and changed files from porcelain output", () => {
    const parsed = parseGitStatus(
      "## feature/files...origin/feature/files [ahead 2, behind 1]\0 M src/app.ts\0?? notes.md\0",
    );

    expect(parsed).toMatchObject({
      branch: "feature/files",
      upstream: "origin/feature/files",
      ahead: 2,
      behind: 1,
    });
    expect(parsed.files).toEqual([
      {
        path: "src/app.ts",
        status: "Modified",
        indexStatus: " ",
        worktreeStatus: "M",
        insertions: 0,
        deletions: 0,
      },
      {
        path: "notes.md",
        status: "Untracked",
        indexStatus: "?",
        worktreeStatus: "?",
        insertions: 0,
        deletions: 0,
      },
    ]);
  });

  test("consumes the previous path for a worktree-side rename", () => {
    const parsed = parseGitStatus("## main\0 R after.txt\0before.txt\0");

    expect(parsed.files).toEqual([
      {
        path: "after.txt",
        previousPath: "before.txt",
        status: "Renamed",
        indexStatus: " ",
        worktreeStatus: "R",
        insertions: 0,
        deletions: 0,
      },
    ]);
  });

  test("lists regular files while skipping dependency and symlink trees", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "src", "app.ts"), "export const app = true;\n");
    await writeFile(join(root, "node_modules", "ignored.js"), "ignored\n");
    await symlink(tmpdir(), join(root, "outside"));

    const result = await listWorkspaceFiles(root);

    expect(result.entries).toContainEqual({ path: "src/app.ts", kind: "file" });
    expect(result.entries.some((entry) => entry.path.includes("node_modules"))).toBe(false);
    expect(result.entries.some((entry) => entry.path.startsWith("outside"))).toBe(false);
  });

  test("omits deleted and symlink index entries that cannot be previewed", async () => {
    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "qa@example.com");
    git(root, "config", "user.name", "QA");
    await writeFile(join(root, "target.txt"), "content\n");
    await symlink("target.txt", join(root, "linked.txt"));
    git(root, "add", "target.txt", "linked.txt");
    git(root, "commit", "-m", "Initial files");
    await rm(join(root, "target.txt"));

    const result = await listWorkspaceFiles(root);

    expect(result.entries).toEqual([]);
  });

  test("includes parent directories for Git-backed workspace files", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await writeFile(join(root, "src", "nested", "app.ts"), "export {};\n");
    git(root, "init", "--initial-branch=main");
    git(root, "add", ".");

    const result = await listWorkspaceFiles(root);

    expect(result.entries).toContainEqual({ path: "src", kind: "directory" });
    expect(result.entries).toContainEqual({ path: "src/nested", kind: "directory" });
    expect(result.entries).toContainEqual({ path: "src/nested/app.ts", kind: "file" });
  });

  test("reads text inside the workspace and rejects traversal and symlinks", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(join(root, "README.md"), "# Project\n");
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(join(outside, "secret.txt"), join(root, "linked-secret.txt"));

    await expect(readWorkspaceFile("w1", root, "README.md")).resolves.toMatchObject({
      workspaceId: "w1",
      path: "README.md",
      encoding: "utf8",
      content: "# Project\n",
    });
    await expect(readWorkspaceFile("w1", root, "../secret.txt")).rejects.toBeInstanceOf(
      WorkspaceInspectionError,
    );
    await expect(readWorkspaceFile("w1", root, "linked-secret.txt")).rejects.toBeInstanceOf(
      WorkspaceInspectionError,
    );
  });

  test("rejects direct previews for files omitted from the browsable tree", async () => {
    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    await writeFile(join(root, ".gitignore"), ".env\n");
    await writeFile(join(root, ".env"), "SECRET=value\n");

    await expect(readWorkspaceFile("w1", root, ".git/config")).rejects.toMatchObject({
      status: 404,
    });
    await expect(readWorkspaceFile("w1", root, ".env")).rejects.toMatchObject({ status: 404 });
  });

  test("fails closed when Git file enumeration cannot read the index", async () => {
    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    await writeFile(join(root, ".gitignore"), ".env\n");
    git(root, "add", ".gitignore");
    await writeFile(join(root, ".env"), "SECRET=value\n");
    await writeFile(join(root, ".git", "index"), "not a git index\n");

    await expect(listWorkspaceFiles(root)).rejects.toMatchObject({ status: 500 });
    await expect(readWorkspaceFile("w1", root, ".env")).rejects.toMatchObject({ status: 500 });
  });

  test("returns a unified diff for a deleted file that no longer exists", async () => {
    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "qa@example.com");
    git(root, "config", "user.name", "QA");
    await writeFile(join(root, "deleted.txt"), "first\nsecond\n");
    git(root, "add", "deleted.txt");
    git(root, "commit", "-m", "Add deleted file");
    await rm(join(root, "deleted.txt"));

    const result = await readWorkspaceGitDiff("w1", root, "deleted.txt");

    expect(result.patch).toContain("deleted file mode");
    expect(result.patch).toContain("-first");
  });

  test("reports a tracked diff failure instead of returning a successful empty diff", async () => {
    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "qa@example.com");
    git(root, "config", "user.name", "QA");
    await writeFile(join(root, "tracked.txt"), "before\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "Initial file");
    const objectId = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD:tracked.txt"])
      .stdout.toString()
      .trim();
    await writeFile(join(root, "tracked.txt"), "after\n");
    await rm(join(root, ".git", "objects", objectId.slice(0, 2), objectId.slice(2)));

    await expect(readWorkspaceGitStatus("w1", root)).rejects.toMatchObject({ status: 500 });
    await expect(readWorkspaceGitDiff("w1", root, "tracked.txt")).rejects.toMatchObject({
      status: 500,
    });
  });

  test("rejects broad pane CWDs and resolves matching pane CWDs to one Git root", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "nested"));
    git(root, "init", "--initial-branch=main");

    await expect(resolveWorkspaceRoot(undefined, [tmpdir()])).rejects.toBeInstanceOf(
      WorkspaceInspectionError,
    );
    await expect(resolveWorkspaceRoot(undefined, [root, join(root, "nested")])).resolves.toBe(
      await realpath(root),
    );
  });

  test("explains when a workspace spans multiple Git repositories", async () => {
    const firstRoot = await temporaryDirectory();
    const secondRoot = await temporaryDirectory();
    git(firstRoot, "init", "--initial-branch=main");
    git(secondRoot, "init", "--initial-branch=main");

    await expect(resolveWorkspaceRoot(undefined, [firstRoot, secondRoot])).rejects.toMatchObject({
      status: 422,
      message:
        "Workspace inspection is unavailable because this space spans multiple Git repositories.",
    });
  });

  test("rejects a repository whose core.worktree expands beyond its checkout", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "project");
    await mkdir(root);
    git(root, "init", "--initial-branch=main");
    git(root, "config", "core.worktree", parent);

    await expect(resolveWorkspaceRoot(undefined, [root])).rejects.toBeInstanceOf(
      WorkspaceInspectionError,
    );
  });

  test("rejects unsafe roots supplied by worktree metadata", async () => {
    await expect(resolveWorkspaceRoot(homedir(), [])).rejects.toBeInstanceOf(
      WorkspaceInspectionError,
    );
  });

  test("validates worktree metadata against an actual checkout root", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "project");
    await mkdir(root);
    git(root, "init", "--initial-branch=main");
    git(root, "config", "core.worktree", parent);

    await expect(resolveWorkspaceRoot(parent, [root])).rejects.toBeInstanceOf(
      WorkspaceInspectionError,
    );
  });

  test("scopes Git status and diffs to a workspace rooted below the repository", async () => {
    const repository = await temporaryDirectory();
    const workspace = join(repository, "packages", "mobile");
    await mkdir(workspace, { recursive: true });
    git(repository, "init", "--initial-branch=main");
    git(repository, "config", "user.email", "qa@example.com");
    git(repository, "config", "user.name", "QA");
    await writeFile(join(repository, "outside.txt"), "outside before\n");
    await writeFile(join(workspace, "inside.txt"), "inside before\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "Initial files");
    await writeFile(join(repository, "outside.txt"), "outside after\n");
    await writeFile(join(workspace, "inside.txt"), "inside after\n");

    const status = await readWorkspaceGitStatus("w1", workspace);
    expect(status.files.map((file) => file.path)).toEqual(["inside.txt"]);

    const diff = await readWorkspaceGitDiff("w1", workspace, "inside.txt");
    expect(diff.patch).toContain("-inside before");
    expect(diff.patch).toContain("+inside after");
    expect(diff.patch).not.toContain("outside.txt");
  });

  test("returns plain patches when repository configuration forces color", async () => {
    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "qa@example.com");
    git(root, "config", "user.name", "QA");
    await writeFile(join(root, "tracked.txt"), "before\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "Initial file");
    git(root, "config", "color.diff", "always");
    await writeFile(join(root, "tracked.txt"), "after\n");

    const diff = await readWorkspaceGitDiff("w1", root, "tracked.txt");

    expect(diff.patch).not.toContain("\u001b[");
    expect(diff.patch).toContain("+after");
  });

  test("reports divergence even when repository status config disables ahead/behind", async () => {
    const origin = await temporaryDirectory();
    git(origin, "init", "--bare", "--initial-branch=main");
    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "qa@example.com");
    git(root, "config", "user.name", "QA");
    await writeFile(join(root, "tracked.txt"), "initial\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "Initial file");
    git(root, "remote", "add", "origin", origin);
    git(root, "push", "-u", "origin", "main");

    const peerParent = await temporaryDirectory();
    const peer = join(peerParent, "clone");
    const clone = Bun.spawnSync(["git", "clone", origin, peer]);
    if (clone.exitCode !== 0) throw new Error(clone.stderr.toString());
    git(peer, "config", "user.email", "qa@example.com");
    git(peer, "config", "user.name", "QA");
    await writeFile(join(peer, "remote.txt"), "remote\n");
    git(peer, "add", ".");
    git(peer, "commit", "-m", "Remote change");
    git(peer, "push", "origin", "main");

    await writeFile(join(root, "local.txt"), "local\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "Local change");
    git(root, "fetch", "origin");
    git(root, "config", "status.aheadBehind", "false");

    const status = await readWorkspaceGitStatus("w1", root);

    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(1);
  });

  test("uses Git's exact newline semantics for untracked-file diffs", async () => {
    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    await writeFile(join(root, "new.txt"), "first\nsecond\n");

    const status = await readWorkspaceGitStatus("w1", root);
    const result = await readWorkspaceGitDiff("w1", root, "new.txt");

    expect(status.files).toContainEqual(
      expect.objectContaining({ path: "new.txt", insertions: 2, deletions: 0 }),
    );
    expect(status.insertions).toBe(2);
    expect(result.patch).toContain("@@ -0,0 +1,2 @@");
    expect(result.patch).toContain("+second\n");
    expect(result.patch).not.toContain("+second\n+\n");
  });

  test("attributes numstat counts to a renamed file's destination path", async () => {
    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "qa@example.com");
    git(root, "config", "user.name", "QA");
    await writeFile(join(root, "before.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
    git(root, "add", "before.txt");
    git(root, "commit", "-m", "Add source file");
    git(root, "mv", "before.txt", "after.txt");
    await writeFile(
      join(root, "after.txt"),
      "one\ntwo changed\nthree\nfour\nfive\nsix\nseven\neight\n",
    );

    const status = await readWorkspaceGitStatus("w1", root);

    expect(status.files).toContainEqual(
      expect.objectContaining({ path: "after.txt", insertions: 1, deletions: 1 }),
    );
    const diff = await readWorkspaceGitDiff("w1", root, "after.txt");
    expect(diff.patch).toContain("rename from before.txt");
    expect(diff.patch).toContain("rename to after.txt");
    expect(diff.patch).toContain("-two");
    expect(diff.patch).toContain("+two changed");
  });

  test("counts staged additions before a repository has its first commit", async () => {
    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    await writeFile(join(root, "first.txt"), "one\ntwo\n");
    git(root, "add", "first.txt");
    await writeFile(join(root, "first.txt"), "one\ntwo\nthree\n");

    const status = await readWorkspaceGitStatus("w1", root);

    expect(status.files).toContainEqual(
      expect.objectContaining({ path: "first.txt", insertions: 3, deletions: 0 }),
    );
    expect(status.insertions).toBe(3);
    const diff = await readWorkspaceGitDiff("w1", root, "first.txt");
    expect(diff.patch).toContain("+three");
  });

  test("counts the final worktree state on an unborn branch", async () => {
    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    await writeFile(join(root, "first.txt"), "staged\n");
    git(root, "add", "first.txt");
    await writeFile(join(root, "first.txt"), "worktree\n");

    const status = await readWorkspaceGitStatus("w1", root);

    expect(status.files).toContainEqual(
      expect.objectContaining({ path: "first.txt", insertions: 1, deletions: 0 }),
    );
    expect(status.insertions).toBe(1);
    expect(status.deletions).toBe(0);
  });

  test("returns an empty final diff for an added-then-deleted unborn file", async () => {
    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    await writeFile(join(root, "vanished.txt"), "staged\n");
    git(root, "add", "vanished.txt");
    await rm(join(root, "vanished.txt"));

    const diff = await readWorkspaceGitDiff("w1", root, "vanished.txt");

    expect(diff.patch).toBe("No textual diff is available for vanished.txt.");
  });

  test("does not substitute a staged patch when the worktree matches HEAD", async () => {
    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "qa@example.com");
    git(root, "config", "user.name", "QA");
    await writeFile(join(root, "tracked.txt"), "head\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "Initial file");
    await writeFile(join(root, "tracked.txt"), "staged\n");
    git(root, "add", "tracked.txt");
    await writeFile(join(root, "tracked.txt"), "head\n");

    const diff = await readWorkspaceGitDiff("w1", root, "tracked.txt");

    expect(diff.patch).toBe("No textual diff is available for tracked.txt.");
  });

  test("rejects duplicate status paths instead of doubling or hiding their changes", async () => {
    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "qa@example.com");
    git(root, "config", "user.name", "QA");
    await writeFile(join(root, "tracked.txt"), "before\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "Initial file");
    git(root, "rm", "--cached", "tracked.txt");
    await writeFile(join(root, "tracked.txt"), "after\n");

    await expect(readWorkspaceGitStatus("w1", root)).rejects.toMatchObject({ status: 422 });
    await expect(readWorkspaceGitDiff("w1", root, "tracked.txt")).rejects.toMatchObject({
      status: 422,
    });
  });

  test("preserves literal backslashes in POSIX Git filenames", async () => {
    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    const path = "foo\\bar.txt";
    await writeFile(join(root, path), "content\n");

    const files = await listWorkspaceFiles(root);

    expect(files.entries).toContainEqual({ path, kind: "file" });
  });

  test("preserves numstat counts for POSIX filenames containing newlines", async () => {
    const root = await temporaryDirectory();
    const path = "line\nbreak.txt";
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "qa@example.com");
    git(root, "config", "user.name", "QA");
    await writeFile(join(root, path), "before\n");
    git(root, "add", path);
    git(root, "commit", "-m", "Initial file");
    await writeFile(join(root, path), "after\n");

    const status = await readWorkspaceGitStatus("w1", root);

    expect(status.files).toContainEqual(
      expect.objectContaining({ path, insertions: 1, deletions: 1 }),
    );
  });

  test("does not execute a repository-configured fsmonitor hook", async () => {
    const root = await temporaryDirectory();
    const marker = join(root, "fsmonitor-ran");
    const hook = join(root, "fsmonitor.sh");
    git(root, "init", "--initial-branch=main");
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(hook, 0o700);
    git(root, "config", "core.fsmonitor", hook);

    await readWorkspaceGitStatus("w1", root);

    await expect(access(marker)).rejects.toBeDefined();
  });

  test("rejects filter-managed files without executing repository-configured filters", async () => {
    const root = await temporaryDirectory();
    const marker = join(root, "filter-ran");
    const filter = join(root, "filter.sh");
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "qa@example.com");
    git(root, "config", "user.name", "QA");
    await writeFile(join(root, "tracked.txt"), "before\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "Add tracked file");
    await writeFile(filter, `#!/bin/sh\ncat\ntouch '${marker}'\n`);
    await chmod(filter, 0o700);
    await writeFile(join(root, ".gitattributes"), "*.txt filter=hostile\n");
    git(root, "config", "filter.hostile.clean", filter);
    git(root, "config", "filter.hostile.process", filter);
    git(root, "config", "filter.hostile.required", "true");
    await writeFile(join(root, "tracked.txt"), "after\n");

    await expect(readWorkspaceGitStatus("w1", root)).rejects.toMatchObject({ status: 422 });

    await expect(access(marker)).rejects.toBeDefined();
  });

  test("rejects ambiguous filter driver names without executing their commands", async () => {
    const root = await temporaryDirectory();
    const marker = join(root, "ambiguous-filter-ran");
    const filter = join(root, "ambiguous-filter.sh");
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "qa@example.com");
    git(root, "config", "user.name", "QA");
    await writeFile(join(root, "tracked.txt"), "before\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "Add tracked file");
    await writeFile(filter, `#!/bin/sh\ncat\ntouch '${marker}'\n`);
    await chmod(filter, 0o700);
    await writeFile(join(root, ".gitattributes"), "*.txt filter=hostile=x\n");
    await appendFile(join(root, ".git", "config"), `\n[filter "hostile=x"]\n\tclean = ${filter}\n`);
    await writeFile(join(root, "tracked.txt"), "after!\n");
    git(root, "status", "--porcelain");
    await access(marker);
    await rm(marker);
    await writeFile(join(root, "tracked.txt"), "again!\n");

    await expect(readWorkspaceGitStatus("w1", root)).rejects.toMatchObject({ status: 422 });
    await expect(access(marker)).rejects.toBeDefined();
  });

  test("does not execute worktree-scoped clean or process filters", async () => {
    const root = await temporaryDirectory();
    const marker = join(root, "worktree-filter-ran");
    const filter = join(root, "worktree-filter.sh");
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "qa@example.com");
    git(root, "config", "user.name", "QA");
    await writeFile(join(root, "tracked.txt"), "before\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "Add tracked file");
    await writeFile(filter, `#!/bin/sh\ncat\ntouch '${marker}'\n`);
    await chmod(filter, 0o700);
    await writeFile(join(root, ".gitattributes"), "*.txt filter=hostile\n");
    git(root, "config", "extensions.worktreeConfig", "true");
    git(root, "config", "--worktree", "filter.hostile.clean", filter);
    await writeFile(join(root, "tracked.txt"), "after\n");

    await expect(readWorkspaceGitStatus("w1", root)).rejects.toMatchObject({ status: 422 });

    await expect(access(marker)).rejects.toBeDefined();
  });

  test("does not lazy-fetch missing objects through repository-configured transports", async () => {
    const root = await temporaryDirectory();
    const marker = join(root, "lazy-fetch-ran");
    const transport = join(root, "transport.sh");
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "qa@example.com");
    git(root, "config", "user.name", "QA");
    await writeFile(join(root, "tracked.txt"), "before\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "Initial file");
    const objectId = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD:tracked.txt"])
      .stdout.toString()
      .trim();
    await rm(join(root, ".git", "objects", objectId.slice(0, 2), objectId.slice(2)));
    await writeFile(transport, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await chmod(transport, 0o700);
    git(root, "config", "protocol.ext.allow", "always");
    git(root, "config", "remote.origin.url", `ext::${transport}`);
    git(root, "config", "remote.origin.promisor", "true");
    git(root, "config", "remote.origin.partialclonefilter", "blob:none");
    await writeFile(join(root, "tracked.txt"), "after\n");

    Bun.spawnSync(["git", "-C", root, "cat-file", "-p", objectId]);
    await access(marker);
    await rm(marker);

    await expect(readWorkspaceGitStatus("w1", root)).rejects.toMatchObject({ status: 500 });
    await expect(access(marker)).rejects.toBeDefined();
  });

  test("does not descend into submodules with independent filter configuration", async () => {
    const submoduleSource = await temporaryDirectory();
    git(submoduleSource, "init", "--initial-branch=main");
    git(submoduleSource, "config", "user.email", "qa@example.com");
    git(submoduleSource, "config", "user.name", "QA");
    await writeFile(join(submoduleSource, ".gitattributes"), "*.txt filter=hostile\n");
    await writeFile(join(submoduleSource, "tracked.txt"), "before\n");
    git(submoduleSource, "add", ".");
    git(submoduleSource, "commit", "-m", "Initial submodule");

    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    git(root, "config", "user.email", "qa@example.com");
    git(root, "config", "user.name", "QA");
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", submoduleSource, "vendor");
    git(root, "commit", "-m", "Add submodule");

    const marker = join(root, "submodule-filter-ran");
    const filter = join(root, "submodule-filter.sh");
    const submodule = join(root, "vendor");
    await writeFile(filter, `#!/bin/sh\ncat\ntouch '${marker}'\n`);
    await chmod(filter, 0o700);
    git(submodule, "config", "filter.hostile.clean", filter);
    await writeFile(join(submodule, "tracked.txt"), "after\n");

    const status = await readWorkspaceGitStatus("w1", root);

    expect(status.files.some((file) => file.path === "vendor")).toBe(false);
    await expect(access(marker)).rejects.toBeDefined();
  });

  test("bounds per-file numstat work for a large unborn repository", async () => {
    const root = await temporaryDirectory();
    git(root, "init", "--initial-branch=main");
    await Promise.all(
      Array.from({ length: 257 }, (_, index) =>
        writeFile(join(root, `file-${index.toString().padStart(3, "0")}.txt`), "content\n"),
      ),
    );
    git(root, "add", ".");

    await expect(readWorkspaceGitStatus("w1", root)).rejects.toMatchObject({ status: 413 });
  });

  test("stops collecting a stream as soon as its byte limit is exceeded", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(collectBoundedStream(stream, 5)).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
  });

  test("bounds active and queued Git subprocess work", async () => {
    const limiter = new GitSubprocessLimiter(1, 1);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = limiter.run(async () => await firstGate);
    const second = limiter.run(async () => undefined);
    await Promise.resolve();

    await expect(limiter.run(async () => undefined)).rejects.toMatchObject({ status: 429 });

    releaseFirst();
    await Promise.all([first, second]);
  });
});
