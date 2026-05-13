import fs from "fs";
import path from "path";
import type { ExtractedMemory } from "./types.ts";

function readIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function hasPath(repoRoot: string, relativePath: string): boolean {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function extractHeadingSection(markdown: string, heading: string): string {
  if (!markdown) return "";
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === `## ${heading}`);
  if (start < 0) return "";

  const section: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##\s+/.test(line)) break;
    section.push(line);
  }
  return section.join("\n").trim();
}

function summarizeProjectStructure(repoRoot: string, readme: string, agentDoc: string): string {
  const readmeArchitecture = extractHeadingSection(readme, "Architecture");
  const agentArchitecture = extractHeadingSection(agentDoc, "Architecture Summary");

  const layers: string[] = [];
  if (hasPath(repoRoot, "src/shared")) layers.push("shared: common types, constants, and git/context helpers");
  if (hasPath(repoRoot, "src/broker")) layers.push("broker: singleton coordination daemon with HTTP, WebSocket, and SQLite");
  if (hasPath(repoRoot, "src/server")) layers.push("server: per-agent stdio MCP server");
  if (hasPath(repoRoot, "src/extension")) layers.push("extension: VS Code UI and broker client");
  if (hasPath(repoRoot, "src/hooks")) layers.push("hooks: pre-prompt conflict detection");

  const topology: string[] = [];
  if (agentArchitecture.includes("VSCode Extension")) topology.push("the VS Code extension connects to the broker for live UI state");
  if (agentArchitecture.includes("SQLite")) topology.push("the broker persists shared peer state and repo memory in SQLite");
  if (agentArchitecture.includes("MCP server")) topology.push("each AI agent instance runs its own MCP server and registers with the broker");

  return truncate(
    [
      layers.length > 0 ? `Layers: ${layers.join("; ")}.` : "",
      topology.length > 0 ? `Runtime: ${topology.join("; ")}.` : "",
      readmeArchitecture ? "Canonical source: README.md Architecture and AGENT.md Architecture Summary." : "",
    ].filter(Boolean).join(" "),
    500,
  );
}

function summarizeTechStack(repoRoot: string, packageJsonText: string, brokerSource: string): string {
  let packageJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  } = {};
  try {
    packageJson = JSON.parse(packageJsonText);
  } catch {
    packageJson = {};
  }

  const deps = packageJson.dependencies ?? {};
  const devDeps = packageJson.devDependencies ?? {};
  const scripts = packageJson.scripts ?? {};
  const parts = [
    "TypeScript on Node.js",
    deps["@modelcontextprotocol/sdk"] ? "MCP SDK (@modelcontextprotocol/sdk)" : "",
    hasPath(repoRoot, "src/extension") ? "VS Code extension API" : "",
    deps["ws"] || brokerSource.includes("WebSocketServer") ? "WebSocket transport via ws" : "",
    brokerSource.includes(`from "node:sqlite"`) ? "SQLite via node:sqlite" : "",
    devDeps["esbuild"] || scripts["build:broker"] ? "esbuild build pipeline" : "",
    scripts["package"]?.includes("vsce") ? "VSIX packaging via vsce" : "",
    scripts["test"]?.includes("node --test") ? "Node test runner" : "",
  ].filter(Boolean);

  return truncate(
    `Stack: ${parts.join("; ")}. Build targets: broker, server, extension, and conflict hook bundles from package.json scripts.`,
    500,
  );
}

export function buildCanonicalArchitectureMemories(repoRoot: string): ExtractedMemory[] {
  const readme = readIfExists(path.join(repoRoot, "README.md"));
  const agentDoc = readIfExists(path.join(repoRoot, "AGENT.md"));
  const packageJsonText = readIfExists(path.join(repoRoot, "package.json"));
  const brokerSource = readIfExists(path.join(repoRoot, "src", "broker", "index.ts"));

  const files = ["README.md", "AGENT.md", "package.json", "src/broker/index.ts"];
  const existingFiles = files.filter(file => hasPath(repoRoot, file));
  const memories: ExtractedMemory[] = [];

  const structureSummary = summarizeProjectStructure(repoRoot, readme, agentDoc);
  if (structureSummary) {
    memories.push({
      type: "long",
      summary: truncate(`Project structure: ${structureSummary}`, 160),
      files: existingFiles.filter(file => file === "README.md" || file === "AGENT.md"),
      areas: ["src/shared", "src/broker", "src/server", "src/extension", "src/hooks"],
    });
  }

  memories.push({
    type: "long",
    summary: truncate(
      "Runtime topology: VS Code extension is the UI, the broker coordinates shared state in SQLite, and each AI tool instance connects through its own MCP server.",
      160,
    ),
    files: existingFiles.filter(file => file === "AGENT.md" || file === "src/broker/index.ts"),
    areas: ["src/broker", "src/server", "src/extension"],
  });

  const techStackSummary = summarizeTechStack(repoRoot, packageJsonText, brokerSource);
  if (techStackSummary) {
    memories.push({
      type: "long",
      summary: truncate(`Tech stack: ${techStackSummary}`, 160),
      files: existingFiles.filter(file => file === "package.json" || file === "src/broker/index.ts"),
      areas: ["src/broker", "src/server", "src/extension", "src/hooks"],
    });
  }

  return memories;
}
