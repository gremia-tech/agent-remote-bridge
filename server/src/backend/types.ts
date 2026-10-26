export interface PaneIdentity {
  paneId: string;
  identityToken: string;
  revision: number;
  agent?: string;
  status?: string;
}

export interface TerminalFrame {
  type: "pane_frame";
  paneId: string;
  identityToken: string;
  seq: number;
  full: boolean;
  width: number;
  height: number;
  bytes: string;
}

export interface TerminalHandle {
  command(value: Record<string, unknown>): Promise<void>;
  close(): void;
}

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  kind: "message" | "tool_call" | "tool_result" | "notice";
  text: string;
  timestamp?: string;
  toolName?: string;
}

export interface HostBackend {
  snapshot(session?: string): Promise<Record<string, unknown>>;
  identity(session: string | undefined, paneId: string): Promise<PaneIdentity>;
  output(session: string | undefined, paneId: string, lines?: number): Promise<Record<string, unknown>>;
  transcript(session: string | undefined, paneId: string, cursor?: string, tail?: boolean): Promise<Record<string, unknown>>;
  git(session: string | undefined, workspaceId: string, paneId?: string): Promise<Record<string, unknown>>;
  diff(session: string | undefined, workspaceId: string, path: string, paneId?: string): Promise<Record<string, unknown>>;
  files(session: string | undefined, workspaceId: string, path: string, paneId?: string): Promise<Record<string, unknown>>;
  file(session: string | undefined, workspaceId: string, path: string, paneId?: string): Promise<Record<string, unknown>>;
  terminal(options: {
    session?: string; paneId: string; expectedIdentityToken?: string; control: boolean; takeover: boolean; cols: number; rows: number;
    onFrame(frame: TerminalFrame): void; onClose(reason: string): void;
  }): Promise<TerminalHandle>;
  /** Exact pseudo-terminal size of a pane, so remote views can match the computer instead of cropping it. */
  paneSize?(session: string | undefined, paneId: string): Promise<{ cols: number; rows: number }>;
  submitText(session: string | undefined, paneId: string, text: string, submit: boolean, expectedIdentityToken?: string): Promise<unknown>;
  mutate(kind: "workspace.create" | "tab.create" | "pane.split" | "pane.close" | "agent.start",
         session: string | undefined, body: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export class BackendError extends Error {
  constructor(public code: string, message: string, public status = 503, public deliveryAmbiguous = false) {
    super(message);
  }
}
