# Herdr Switcher

Native VS Code navigation for [Herdr](https://github.com/ogulcancelik/herdr), the terminal workspace manager for AI coding agents.

## What it does

- Creates or associates a Herdr space when a folder opens in VS Code.
- Shows independent Spaces and Agents lists in one Activity Bar container, matching Herdr's sidebar structure.
- Opens a space's root folder in a VS Code window.
- Opens another workspace's VS Code window when you select one of its agents.
- In the current workspace, focuses the selected Herdr agent and opens or reuses an integrated Herdr terminal.
- Starts a headless Herdr server when folder association needs one and no server is running.

Herdr remains the source of truth for spaces, panes, agents, and semantic agent states. The extension stores only the association between a VS Code folder and a Herdr workspace ID. Existing spaces are initially associated by exact worktree checkout path or root-pane cwd.

## Development

```sh
npm install
npm test
npm run build
```

Press `F5` in VS Code to launch an Extension Development Host.

The default `Run Herdr Extension` debug configuration starts esbuild in watch
mode and launches an Extension Development Host with source maps enabled. Set
breakpoints directly in `src/*.ts`; after an edit, restart the debug session to
load the rebuilt extension. Use `Run Herdr Extension (build once)` when a
persistent watcher is not wanted.

VS Code tasks are also available for build (`Cmd+Shift+B`), watch, type-check,
and test.

## Configuration

- `herdr.executable`: Herdr executable path (default: `herdr`)
- `herdr.session`: optional named Herdr session
- `herdr.refreshInterval`: sidebar snapshot interval in milliseconds (default: `1000`)
- `herdr.createSpaceOnOpen`: create/associate spaces on folder open (default: `true`)

## Current cross-window behavior

Selecting an agent in another root workspace opens that workspace's VS Code window. VS Code does not provide a direct command channel to the extension host in the other window, so forwarding the pane target and focusing it there remains future work.
