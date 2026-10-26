// Extracted from herdr-plugin-mobile-relay (MIT), Copyright (c) 2026 Altan Sarisin.
// Full license and source revision: ../../vendor/herdr-mobile-relay/.
export interface WorkspaceFileEntry {
  path: string;
  kind: "file" | "directory";
}

/** GET /api/workspace/:id/files — a bounded, workspace-root-relative project tree. */
export interface WorkspaceFilesResponse {
  workspaceId: string;
  root: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
}

/** GET /api/workspace/:id/file?path=... — a bounded text or image preview. */
export interface WorkspaceFileResponse {
  workspaceId: string;
  path: string;
  mediaType: string;
  encoding: "utf8" | "base64";
  content: string;
  size: number;
}

export interface WorkspaceGitFile {
  path: string;
  status: string;
  indexStatus: string;
  worktreeStatus: string;
  insertions: number;
  deletions: number;
}

/** GET /api/workspace/:id/git — local, read-only repository state. */
export interface WorkspaceGitStatusResponse {
  workspaceId: string;
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  insertions: number;
  deletions: number;
  files: WorkspaceGitFile[];
}

/** GET /api/workspace/:id/diff?path=... — a bounded unified patch. */
export interface WorkspaceGitDiffResponse {
  workspaceId: string;
  path: string;
  patch: string;
  truncated: boolean;
}

/** A freshly-created shell pane — enough for the client to navigate into before the next poll. */
