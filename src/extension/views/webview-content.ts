export interface MarkdownViewItem {
  title?: string;
  header?: string;
  text?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inCode = false;
  let inList = false;

  const inline = (value: string) =>
    escapeHtml(value)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line)) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      if (inCode) {
        out.push("</code></pre>");
        inCode = false;
      } else {
        out.push("<pre><code>");
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }

    if (line.trim() === "") {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push("<br>");
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push("<hr>");
      continue;
    }

    const headerMatch = line.match(/^(#{1,4})\s+(.*)/);
    if (headerMatch) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      const level = headerMatch[1].length;
      out.push(`<h${level}>${inline(headerMatch[2])}</h${level}>`);
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }

    if (inList) {
      out.push("</ul>");
      inList = false;
    }
    out.push(`<p>${inline(line)}</p>`);
  }

  if (inCode) {
    out.push("</code></pre>");
  }
  if (inList) {
    out.push("</ul>");
  }

  return out.join("\n");
}

export function buildMarkdownWebviewHtml(title: string, markdown: string): string {
  const body = markdownToHtml(markdown);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    padding: 16px 24px;
    line-height: 1.6;
    max-width: 860px;
  }
  h1 { color: var(--vscode-textLink-foreground); border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; }
  h2 { color: var(--vscode-textLink-foreground); }
  h3, h4 { color: var(--vscode-foreground); }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 12px 0; }
  code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.92em;
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px;
    border-radius: 3px;
  }
  pre {
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 10px 14px;
    overflow-x: auto;
  }
  pre code { background: none; padding: 0; }
  ul { padding-left: 1.4em; }
  li { margin: 2px 0; }
  a { color: var(--vscode-textLink-foreground); }
  a:hover { color: var(--vscode-textLink-activeForeground); }
  p { margin: 4px 0; }
  strong { color: var(--vscode-foreground); }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
