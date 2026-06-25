#!/usr/bin/env python3
"""
Sync Claude Code Agent View  →  Hermes Kanban board
====================================================

Runs every minute (Hermes cron, no_agent mode). Two jobs:

1. Watchdog: make sure the Warp bridge (warp_kanban_bridge.py) is listening
   on 127.0.0.1:9777. Start it detached if not.

2. Sync: read `claude agents --json --all`, and for every Claude Code session
   ensure a matching card exists on the `claude-code-work` kanban board with:
     - the right status (done / blocked / running),
     - a fresh body containing the live state + a CLICKABLE "Open in Warp" link
       (http://127.0.0.1:9777/open/<id>, which the board linkifies) plus the
       raw warp://launch link and the shell commands.

Idempotent: cards are keyed by idempotency_key = "claude-code:<job_id>", so
re-runs update in place instead of duplicating. Writing status changes emits
kanban task_events, which the dashboard tails over WebSocket — so the board
updates live without a manual refresh.

This script is intentionally dependency-free (stdlib only) and shells out to
the `hermes kanban` and `claude` CLIs so it stays robust across upgrades.
"""

from __future__ import annotations

import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

BOARD = "claude-code-work"
BRIDGE_PORT = int(os.environ.get("WARP_KANBAN_BRIDGE_PORT", "9777"))
BRIDGE_SCRIPT = Path.home() / ".hermes" / "scripts" / "warp_kanban_bridge.py"
DASHBOARD_PORT = int(os.environ.get("HERMES_DASHBOARD_PORT", "9120"))
# Hard-pin the WEB dashboard bundle. Do NOT fall back to an inherited
# HERMES_WEB_DIST — when this script runs from a cron tick spawned by the
# Hermes Desktop (Electron) app, the inherited HERMES_WEB_DIST points at the
# desktop app.asar bundle, which needs the Electron IPC bridge and shows
# "Desktop IPC bridge is unavailable" in a plain browser. The web_dist bundle
# renders standalone in any browser and loads the kanban plugin.
DASHBOARD_WEB_DIST = str(
    Path.home() / ".hermes" / "hermes-agent" / "hermes_cli" / "web_dist"
)
HOME = Path.home()
JOBS_DIR = HOME / ".claude" / "jobs"
HERMES_BIN = os.environ.get("HERMES_BIN", "hermes")
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")

# Map Claude Agent-View states to kanban actions.
#   done             -> complete
#   failed/blocked   -> block (with reason)
#   working/busy     -> running (claim)
# Everything else is left in whatever column it's in.


def _run(args: list[str], timeout: int = 60) -> tuple[int, str, str]:
    p = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def _port_alive(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1.0)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _bridge_alive() -> bool:
    return _port_alive(BRIDGE_PORT)


