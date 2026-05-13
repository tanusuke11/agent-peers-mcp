/**
 * Memory compression module
 *
 * Only short-lived task memory is extracted from session state.
 * Long memory should come from canonical/manual sources, not freeform chat.
 */

import type { GitContext, ExtractedMemory } from "./types.ts";

const SHORT_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;

function computeAreas(files: string[]): string[] {
  const areas = new Set<string>();
  for (const f of files) {
    const parts = f.replace(/\\/g, "/").split("/");
    if (parts.length > 1) {
      areas.add(parts.slice(0, Math.min(2, parts.length - 1)).join("/"));
    }
  }
  return [...areas];
}

function getAgentModifiedFiles(git: GitContext | null): string[] {
  if (!git) return [];
  const baselineSet = new Set(git.baselineModifiedFiles ?? []);
  return (git.modifiedFiles ?? []).filter(file => !baselineSet.has(file));
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

function isLowSignalShortMemory(summary: string, files: string[]): boolean {
  if (!summary.trim()) return true;
  if (files.length === 0) return true;
  return /^modified \d+ file\(s\)$/i.test(summary.trim());
}

export function extractMemoriesFromExchanges(
  _recentExchange: string,
  git: GitContext | null,
  sessionTitle: string | null,
): ExtractedMemory[] {
  const agentFiles = getAgentModifiedFiles(git);
  const normalizedSessionTitle = sessionTitle?.trim();
  if (!normalizedSessionTitle || agentFiles.length === 0) {
    return [];
  }

  const summary = truncate(normalizedSessionTitle, 160);
  if (isLowSignalShortMemory(summary, agentFiles)) {
    return [];
  }

  return [{
    type: "short",
    summary,
    files: agentFiles,
    areas: computeAreas(agentFiles),
    expiresAt: new Date(Date.now() + SHORT_MEMORY_TTL_MS).toISOString(),
  }];
}
