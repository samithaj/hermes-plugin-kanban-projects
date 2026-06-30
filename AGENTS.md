# AGENTS.md — hermes-plugin-kanban-projects

Context for any Codex session working in this repo. Read before editing.

## What this is

A **standalone, git-installable Hermes dashboard plugin** (`kanban-projects`). It renders the Hermes
Kanban board grouped by **project path** (Codex session cwd), joined with a human-owned
`project-goals` board for per-project **goals / objectives / triage**, plus optional Obsidian note
links. It is the visual **"urgent dashboard"** half of a sound→navigate attention loop (the audio
half is separate Codex hooks, see "Related work").

Install: `hermes plugins install samithaj/hermes-plugin-kanban-projects` → `hermes plugins enable kanban-projects`.
Remote: `https://github.com/samithaj/hermes-plugin-kanban-projects`.

## Hard constraints (do not violate)

- **UI-only plugin. No backend.** Custom/git-installed plugins **cannot** ship `plugin_api.py` /
  FastAPI routes — that's bundled-plugins-only. All persistence rides the **bundled Kanban dashboard
  API** (`/api/plugins/kanban/*`, same-origin) via `SDK.fetchJSON`. Never add a backend here.
- **🔒 Goal cards must never be dispatchable.** The Hermes dispatcher scans **every** non-archived
  board each tick (`gateway/kanban_watchers.py`) and `recompute_ready` auto-promotes `todo`→`ready`
  (`hermes_cli/kanban_db.py`); a `ready`+assigned card is **executed by a worker**. Therefore every
  `project-goals` card MUST stay **`status: triage`** and **unassigned**. The human triage bucket lives
  in the card **body** (`Bucket:` line), NEVER in the Kanban status. Consequences for code:
  - Create with `{title, body, triage:true, idempotency_key}` — the create API has **no `status`
    field** (verified: `CreateTaskBody` only has `triage:bool`); passing `status` is silently dropped
    and the card lands in `ready` (dispatchable!).
  - Edit a bucket/objective with `PATCH /tasks/<id> {body}` — **never** `{status}`.
  - Never set an assignee on a goal card.
- **Ship `dashboard/dist/*` as-is.** The bundle is **hand-authored** plain JS (hyperscript `h(...)`,
  no JSX, no build step). Edit `dist/index.js` directly; keep `node --check dashboard/dist/index.js`
  green. `plugin.yaml` is metadata-only (name/version/description, no `provides_tools` → no Python
  import).

## Architecture / data model

- **Two boards, joined by canonical project key:**
  - `Codex-work` (the session mirror — written every minute by `~/.hermes/scripts/sync_claude_kanban.py`; **never** write to it from here).
  - `project-goals` (human-owned; one card per project; this plugin reads + writes it).
- **Canonical key = full cwd path**, not basename (basenames collide: `inbox-ai-flow`→5 jobs,
  `ppt-analysis-agent`→3, `Credit_Management`→3, `sk`→2). `/Users/sam` and `__unknown__` are excluded
  from goals (`fullPathKey()`); the "+ Add goal" button is disabled for `__unknown__`.
- **Goal card body schema** (markdown so it's human-editable in stock Kanban too; `Path:` is the join
  key and must stay first — `setGoalBodyFields()` enforces the header order and forces `Path:`):
  ```
  Path: /Users/sam/Documents/dev/<project>
  Bucket: now|next|later|blocked|done
  Obsidian: [[wiki/projects/<slug>]]
  Note path: wiki/projects/<slug>.md
  **Objective:** ...
  **Next:** ...
  **Done when:**
  - [ ] ...
  ```
- **Bundled Kanban API used** (all via `fetchJSON(withBoard(url, board), opts)`):
  - `GET  /api/plugins/kanban/board?board=<slug>` → `{columns:[{name,tasks:[…]}]}`
  - `POST /api/plugins/kanban/tasks?board=project-goals` `{title, body, triage:true, idempotency_key}`
  - `PATCH /api/plugins/kanban/tasks/<id>?board=project-goals` `{body}` (never `{status}` for goals)
  - `POST /api/plugins/kanban/tasks/<id>/comments?board=project-goals` `{body}` (comment text field is `body`)
  - `SDK.fetchJSON(url, opts)` carries auth in both modes; the local wrapper passes `opts` through to
    it and to the `fetch` fallback. (An earlier bug dropped `opts` — keep it forwarded.)

