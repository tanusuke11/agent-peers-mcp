# Agent Peers — build commands

build:
    bun run build

vsix: build
    npx --yes @vscode/vsce package --allow-missing-repository
    code --install-extension agent-peers-mcp-0.1.0.vsix --force

update-claude:
    npm install -g @anthropic-ai/sdk
    npm update @anthropic-ai/sdk