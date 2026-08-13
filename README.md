# Herdr Switcher

Bring [Herdr](https://github.com/ogulcancelik/herdr) spaces and AI coding agents into VS Code. See every project at a glance, switch between their VS Code windows, and jump directly to an active agent.

## Features

- Separate **Spaces** and **Agents** lists in the Herdr Activity Bar.
- Live agent status, Git branch names, and the active agent in the status bar.
- An overall Herdr status item with links to every agent across all Spaces.
- Click a Space to switch to its VS Code window without opening a terminal.
- Click an Agent to switch windows and focus its pane in either the full Herdr UI or a dedicated direct-attach terminal.
- Direct Agent terminals use Herdr's session-control bridge, so VS Code owns each terminal and no Herdr `Ctrl-B` prefix is required.
- Start Claude Code, Codex, or custom agents in dedicated Herdr tabs.
- Rename an agent or its containing tab from the Agents context menu.
- Close Spaces with the inline trash button or from the `…` menu, with a warning when non-shell processes are running.
- Run Herdr on the local host when VS Code is connected to a Dev Container.

## Requirements

- VS Code 1.96 or later
- Herdr 0.8.0 or later, available as `herdr` on `PATH`

If Herdr is installed elsewhere, set `herdr.executable` to its path.

Herdr Switcher is a UI extension: Herdr and configured agents run on the machine
where VS Code is installed. Dev Container workspaces are associated with their
decoded host path, while navigation still reopens the corresponding container
window. Other VS Code remote types are not currently supported.

## Getting started

1. Open a folder in VS Code. The extension creates or associates its Herdr Space.
2. Open the Herdr icon in the Activity Bar to see all Spaces and Agents.
3. Select a Space or Agent to navigate. Use the Agents header buttons to choose an agent or start the default one.

Herdr remains the source of truth. Cross-window actions are delivered through short-lived Herdr metadata intents, so each VS Code window can handle navigation for its own Space.

## Configuration

- `herdr.executable`: Herdr executable path
- `herdr.session`: optional named Herdr session
- `herdr.refreshInterval`: fallback snapshot interval in milliseconds when Herdr's event stream is unavailable
- `herdr.createSpaceOnOpen`: automatically create or associate Spaces
- `herdr.terminalLocation`: open Herdr in the Terminal view (`panel`) or as a pinned editor (`editor`)
- `herdr.agentTerminalMode`: use the full Herdr UI (`herdr`, default) or a dedicated `terminal session control` terminal per Agent pane (`direct`); restart the Extension Host after changing it
- `herdr.agents`: agents available from the Add Agent picker
- `herdr.defaultAgent`: agent launched by the `+` button

All settings are user-level settings. The default agents are Claude Code and Codex:

The default terminal location is `panel`. VS Code does not expose a dedicated
Secondary Side Bar terminal location, but if you move the Terminal view there,
Herdr follows it.

```json
{
  "herdr.agents": [
    { "name": "Claude Code", "command": ["claude"], "kind": "claude" },
    { "name": "Codex", "command": ["codex"], "kind": "codex" }
  ],
  "herdr.defaultAgent": "Claude Code"
}
```

## Development

```sh
npm install
npm test
npm run build
```

Press `F5` to launch the included Extension Development Host configuration.
