# Agent Peers — build commands

build:
    bun run build

vsix: build
    npx --yes @vscode/vsce package --allow-missing-repository
