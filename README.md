# Herdr Switcher

Bring [Herdr](https://github.com/ogulcancelik/herdr) spaces and AI coding agents into VS Code. See every project at a glance, switch between their VS Code windows, and jump directly to an active agent.

## Features

- Separate **Spaces** and **Agents** lists in the Herdr Activity Bar.
- Live agent status, Git branch names, and the active agent in the status bar.
- Click a Space to switch to its VS Code window without opening a terminal.
- Click an Agent to switch windows, open a pinned Herdr terminal, and focus its pane.
- Use a Space's terminal button to attach from that Space's VS Code window.
- Start Claude Code, Codex, or custom agents in dedicated Herdr tabs.
- Close Spaces from the `…` menu, with a warning when non-shell processes are running.
- Run Herdr on the local host when VS Code is connected to a Dev Container.

## Requirements

- VS Code 1.96 or later
- Herdr 0.7.5 or later, available as `herdr` on `PATH`

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
- `herdr.refreshInterval`: live update interval in milliseconds
- `herdr.createSpaceOnOpen`: automatically create or associate Spaces
- `herdr.agents`: agents available from the Add Agent picker
- `herdr.defaultAgent`: agent launched by the `+` button

All settings are user-level settings. The default agents are Claude Code and Codex:

```json
{
  "herdr.agents": [
    { "name": "Claude Code", "command": ["claude"] },
    { "name": "Codex", "command": ["codex"] }
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
