/**
 * Git and file context utilities
 * Used by both the MCP server and VSCode extension
 */

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import type { ActiveFile, GitContext } from "./types.ts";

const execFileAsync = promisify(execFile);

/** Run a command and return stdout, or null on failure */
async function run(cmd: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd[0]!, cmd.slice(1), { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function getGitRoot(cwd: string): Promise<string | null> {
  return run(["git", "rev-parse", "--show-toplevel"], cwd);
}

export async function getGitBranch(cwd: string): Promise<string | null> {
  return run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

export async function getModifiedFiles(cwd: string): Promise<string[]> {
  const out = await run(["git", "diff", "--name-only"], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

export async function getStagedFiles(cwd: string): Promise<string[]> {
  const out = await run(["git", "diff", "--cached", "--name-only"], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

export async function getRecentCommits(cwd: string, count = 5): Promise<string[]> {
  const out = await run(["git", "log", `--oneline`, `-${count}`], cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

export async function getAbbreviatedDiff(cwd: string, maxLines = 50): Promise<string | null> {
  const out = await run(["git", "diff", "--stat"], cwd);
  if (!out) return null;
  const lines = out.split("\n");
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more lines)`;
  }
  return out;
}

// Cache for gatherGitContext — skip git commands if .git/index hasn't changed
let _cachedGitContext: GitContext | null = null;
let _cachedGitRoot: string | null = null;
let _cachedIndexMtimeMs = 0;
let _cachedHeadMtimeMs = 0;

export async function gatherGitContext(cwd: string): Promise<GitContext | null> {
  const root = await getGitRoot(cwd);
  if (!root) return null;

  // Check if .git/index or .git/HEAD changed since last call
  try {
    const indexMtime = fs.statSync(path.join(root, ".git", "index")).mtimeMs;
    const headMtime = fs.statSync(path.join(root, ".git", "HEAD")).mtimeMs;
    if (root === _cachedGitRoot && indexMtime === _cachedIndexMtimeMs && headMtime === _cachedHeadMtimeMs && _cachedGitContext) {
      return _cachedGitContext;
    }
    _cachedGitRoot = root;
    _cachedIndexMtimeMs = indexMtime;
    _cachedHeadMtimeMs = headMtime;
  } catch {
    // .git/index might not exist yet — proceed without cache
  }

  const [branch, modifiedFiles, stagedFiles, recentCommits, diff] = await Promise.all([
    getGitBranch(cwd),
    getModifiedFiles(cwd),
    getStagedFiles(cwd),
    getRecentCommits(cwd),
    getAbbreviatedDiff(cwd),
  ]);

  _cachedGitContext = {
    root,
    branch,
    modifiedFiles,
    stagedFiles,
    recentCommits,
    diff: diff ?? undefined,
  };
  return _cachedGitContext;
}

/** Get a session identifier for the current process (cross-platform) */
export function getTty(): string | null {
  // Check terminal-specific environment variables (all platforms)
  return (
    process.env.TERM_SESSION_ID    // macOS Terminal / iTerm2
    ?? process.env.WT_SESSION       // Windows Terminal
    ?? process.env.TMUX             // tmux (contains socket path + session id)
    ?? process.env.STY              // GNU screen
    ?? process.env.ZELLIJ_SESSION_NAME  // Zellij
    ?? (process.ppid ? String(process.ppid) : null)  // fallback: parent PID
  ) ?? null;
}

/**
 * Generate a summary using a cheap LLM (optional, requires OPENAI_API_KEY)
 */
export async function generateSummary(context: {
  cwd: string;
  gitRoot: string | null;
  gitBranch?: string | null;
  recentFiles?: string[];
}): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const parts = [`Working directory: ${context.cwd}`];
  if (context.gitRoot) parts.push(`Git repo root: ${context.gitRoot}`);
  if (context.gitBranch) parts.push(`Branch: ${context.gitBranch}`);
  if (context.recentFiles?.length) parts.push(`Recently modified files: ${context.recentFiles.join(", ")}`);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4.1-nano",
        messages: [
          { role: "system", content: "Generate a brief 1-2 sentence summary of what a developer is working on. Be specific about project name and likely task." },
          { role: "user", content: `Context:\n${parts.join("\n")}` },
        ],
        max_tokens: 100,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}