## Triage / attention model

- **Session signals are parsed from the session card body**, where the sync packs everything on one
  line: `- State: \`x\`  ·  Process: \`y\`  ·  Waiting: \`z\``, plus `- Needs: …`. Parse each field with a
  **bounded** regex `/Label:\s*\`?([^\`\n·]+)\`?/i` — do **not** use a greedy line capture (that was the
  bug fixed in `6ce4c63`: a greedy `- State:` grab swallowed the Process/Waiting parts so blocked
  sessions were missed). Real vocab: `state ∈ {blocked, done, failed, working, None}`,
  `Process ∈ {idle, waiting, busy}`.
- `needsMe = waiting || needs || ((state=="blocked" || task.status=="blocked") && process!="busy")`.
- **Triage strip** (top of page): every `needsMe` session across all projects, ranked, each with
  `Open in Warp` (`http://127.0.0.1:9777/open/<jobId>`) and an optional `Send/Draft` compose link
  (`/compose/<jobId>`), gated behind the "Compose links" toggle (default off; do **not** probe
  `:9777/health` for feature-detection — keep it a manual toggle). Job id is parsed from the session
  title `[<sid>]`.
- **Triage mode** toggle re-sorts groups by attention score and filters to needs-me; persisted in
  `localStorage`.

## Obsidian integration (link-only)

- The plugin **never writes the vault** from JS. It renders `Open note` from the goal card's
  `Note path:`/`Obsidian:` metadata: `obsidian://open?vault=obsidian_vault_pro&file=<encoded notePath>`.
  Note paths are entered manually in the goal editor; a suggested path is shown when none exists.
- Vault: `/Users/sam/Documents/obsidian_vault_pro/` (repo `samithaj/notes`). If a session ever creates
  notes, follow that vault's `AGENTS.md`: edit `wiki/`, never `raw/`, append `log.md`. Note-join is
  sparse today (~2 of 14 `wiki/projects/*.md` carry a dev-repo path) — most active projects have no
  note yet, so creation (not linking) is the real gap if this is expanded.

## Dev / test loop

- Verify syntax: `node --check dashboard/dist/index.js`.
- Live test: `cp -r dashboard ~/.hermes/plugins/kanban-projects/` then `GET http://127.0.0.1:9120/api/dashboard/plugins/rescan` (or restart the dashboard). View at
  `http://127.0.0.1:9120/kanban-projects?board=Codex-work`.
- The `project-goals` board is created once: `hermes kanban boards create project-goals --name "Project Goals" --icon 🎯`.
- Migration note: remove any **manual drop** at `~/.hermes/plugins/kanban-projects` before/after a git
  install (`hermes plugins install --force`) so there's only one `/kanban-projects` tab.

## Related work (design source of truth — these live outside this repo)

- `~/.hermes/plans/2026-06-24_132445-kanban-projects-plugin-goals-triage.md` — the full plan this repo
  implements (data model, tasks, acceptance, the dispatcher-safety rationale).
- `~/.hermes/plans/2026-06-23_223519-warp-hermes-Codex-agentview-orchestration.md` — companion plan:
  the Warp bridge (`:9777` `/open` `/compose` `/send`), the session registry, and the `project_key`
  the triage strip's links depend on.
- `~/.Codex/agent-alert-plan.md` — the **audio** half of sound→navigate: per-session Codex
  hooks (`Notification: permission_prompt|idle_prompt` start; `UserPromptSubmit`/`PostToolUse`/`Stop`
  stop) that play a repeating sound when an agent needs you. Those hooks live in `~/.Codex/hooks/`
  (NOT this repo). Note: `AskUserQuestion` fires **no hook**, so the sound is silent for it — this
  plugin's visual triage strip is the backstop for that gap.

## Conventions

- **No `Co-Authored-By` trailer** on commits (Sam's global rule). End commit messages at the last
  functional line.
- Keep changes to `dist/index.js` in the same hand-authored hyperscript style; no build tooling, no
  framework imports beyond the injected SDK (`window.__HERMES_PLUGIN_SDK__`).
- Don't touch stock Kanban (`~/.hermes/hermes-agent/plugins/kanban`) or its DB schema; go through the
  HTTP API only.
