# Hermes Plugin: Kanban Projects

Project-grouped dashboard view for Hermes Kanban.

This is a UI-only dashboard plugin. It does **not** ship `plugin_api.py`, backend routes, tools, or hooks. All persistence uses the bundled Kanban dashboard API through `SDK.fetchJSON`.

## Features

- Groups Claude Code session cards by canonical project path.
- Joins the session board with a human-owned `project-goals` board.
- Stores one goal card per full cwd path.
- Keeps goal cards safe from dispatch: status stays `triage`, cards stay unassigned, human bucket lives in the card body as `Bucket:`.
- Shows objective, next action, attention rollup, top triage strip, optional Compose links, and Obsidian note links.

## Goal card body schema

```markdown
Path: /Users/sam/Documents/dev/example/project
Bucket: later
Obsidian: [[wiki/projects/example-project]]
Note path: wiki/projects/example-project.md
**Objective:** ship the project outcome
**Next:** choose the next concrete step
**Done when:**
- [ ] checklist item
```

## Install

```bash
hermes plugins install samithaj/hermes-plugin-kanban-projects
hermes plugins enable kanban-projects
```

If migrating from a manual drop, back up/remove `~/.hermes/plugins/kanban-projects` first to avoid duplicate tabs.

## Development

The shipped artifact is `dashboard/dist/index.js` and `dashboard/dist/style.css`.

No custom backend is required or supported for this plugin.
