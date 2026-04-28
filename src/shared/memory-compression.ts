/**
 * Memory compression module
 *
 * Extracts structured memories from raw session exchanges.
 * Strategy A (local, no API): rule-based pattern matching.
 * Strategy B (AI, future): Claude API summarization — not implemented.
 */

import crypto from "crypto";
import type { GitContext, ExtractedMemory, MemoryCategory } from "./types.ts";

// ─── Pattern matchers ────────────────────────────────────────

const DECISION_PATTERNS = [
  /\b(?:decided?\s+to|let['']?s\s+go\s+with|chose?\s+to|going\s+with|approach\s+is|will\s+use|opted?\s+for)\b/i,
];

const BUGFIX_PATTERNS = [
  /\b(?:fixed?\s+by|the\s+issue\s+was|error\s+was\s+caused|resolved?\s+by|bug\s+was|root\s+cause|the\s+fix\s+is|patch(?:ed)?)\b/i,
];

const ARCHITECTURE_PATTERNS = [
  /\b(?:refactor|architect|design\s+pattern|module\s+structure|component|restructur|reorganiz|migrat)\b/i,
];

const ERROR_PATTERNS = [
  /\b(?:Error|Exception|TypeError|ReferenceError|SyntaxError|ENOENT|EACCES|FATAL|panic|stack\s*trace)\b/,
];

const FILE_PATH_PATTERN = /(?:^|\s)((?:src|lib|out|dist|test|spec|pkg|cmd|internal)\/[\w./-]+(?:\.\w+)?)/g;

// ─── Helpers ─────────────────────────────────────────────────

/** Extract file paths mentioned in text */
function extractFilePaths(text: string): string[] {
  const paths = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(FILE_PATH_PATTERN.source, FILE_PATH_PATTERN.flags);
  while ((match = re.exec(text)) !== null) {
    paths.add(match[1]!.trim());
  }
  return [...paths];
}

/** Compute directory areas from file paths (first 2 path segments) */
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

/** Truncate text to maxLen, appending ellipsis if truncated */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

/** Parse the markdown exchange document into blocks */
function parseBlocks(recentExchange: string): Array<{ role: "human" | "assistant"; text: string }> {
  const blocks: Array<{ role: "human" | "assistant"; text: string }> = [];
  const parts = recentExchange.split(/\n(?=## (?:Human|Assistant) )/);
  for (const part of parts) {
    const headerMatch = part.match(/^## (Human|Assistant)[^\n]*\n\n?([\s\S]*)/);
    if (headerMatch) {
      blocks.push({
        role: headerMatch[1]!.toLowerCase() as "human" | "assistant",
        text: headerMatch[2]!.trim(),
      });
    }
  }
  return blocks;
}

// ─── Main extraction ─────────────────────────────────────────

/**
 * Extract structured memories from session exchanges.
 * Returns deduplicated ExtractedMemory entries.
 */
export function extractMemoriesFromExchanges(
  recentExchange: string,
  git: GitContext | null,
  sessionTitle: string | null,
): ExtractedMemory[] {
  if (!recentExchange || recentExchange.length < 50) return [];

  const memories: ExtractedMemory[] = [];
  const blocks = parseBlocks(recentExchange);
  const allText = blocks.map(b => b.text).join("\n");
  const allFiles = extractFilePaths(allText);

  // 1. Decision detection
  for (const block of blocks) {
    if (block.role !== "assistant") continue;
    for (const pattern of DECISION_PATTERNS) {
      if (pattern.test(block.text)) {
        const sentence = extractSentence(block.text, pattern);
        if (sentence) {
          const files = extractFilePaths(block.text);
          memories.push({
            category: "architecture",
            title: truncate(sentence, 100),
            content: truncate(block.text, 500),
            files,
            areas: computeAreas(files),
          });
        }
        break; // one decision per block
      }
    }
  }

  // 2. Bug-fix detection: error in human block → fix in assistant block
  for (let i = 0; i < blocks.length - 1; i++) {
    const human = blocks[i]!;
    const assistant = blocks[i + 1];
    if (human.role !== "human" || !assistant || assistant.role !== "assistant") continue;
    if (!ERROR_PATTERNS.some(p => p.test(human.text))) continue;
    if (!BUGFIX_PATTERNS.some(p => p.test(assistant.text))) continue;

    const fixSentence = extractSentence(assistant.text, BUGFIX_PATTERNS[0]!);
    const files = extractFilePaths(assistant.text);
    memories.push({
      category: "issue",
      title: truncate(fixSentence ?? "Bug fix", 100),
      content: truncate(assistant.text, 500),
      files,
      areas: computeAreas(files),
      sourceExchange: truncate(`${human.text}\n---\n${assistant.text}`, 1000),
    });
  }

  // 3. Architecture detection
  for (const block of blocks) {
    if (block.role !== "assistant") continue;
    if (!ARCHITECTURE_PATTERNS.some(p => p.test(block.text))) continue;
    // Avoid duplicating with decisions already extracted
    if (DECISION_PATTERNS.some(p => p.test(block.text))) continue;

    const sentence = extractSentence(block.text, ARCHITECTURE_PATTERNS[0]!);
    const files = extractFilePaths(block.text);
    if (files.length > 0) {
      memories.push({
        category: "architecture",
        title: truncate(sentence ?? "Architecture change", 100),
        content: truncate(block.text, 500),
        files,
        areas: computeAreas(files),
      });
    }
  }

  // 4. File change summary from git context
  if (git) {
    const baselineSet = new Set(git.baselineModifiedFiles ?? []);
    const agentFiles = (git.modifiedFiles ?? []).filter(f => !baselineSet.has(f));
    if (agentFiles.length > 0) {
      const title = sessionTitle
        ? truncate(sessionTitle, 100)
        : `Modified ${agentFiles.length} file(s)`;
      const fileList = agentFiles.slice(0, 10).join(", ");
      memories.push({
        category: "task",
        title,
        content: truncate(`Files changed: ${fileList}. ${sessionTitle ?? ""}`, 500),
        files: agentFiles,
        areas: computeAreas(agentFiles),
      });
    }
  }

  // Deduplicate by content hash within this extraction
  const seen = new Set<string>();
  return memories.filter(m => {
    const hash = computeContentHash(m.category, m.title, m.content);
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}

/** Extract the sentence containing the pattern match */
function extractSentence(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  if (!match || match.index === undefined) return null;

  // Find sentence boundaries around the match
  const before = text.slice(0, match.index);
  const after = text.slice(match.index);
  const sentStart = Math.max(before.lastIndexOf(". ") + 2, before.lastIndexOf("\n") + 1, 0);
  const sentEndRel = after.search(/[.!?\n]/);
  const sentEnd = match.index + (sentEndRel >= 0 ? sentEndRel + 1 : after.length);

  return text.slice(sentStart, sentEnd).trim();
}

/**
 * Compute a content hash for deduplication.
 * Two memories with the same hash are considered duplicates.
 */
export function computeContentHash(category: string, title: string, content: string): string {
  const normalized = `${category}|${title.toLowerCase().trim()}|${content.toLowerCase().trim().slice(0, 500)}`;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}
