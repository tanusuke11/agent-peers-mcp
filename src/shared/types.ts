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
export type AgentType = "claude-code" | "codex" | "generic";

/** How the peer connects: terminal-based MCP server or IDE extension */
export type PeerSource = "terminal" | "extension";

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
  /** Files that were already modified when the agent registered (baseline) */
  baselineModifiedFiles?: string[];
  diff?: string; // abbreviated diff
}


/** Structured description of what an agent is currently doing (for conflict detection) */
export interface TaskIntent {
  /** What the peer is doing (from session title + currentTask) */
  description: string;
  /** Files being modified: (git modified - baseline) + activeFiles */
  targetFiles: string[];
  /** Directories/modules being touched (e.g. "src/broker") */
  targetAreas: string[];
  /** High-level action: "refactor" | "add" | "fix" | "delete" | "update" */
  action: string;
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
  /** Structured task intent for conflict detection */
  taskIntent?: TaskIntent;
  /** Recent conversation as a single markdown document */
  recentContext?: string;
  /** AI-generated 1-2 sentence digest of the recent conversation */
  conversationDigest?: string;
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
  /** How the peer connects: "terminal" (MCP server) or "extension" (VSCode extension) */
  source: PeerSource;
  /** Structured context shared by this peer */
  context: AgentContext;
  /** When the peer first registered */
  registeredAt: string;
  /** When the peer last sent a heartbeat */
  lastSeen: string;
  /** Whether the peer is connected via MCP (true) or discovered via process scan (false) */
  connected?: boolean;
  /** Whether the peer is sleeping (session ended, data retained) */
  suspended?: boolean;
  /** Total number of messages stored for this peer in the sidebar */
  totalMessages?: number;
}

// ─── Messages ──────────────────────────────────────────────────

export type MessageType = "text" | "context-request" | "context-response" | "task-handoff" | "report";

export interface Message {
  id: number;
  fromId: PeerId;
  toId: PeerId;
  type: MessageType;
  text: string;
  /** Structured payload (e.g. context snapshot for context-response) */
  payload?: Record<string, unknown>;
  /** ID of the message this is a reply to (used by "report" type to link to original task-handoff) */
  replyTo?: number;
  sentAt: string;
  delivered: boolean;
}

// ─── Broker API Request/Response ───────────────────────────────

export interface RegisterRequest {
  /** Request a specific ID (persisted from a previous session) */
  preferredId?: string;
  agentType: AgentType;
  /** How the peer connects: "terminal" (MCP server) or "extension" (VSCode extension). Defaults to "terminal". */
  source?: PeerSource;
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
  /** Owner (CLI session) PID — used to resume sleeping peers and update liveness */
  pid?: number;
  /** How the peer connects: "terminal" or "extension" */
  source?: PeerSource;
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
  /** ID of the message this is a reply to (used by "report" type to link to original task-handoff) */
  replyTo?: number;
  /** When true, skip duplicate task-handoff detection and send anyway */
  force?: boolean;
  /** When true, this message is initiated by a user (not peer-to-peer autonomous) */
  fromUser?: boolean;
}

/** A duplicate task-handoff that was detected */
export interface DuplicateTaskInfo {
  /** The peer already working on a similar task */
  peerId: PeerId;
  agentType: string;
  /** That peer's current task or the task-handoff message text */
  taskDescription: string;
  /** Why this was flagged as duplicate */
  reason: string;
  confidence: "high" | "medium" | "low";
}

export interface SendMessageResponse {
  ok: boolean;
  error?: string;
  /** Present when a task-handoff was blocked due to duplicates (use force to override) */
  duplicates?: DuplicateTaskInfo[];
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  /** false if the peer ID was not found in the broker (e.g. after a purge) */
  found: boolean;
  messages: Message[];
}

export interface BrokerHealthResponse {
  status: "ok";
  pid: number;
  peerCount: number;
  uptime: number;
  autoConflictCheck?: boolean;
  maxContextLength?: number;
}

// ─── WebSocket Events (real-time push) ─────────────────────────

export type WsEventType =
  | "message"         // new message received
  | "peer-joined"     // a peer joined the network
  | "peer-left"       // a peer left the network
  | "context-updated" // a peer updated their context
  | "wake"            // wake up signal to deliver pending messages
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

// ─── Conflict Detection ───────────────────────────────────────

export interface CheckConflictsRequest {
  prompt: string;
  callerId: string;
  gitRoot: string | null;
}

export interface ConflictResult {
  peerId: string;
  agentType: string;
  summary: string;
  taskIntent: TaskIntent;
  reason: string;
  confidence: "high" | "medium" | "low";
}

export interface CheckConflictsResponse {
  conflicts: ConflictResult[];
}