def _start_bridge() -> None:
    if _bridge_alive():
        return
    # Detach fully so it outlives this cron tick.
    subprocess.Popen(
        [sys.executable, str(BRIDGE_SCRIPT)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    for _ in range(10):
        if _bridge_alive():
            return
        time.sleep(0.3)


def _dashboard_alive() -> bool:
    return _port_alive(DASHBOARD_PORT)


def _start_dashboard() -> None:
    """Keep the web dashboard (the kanban board UI) listening on its port.

    Uses the web_dist bundle (NOT the desktop/Electron build) so it renders in
    a plain browser instead of the 'Desktop IPC bridge unavailable' shell.
    Detached so it survives the cron tick."""
    if _dashboard_alive():
        return
    env = dict(os.environ)
    # Strip desktop/Electron markers so the child serves the standalone WEB
    # bundle, not the app.asar desktop bundle (which 500s the IPC bridge in a
    # plain browser). Then hard-pin the web bundle.
    env.pop("HERMES_DESKTOP", None)
    env["HERMES_WEB_DIST"] = DASHBOARD_WEB_DIST
    subprocess.Popen(
        [HERMES_BIN, "dashboard", "--no-open", "--host", "127.0.0.1",
         "--port", str(DASHBOARD_PORT), "--skip-build"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
        env=env,
    )
    for _ in range(20):
        if _dashboard_alive():
            return
        time.sleep(0.5)


def _agents() -> list[dict]:
    code, out, err = _run([CLAUDE_BIN, "agents", "--json", "--all"], timeout=60)
    if code != 0 or not out:
        raise RuntimeError(f"claude agents failed: {err or out}")
    return json.loads(out)


def _state_file(job_id: str) -> dict:
    try:
        return json.loads((JOBS_DIR / job_id / "state.json").read_text())
    except Exception:
        return {}


# Transient API-error phrases that mean "Claude paused on a server hiccup,
# not on a real usage cap" — i.e. the auto-continue hook will be retrying.
_RATE_LIMIT_MARKERS = (
    "not your usage limit",
    "temporarily limiting",
    "Rate limited",
)


def _transcript_path(job_id: str, st: dict) -> Path | None:
    """Find the session's transcript jsonl. state.json carries linkScanPath
    pointing at it; fall back to deriving from sessionId + cwd."""
    p = st.get("linkScanPath")
    if p and Path(p).is_file():
        return Path(p)
    sid = st.get("sessionId") or st.get("resumeSessionId")
    if sid:
        # transcripts live under ~/.claude/projects/<slug>/<sessionId>.jsonl
        for cand in (HOME / ".claude" / "projects").glob(f"*/{sid}.jsonl"):
            return cand
    return None


def _rate_limited(job_id: str, st: dict) -> bool:
    """True if the session's LAST assistant entry is a transient API error
    (429 rate-limit / server hiccup). This is the same condition the
    auto_continue_on_api_error.sh Stop hook acts on — so the board shows a
    ⏳ badge while that hook is backing off and retrying."""
    tp = _transcript_path(job_id, st)
    if not tp:
        return False
    try:
        # Read the tail efficiently — only the last few KB matter.
        with open(tp, "rb") as f:
            try:
                f.seek(-65536, 2)
            except OSError:
                f.seek(0)
            tail = f.read().decode("utf-8", "replace")
    except Exception:
        return False
    last_err = None
    for line in tail.splitlines():
        if '"type":"assistant"' not in line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("type") != "assistant":
            continue
        if d.get("isApiErrorMessage") is True:
            content = (d.get("message") or {}).get("content") or []
            txt = " ".join(
                c.get("text", "") for c in content if isinstance(c, dict)
            ) if isinstance(content, list) else str(content)
            last_err = txt
        else:
            last_err = None  # a normal assistant turn came after → not stuck
    if not last_err:
        return False
    return any(m in last_err for m in _RATE_LIMIT_MARKERS)


def _recap(job_id: str, st: dict, max_len: int = 600) -> str:
    """Build a meaningful one-shot summary of where the session is.

    Source of truth = Claude's OWN last text response (its natural end-of-turn
    recap of what it did + what's next). This is far more useful than a
    state-change log. Falls back to the Agent-View `detail` one-liner.

    Returns a trimmed markdown blockquote, or "" if nothing usable.
    """
    detail = (st.get("detail") or "").strip()
    tp = _transcript_path(job_id, st)
    last_text = ""
    if tp:
        try:
            with open(tp, "rb") as f:
                try:
                    f.seek(-262144, 2)  # 256 KB tail — enough for a full turn
                except OSError:
                    f.seek(0)
                tail = f.read().decode("utf-8", "replace")
        except Exception:
            tail = ""
        for line in tail.splitlines():
            if '"type":"assistant"' not in line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("type") != "assistant" or d.get("isApiErrorMessage"):
                continue
            content = (d.get("message") or {}).get("content") or []
            if isinstance(content, list):
                txt = " ".join(
                    c.get("text", "") for c in content
                    if isinstance(c, dict) and c.get("type") == "text"
                ).strip()
                if txt:
                    last_text = txt  # keep the latest non-empty text turn

    summary = last_text or detail
    if not summary:
        return ""
    # Collapse whitespace, trim to a sentence boundary near max_len.
    summary = " ".join(summary.split())
    if len(summary) > max_len:
        cut = summary[:max_len]
        dot = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
        summary = (cut[:dot + 1] if dot > max_len * 0.5 else cut).rstrip() + " …"
    # Render as a markdown blockquote (each line prefixed).
    return "\n".join("> " + ln for ln in summary.split("\n"))


def _extract_todowrite(node):
    """Depth-first search for a TodoWrite tool_use's input.todos array."""
    if isinstance(node, dict):
        if node.get("type") == "tool_use" and node.get("name") == "TodoWrite":
            todos = (node.get("input") or {}).get("todos")
            if isinstance(todos, list):
                return todos
        for v in node.values():
            r = _extract_todowrite(v)
            if r is not None:
                return r
    elif isinstance(node, list):
        for v in node:
            r = _extract_todowrite(v)
            if r is not None:
                return r
    return None


def _todos_from_transcript(job_id: str, st: dict) -> list[dict]:
    """Fallback task source for sessions that use the classic checkbox todo
    list: the LAST TodoWrite call in the transcript tail."""
    tp = _transcript_path(job_id, st)
    if not tp:
        return []
    try:
        with open(tp, "rb") as f:
            try:
                f.seek(-262144, 2)
            except OSError:
                f.seek(0)
            tail = f.read().decode("utf-8", "replace")
    except Exception:
        return []
    last = None
    for line in tail.splitlines():
        if "TodoWrite" not in line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        todos = _extract_todowrite(d)
        if todos:
            last = todos
    out: list[dict] = []
    for t in (last or []):
        if not isinstance(t, dict):
            continue
        text = (t.get("content") or t.get("activeForm") or "").strip()
        if not text:
            continue
        out.append({
            "id": str(len(out) + 1),
            "text": text,
            "status": (t.get("status") or "pending").lower(),
            "blockedBy": [],
        })
    return out


def _session_id(job_id: str, st: dict) -> str | None:
    """The Claude session id that keys the transcript AND the task store
    (~/.claude/tasks/<sessionId>/). May differ from the agent id s['id']."""
    sid = st.get("sessionId") or st.get("resumeSessionId")
    if sid:
        return sid
    tp = _transcript_path(job_id, st)
    return tp.stem if tp else None


def _tasks(job_id: str, st: dict, max_items: int = 24) -> list[dict]:
    """The session's structured task list — the TaskCreate/Update store at
    ~/.claude/tasks/<sessionId>/<n>.json, in task-id order. Falls back to the
    last TodoWrite todo list in the transcript. Each item:
    {id, text, status in {pending,in_progress,completed}, blockedBy:[ids]}."""
    sid = _session_id(job_id, st)
    items: list[dict] = []
    if sid:
        tdir = HOME / ".claude" / "tasks" / sid
        if tdir.is_dir():
            files = []
            for f in tdir.glob("*.json"):
                try:
                    files.append((int(f.stem), f))
                except ValueError:
                    continue
            for _n, f in sorted(files):
                try:
                    d = json.loads(f.read_text())
                except Exception:
                    continue
                status = (d.get("status") or "pending").lower()
                if status == "deleted":
                    continue
                text = (d.get("subject") or d.get("content") or "").strip()
                if not text:
                    continue
                items.append({
                    "id": str(d.get("id") or _n),
                    "text": text,
                    "status": status,
                    "blockedBy": [str(x) for x in (d.get("blockedBy") or [])],
                })
    if not items:
        items = _todos_from_transcript(job_id, st)
    return items[:max_items]


def _tasks_block(items: list[dict]) -> str:
    """Render the task list as a parseable markdown checklist the kanban-projects
    plugin reads back out of the card body. Glyphs: [x] done, [>] in progress,
    [ ] pending; blocked-by edges appended as a human hint."""
    if not items:
        return ""
    glyph = {"completed": "x", "done": "x", "in_progress": ">", "pending": " "}
    done = sum(1 for i in items if i["status"] in ("completed", "done"))
    inprog = sum(1 for i in items if i["status"] == "in_progress")
    head = f"- Tasks: {done}/{len(items)} done" + (
        f" · {inprog} in progress" if inprog else ""
    )
    lines = [head]
    for i in items:
        mark = glyph.get(i["status"], " ")
        text = " ".join(str(i.get("text") or "").split())
        bb = i.get("blockedBy") or []
        # A blocker hint only matters for work that hasn't started yet.
        suffix = (
            " ⛔ blocked by #" + ", #".join(str(x) for x in bb)
            if bb and i["status"] == "pending" else ""
        )
        lines.append(f"  - [{mark}] {text}{suffix}")
    return "\n".join(lines) + "\n"


def _card_body(s: dict, st: dict, rate_limited: bool = False, recap: str = "") -> str:
    sid = s.get("id")
    name = s.get("name") or sid
    cwd = s.get("cwd") or st.get("cwd") or ""
    state = s.get("state", "")
    status = s.get("status", "")
    waiting = s.get("waitingFor", "")
    needs = st.get("needs", "")
    suggested = st.get("suggestedReply", "")
    open_url = f"http://127.0.0.1:{BRIDGE_PORT}/open/{sid}"
    rl_banner = (
        "> ⏳ **Rate limited** — transient API error (not a usage cap). "
        "The auto-continue hook is backing off and will resume automatically.\n\n"
        if rate_limited else ""
    )
    recap_block = (f"**Summary**\n{recap}\n\n" if recap else "")
    tasks_block = _tasks_block(_tasks(sid, st))
    return (
        rl_banner
        + f"**Claude Code session** `{sid}` — {name}\n\n"
        f"- State: `{state}`  ·  Process: `{status or 'idle'}`"
        + (f"  ·  Waiting: `{waiting}`" if waiting else "")
        + (f"  ·  ⏳ `rate-limited`" if rate_limited else "")
        + "\n"
        f"- Directory: `{cwd}`\n"
        + (f"- Needs: {needs}\n" if needs else "")
        + (f"- Suggested reply: `{suggested}`\n" if suggested else "")
        + tasks_block
        + "\n"
        + recap_block
        + f"### ▶ [Open in Warp]({open_url})\n"
        f"Click the link above to open a Warp terminal in this repo, attached to the live session.\n\n"
        f"Raw scheme (if the link isn't clickable): `warp://launch/cc-{sid}`\n\n"
        f"```bash\n"
        f"{CLAUDE_BIN} logs {sid}      # recent output / status\n"
        f"{CLAUDE_BIN} attach {sid}    # enter the live session\n"
        f"{CLAUDE_BIN} stop {sid}      # stop it\n"
        f"```\n"
    )


def _find_task_id(board_json: list[dict], sid: str) -> str | None:
    # `kanban list --json` does not expose idempotency_key, so match on the
    # session id embedded in the card title: "Claude Code: <name> [<sid>]".
    key = f"claude-code:{sid}"
    needle = f"[{sid}]"
    for t in board_json:
        if t.get("idempotency_key") == key:
            return t.get("id")
        if needle in (t.get("title") or ""):
            return t.get("id")
    return None


def _board_tasks() -> list[dict]:
    code, out, err = _run([HERMES_BIN, "kanban", "--board", BOARD, "list", "--json"], timeout=60)
    if code == 0 and out:
        try:
            data = json.loads(out)
            if isinstance(data, dict):
                # some versions wrap as {"tasks": [...]} or columns
                if "tasks" in data:
                    return data["tasks"]
                if "columns" in data:
                    return [t for c in data["columns"] for t in c.get("tasks", [])]
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []


def _board_db_path() -> Path:
    # Mirror kanban_db.kanban_db_path() for a named (non-default) board.
    return HOME / ".hermes" / "kanban" / "boards" / BOARD / "kanban.db"


def _refresh_body(task_id: str, body: str, title: str | None = None) -> None:
    """Best-effort: update a card's body (and optionally title) in place so the
    Warp link, live state, and ⏳ rate-limit marker stay current. Uses a short
    WAL-friendly write; silently no-ops if the DB isn't present yet."""
    import sqlite3

    db = _board_db_path()
    if not db.exists():
        return
    try:
        conn = sqlite3.connect(str(db), timeout=10)
        try:
            conn.execute("PRAGMA busy_timeout=8000")
            if title is not None:
                conn.execute(
                    "UPDATE tasks SET body = ?, title = ? WHERE id = ?",
                    (body, title, task_id),
                )
            else:
                conn.execute("UPDATE tasks SET body = ? WHERE id = ?", (body, task_id))
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


def _set_status(task_id: str, status: str) -> None:
    """Change a card's status directly in SQLite — WITHOUT adding a comment.

    The `hermes kanban block/complete/promote` CLI verbs each append a comment,
    which floods the card with low-value 'state changed' noise on a 1-min sync.
    A direct UPDATE keeps the column correct (the board re-reads it) with zero
    comment spam. Status values: ready, running, blocked, done, etc."""
    import sqlite3, time as _t

    db = _board_db_path()
    if not db.exists():
        return
    now = int(_t.time())
    try:
        conn = sqlite3.connect(str(db), timeout=10)
        try:
            conn.execute("PRAGMA busy_timeout=8000")
            if status == "done":
                conn.execute(
                    "UPDATE tasks SET status=?, completed_at=? WHERE id=?",
                    (status, now, task_id),
                )
            elif status == "running":
                conn.execute(
                    "UPDATE tasks SET status=?, started_at=?, completed_at=NULL WHERE id=?",
                    (status, now, task_id),
                )
            else:
                conn.execute("UPDATE tasks SET status=? WHERE id=?", (status, task_id))
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


def _ensure_board() -> None:
    _run([HERMES_BIN, "kanban", "boards", "create", BOARD,
          "--name", "Claude Code Work",
          "--description", "Live mirror of Claude Code Agent View sessions (click a card → open in Warp)",
          "--icon", "🤖", "--color", "#8b5cf6"], timeout=60)


def main() -> int:
    # 1) Watchdogs — keep the click-to-Warp bridge AND the dashboard UI alive.
    try:
        _start_bridge()
    except Exception as exc:
        print(f"bridge start failed: {exc}", file=sys.stderr)
    try:
        _start_dashboard()
    except Exception as exc:
        print(f"dashboard start failed: {exc}", file=sys.stderr)

    # 2) Sync
    _ensure_board()
    try:
        agents = _agents()
    except Exception as exc:
        print(f"sync skipped: {exc}", file=sys.stderr)
        return 0

    existing = _board_tasks()
    changed = 0

    # Index current kanban status by task id so we only issue a transition
    # when it actually changes (re-blocking each tick would spam comments).
    status_by_id = {t.get("id"): t.get("status") for t in existing}

    for s0 in agents:
        # Agent View background jobs have a short `id` used by `claude attach`.
        # Plain interactive Claude sessions (started directly in Warp) do not;
        # `claude agents --json --all` reports only their full transcript
        # `sessionId`. Mirror those too so freshly-started projects appear on
        # the dashboard instead of disappearing from the project rollup.
        sid = s0.get("id") or s0.get("sessionId")
        if not sid:
            continue
        s = dict(s0)
        s["id"] = sid
        if not s.get("name"):
            cwd_name = Path(s.get("cwd") or "").name
            s["name"] = cwd_name or sid
        if not s.get("state"):
            # Interactive sessions use `status` (idle/busy) rather than Agent
            # View states (blocked/working/done). Keep idle sessions visible as
            # ready cards; busy sessions are mapped below via status == busy.
            s["state"] = "working" if s.get("status") == "busy" else ""
        st = _state_file(sid)
        state = s.get("state", "")
        name = s.get("name") or sid
        rl = _rate_limited(sid, st)
        recap = _recap(sid, st)
        body = _card_body(s, st, rate_limited=rl, recap=recap)
        # Surface rate-limit in the always-visible title with an hourglass.
        title = f"{'⏳ ' if rl else ''}Claude Code: {name} [{sid}]"
        key = f"claude-code:{sid}"

        task_id = _find_task_id(existing, sid)
        if not task_id:
            args = [HERMES_BIN, "kanban", "--board", BOARD, "create", title,
                    "--body", body, "--created-by", "warp-sync",
                    "--idempotency-key", key, "--json"]
            if state in ("blocked", "failed", "stopped") or s.get("waitingFor") or st.get("needs"):
                args += ["--initial-status", "blocked"]
            code, out, err = _run(args, timeout=60)
            m = re.search(r"\b(t_[0-9a-f]+|t\d+)\b", out + err)
            task_id = m.group(1) if m else None
            changed += 1
            if task_id:
                status_by_id[task_id] = "blocked" if "--initial-status" in args else "ready"

        if not task_id:
            continue

        # Keep the card body + title fresh (live state, Warp link, ⏳ badge).
        _refresh_body(task_id, body, title=title)

        # Map Claude live state -> desired kanban status, act only on change.
        # Use direct SQLite status writes (no comment spam from CLI verbs).
        cur = status_by_id.get(task_id)
        if state == "done":
            if cur != "done":
                _set_status(task_id, "done")
                changed += 1
        elif state in ("failed", "stopped", "blocked"):
            if cur != "blocked":
                _set_status(task_id, "blocked")
                changed += 1
        elif state == "working" or s.get("status") == "busy":
            # Session is actively working = not waiting on you. Clear a stale
            # blocked flag back to ready (a stable resting state). Never use
            # `claim` — it auto-releases and flips the card every tick.
            if cur in ("blocked", "todo", "scheduled"):
                _set_status(task_id, "ready")
                changed += 1

    # Silent on no-op ticks (watchdog pattern): only emit when something
    # actually changed or a service is down, so the 1-min cron stays quiet.
    bridge = _bridge_alive()
    dash = _dashboard_alive()
    if changed or not bridge or not dash:
        print(f"Kanban sync: {len(agents)} Claude sessions, {changed} card change(s), "
              f"Warp bridge {'UP' if bridge else 'DOWN'}, "
              f"dashboard {'UP' if dash else 'DOWN'}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
