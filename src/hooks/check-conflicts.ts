#!/usr/bin/env node
/**
 * UserPromptSubmit hook: checks for peer conflicts before Claude processes a prompt.
 *
 * Protocol:
 *   stdin  ← JSON from Claude Code: { session_id, prompt, ... }
 *   stdout → JSON: { additionalContext: "..." } if conflicts found
 *   exit 0 = success (with or without output)
 *
 * All errors exit silently (exit 0, no output) to never block the user.
 */

const BROKER_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7899", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const TIMEOUT_MS = 3000;

interface HookInput {
  session_id?: string;
  prompt?: { content?: string };
}

interface PeerEntry {
  id: string;
  pid: number;
  cwd: string;
  agentType: string;
  gitRoot: string | null;
}

interface ConflictEntry {
  peerId: string;
  agentType: string;
  summary: string;
  taskIntent: { description: string; targetFiles: string[]; action: string };
  reason: string;
  confidence: string;
  relatedMemories?: Array<{ id: number; category: string; title: string; createdAt: string }>;
}

interface AdvisoryEntry {
  memoryId: number;
  category: string;
  title: string;
  content: string;
}

async function main() {
  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) process.exit(0);

  let input: HookInput;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const promptText = input.prompt?.content;
  if (!promptText || promptText.length < 10) process.exit(0);

  // Check broker is alive and auto-conflict-check is enabled
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) process.exit(0);
    const health = (await res.json()) as { autoConflictCheck?: boolean };
    if (health.autoConflictCheck === false) process.exit(0);
  } catch {
    process.exit(0);
  }

  // Find our own peer entry by matching cwd + agentType
  let callerId = "";
  let gitRoot: string | null = null;
  try {
    const res = await fetch(`${BROKER_URL}/list-peers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "machine", cwd: process.cwd(), gitRoot: null }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const peers = (await res.json()) as PeerEntry[];
      const cwd = process.cwd();
      const self = peers.find(p => p.cwd === cwd && p.agentType === "claude-code");
      if (self) {
        callerId = self.id;
        gitRoot = self.gitRoot;
      } else if (peers.length > 0) {
        gitRoot = peers[0]!.gitRoot;
      }
    }
  } catch {
    process.exit(0);
  }

  // Check for conflicts
  try {
    const res = await fetch(`${BROKER_URL}/check-conflicts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: promptText, callerId, gitRoot }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) process.exit(0);

    const result = (await res.json()) as { conflicts: ConflictEntry[]; advisories?: AdvisoryEntry[] };
    const hasConflicts = result.conflicts && result.conflicts.length > 0;
    const hasAdvisories = result.advisories && result.advisories.length > 0;
    if (!hasConflicts && !hasAdvisories) process.exit(0);

    // Format conflict context for Claude
    const lines: string[] = [];
    if (hasConflicts) {
      lines.push("[Agent Peers] Potential conflict detected with other AI agent(s) in this repo:\n");
      for (const c of result.conflicts) {
        lines.push(`- Peer "${c.peerId}" (${c.agentType}): ${c.summary}`);
        lines.push(`  Working on: ${c.taskIntent.description}`);
        const files = c.taskIntent.targetFiles.slice(0, 5);
        lines.push(`  Files: ${files.join(", ")}${c.taskIntent.targetFiles.length > 5 ? " ..." : ""}`);
        lines.push(`  Conflict: ${c.reason} (confidence: ${c.confidence})`);
        if (c.relatedMemories?.length) {
          lines.push(`  Related memories: ${c.relatedMemories.map(m => `#${m.id} [${m.category}] ${m.title}`).join("; ")}`);
        }
      }
      lines.push("");
      lines.push("Before proceeding, ask the user how to handle this conflict:");
      lines.push("1. Pause the other peer's work (use send_message to ask them to stop)");
      lines.push("2. Proceed anyway (risk merge conflicts later)");
      lines.push("3. Revise the current request to avoid overlapping files/areas");
    }
    if (hasAdvisories) {
      lines.push("");
      lines.push("[Agent Peers] Relevant repo memory (decisions/conventions):");
      for (const a of result.advisories!) {
        lines.push(`- [${a.category}] ${a.title}: ${a.content}`);
      }
    }

    process.stdout.write(JSON.stringify({ additionalContext: lines.join("\n") }));
  } catch {
    process.exit(0);
  }
}

main().catch(() => process.exit(0));
