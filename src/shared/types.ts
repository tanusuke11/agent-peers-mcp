/**
 * agent-peers shared types
 *
 * Defines the data structures for peer discovery, messaging, and
 * structured context sharing across AI agent tools.
 */

// ─── Identifiers ───────────────────────────────────────────────

/** Unique ID for each agent instance (generated on registration) */
export type PeerId = string;

/** The type of AI agent tool */
export type AgentType = "claude-code" | "codex" | "copilot-chat" | "cursor" | "generic";

// ─── Structured Context ────────────────────────────────────────

/** A file currently being worked on */
export interface ActiveFile {
  path: string;
  relativePath: string;
  languageId?: string;
  isDirty?: boolean;
}

/** Git state of the workspace */
export interface GitContext {
  root: string;
  branch: string | null;
  recentCommits?: string[];
  stagedFiles?: string[];
  modifiedFiles?: string[];
  diff?: string; // abbreviated diff
}

/** The structured context an agent shares */
export interface AgentContext {
  /** Free-text summary of current work */
  summary: string;
  /** Currently active/open files */
  activeFiles: ActiveFile[];
  /** Git repository state */
  git: GitContext | null;
  /** Current task description (if any) */
  currentTask?: string;
  /** Key-value metadata (extensible) */
  metadata?: Record<string, string>;
  /** Timestamp when context was last updated */
  updatedAt: string;
}

// ─── Peer ──────────────────────────────────────────────────────

export interface Peer {
  id: PeerId;
  /** Type of AI agent */
  agentType: AgentType;
  /** Process ID (for liveness checks) */
  pid: number;
  /** Working directory */
  cwd: string;
  /** Git repository root (null if not in a repo) */
  gitRoot: string | null;
  /** Terminal TTY (if detectable) */
  tty: string | null;
  /** Structured context shared by this peer */
  context: AgentContext;
  /** When the peer first registered */
  registeredAt: string;
  /** When the peer last sent a heartbeat */
  lastSeen: string;
}

// ─── Messages ──────────────────────────────────────────────────

export type MessageType = "text" | "context-request" | "context-response" | "task-handoff";

export interface Message {
  id: number;
  fromId: PeerId;
  toId: PeerId;
  type: MessageType;
  text: string;
  /** Structured payload (e.g. context snapshot for context-response) */
  payload?: Record<string, unknown>;
  sentAt: string;
  delivered: boolean;
}

// ─── Broker API Request/Response ───────────────────────────────

export interface RegisterRequest {
  agentType: AgentType;
  pid: number;
  cwd: string;
  gitRoot: string | null;
  tty: string | null;
  context: AgentContext;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface UpdateContextRequest {
  id: PeerId;
  context: Partial<AgentContext>;
}

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  cwd: string;
  gitRoot: string | null;
  excludeId?: PeerId;
}

export interface SendMessageRequest {
  fromId: PeerId;
  toId: PeerId;
  type: MessageType;
  text: string;
  payload?: Record<string, unknown>;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}

export interface BrokerHealthResponse {
  status: "ok";
  peerCount: number;
  uptime: number;
}

// ─── WebSocket Events (real-time push) ─────────────────────────

export type WsEventType =
  | "message"         // new message received
  | "peer-joined"     // a peer joined the network
  | "peer-left"       // a peer left the network
  | "context-updated" // a peer updated their context
  ;

export interface WsEvent {
  type: WsEventType;
  data: unknown;
  timestamp: string;
}

export interface WsMessageEvent extends WsEvent {
  type: "message";
  data: Message;
}

export interface WsPeerJoinedEvent extends WsEvent {
  type: "peer-joined";
  data: Peer;
}

export interface WsPeerLeftEvent extends WsEvent {
  type: "peer-left";
  data: { id: PeerId };
}

export interface WsContextUpdatedEvent extends WsEvent {
  type: "context-updated";
  data: { id: PeerId; context: AgentContext };
}
