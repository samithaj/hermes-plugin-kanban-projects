#!/usr/bin/env python3
"""
Warp Kanban Bridge
==================

A tiny loopback HTTP server that turns a clickable link in the Hermes Kanban
board into a real Warp terminal attached to the matching Claude Code session.

Flow when you click a card's "Open in Warp" link:

    browser → GET http://127.0.0.1:9777/open/<claude_job_id>
        → look up the session's working directory from
          ~/.claude/jobs/<id>/state.json
        → write a Warp launch configuration to
          ~/.warp/launch_configurations/cc-<id>.yaml  (cwd + commands)
        → run `open "warp://launch/cc-<id>"` (Warp.app handles the scheme)
        → return a small "Opening Warp…" HTML page

The launch config opens a terminal in the session's repo and runs:

    claude logs <id>      # show recent output / current status
    claude attach <id>    # drop you straight into the live Claude session

so you land exactly where that agent left off and can give it more work.

Runs on a fixed loopback port (default 9777). Started/kept alive by the
1-minute sync cron job (see sync_claude_kanban.py), so it survives restarts
without a separate launchd plist.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

shlex_quote = shlex.quote

PORT = int(os.environ.get("WARP_KANBAN_BRIDGE_PORT", "9777"))
HOME = Path.home()
JOBS_DIR = HOME / ".claude" / "jobs"
WARP_LAUNCH_DIR = HOME / ".warp" / "launch_configurations"
# Per-session focus records: <job_id>.focus holds two lines —
#   line 1: WARP_FOCUS_URL  (warp://session/<uuid>) of the tab we opened
#   line 2: the tab's shell PID
# Written by the launched tab itself, removed on tab close (trap EXIT).
WARP_SESSIONS_DIR = HOME / ".hermes" / "warp-sessions"
# Per-session launcher scripts fired via warp://action/new_tab?path=<script>.
# Using new_tab (not warp://launch) is what makes a FRESH open land as a TAB in
# the CURRENT window instead of spawning a whole new window — verified against
# Warp source: warp://launch hardcodes open_in_active_window:false (always new
# window), while new_tab reuses primary_window_id and runs an executable file.
WARP_LAUNCHERS_DIR = WARP_SESSIONS_DIR / "launchers"
# Records written by the Claude Code hook (emit_warp_uuid.sh), keyed by the
# FULL Claude session id. Two lines: focus URL + raw Warp uuid. These cover
# tabs you opened by hand (not just bridge-launched ones).
WARP_BY_CLAUDE_DIR = WARP_SESSIONS_DIR / "by-claude"
CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
CUA_DRIVER = os.environ.get("CUA_DRIVER_BIN", "cua-driver")

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")
_FOCUS_URL_RE = re.compile(r"^warp://session/[0-9a-fA-F]{32}$")
_UUID_RE = re.compile(r"^[0-9a-fA-F]{32}$")
_SESSION_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_INJECT_LOCK = threading.Lock()

# Short-TTL memo for the expensive recursive transcript scans. A single
# dashboard click resolves the same session id ~8 times (resume-id lookup,
# transcript check, focus scan, open-command, …), each otherwise doing a
# recursive `~/.claude/projects/**` glob + transcript read. The TTL is short so
# session-state changes are still picked up on the next click.
_SCAN_TTL = 5.0
_SCAN_CACHE: dict[str, tuple[float, object]] = {}
_SCAN_LOCK = threading.Lock()


def _scan_cached(key: str, compute):
    now = time.time()
    with _SCAN_LOCK:
        hit = _SCAN_CACHE.get(key)
        if hit is not None and now - hit[0] < _SCAN_TTL:
            return hit[1]
    val = compute()
    with _SCAN_LOCK:
        _SCAN_CACHE[key] = (now, val)
    return val


def _safe_id(raw: str) -> str | None:
    raw = unquote(raw).strip().strip("/")
    return raw if _ID_RE.match(raw) else None


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False
    except PermissionError:
        return True  # exists, owned by someone else


def _full_session_id(job_id: str) -> str | None:
    """Resolve a short Agent-View job id (e.g. 96d34e26) to the full Claude
    session id (e.g. 96d34e26-6f64-...) via ~/.claude/jobs/<id>/state.json.

    If job_id already looks like a full session id, return it as-is.
    """
    try:
        data = json.loads((JOBS_DIR / job_id / "state.json").read_text())
        sid = data.get("sessionId") or data.get("resumeSessionId")
        if sid:
            return str(sid)
    except Exception:
        pass
    # job_id may already be a full session id passed straight through.
    return job_id if _SESSION_UUID_RE.match(job_id) else None


def _transcript_paths(session_id: str):
    """Yield Claude transcript files for a full session UUID."""
    if not _SESSION_UUID_RE.match(session_id):
        return
    yield from Path.home().glob(f".claude/projects/**/{session_id}.jsonl")


def _transcript_has_real_turns(session_id: str) -> bool:
    """True when the UUID transcript has non-metadata conversation entries."""
    return _scan_cached(f"turns:{session_id}", lambda: _compute_transcript_has_real_turns(session_id))


def _compute_transcript_has_real_turns(session_id: str) -> bool:
    for path in _transcript_paths(session_id):
        try:
            with path.open(errors="ignore") as fh:
                for line in fh:
                    if not line.strip():
                        continue
                    try:
                        typ = json.loads(line).get("type")
                    except Exception:
                        return True
                    if typ not in {"ai-title", "agent-name", "last-prompt", "mode", "permission-mode", "bridge-session"}:
                        return True
        except Exception:
            continue
    return False


def _transcript_cwd(session_id: str) -> str:
    """Find cwd embedded in a UUID transcript, if any."""
    return _scan_cached(f"cwd:{session_id}", lambda: _compute_transcript_cwd(session_id))


def _compute_transcript_cwd(session_id: str) -> str:
    for path in _transcript_paths(session_id):
        try:
            with path.open(errors="ignore") as fh:
                for line in fh:
                    try:
                        data = json.loads(line)
                    except Exception:
                        continue
                    cwd = data.get("cwd")
                    if cwd and Path(str(cwd)).is_dir():
                        return str(cwd)
                    attachment = data.get("attachment")
                    if isinstance(attachment, dict):
                        stdout = str(attachment.get("stdout") or "")
                        m = re.search(r'\"cwd\":\"([^\"]+)\"', stdout)
                        if m and Path(m.group(1)).is_dir():
                            return m.group(1)
        except Exception:
            continue
    return ""


def _warp_uuid_alive(uuid: str) -> bool:
    """True if this Warp tab's uuid belongs to an ACTUALLY-OPEN tab.

    Naive "any process carries the uuid in its env" is WRONG: Claude Code spawns
    detached background daemons (`--bg-pty-host`, `--bg-spare`), MCP servers, and
    other children that INHERIT `WARP_TERMINAL_SESSION_UUID` from the tab shell
    and KEEP RUNNING long after the tab is closed. Firing warp://session/<uuid>
    for such a uuid makes Warp open a NEW window (it logs "session deep link
    could not find pane with given UUID").

    The reliable discriminator: a real open tab has at least one process on a
    real controlling TTY (ttysNNN). Detached daemons have tty `??`. So require a
    uuid-carrying process WITH a real tty.
    """
    if not _UUID_RE.match(uuid):
        return False
    try:
        # pid, tty, then full env+cmd on each line.
        out = subprocess.run(
            ["ps", "eww", "-axo", "tty=,command="],
            capture_output=True, text=True, timeout=6,
        ).stdout
    except Exception:
        return False
    needle = f"WARP_TERMINAL_SESSION_UUID={uuid}"
    for line in out.splitlines():
        if needle not in line:
            continue
        tty = line.split(None, 1)[0] if line.split() else "??"
        # Real terminal → ttys000 etc.; detached daemon → "??".
        if tty and tty != "??" and "ttys" in tty:
            return True
    return False


def _shell_pid_alive(pid: int) -> bool:
    """True if the tab's login-shell PID is alive AND still on a real ttys.

    The login shell is the process Warp SIGHUPs when the tab closes, so this is
    a clean, fast liveness check. The ttys guard defends against PID recycling:
    a recycled PID would have to be both alive AND sitting on a real terminal to
    fool us, which is vanishingly unlikely for a stale tab record.
    """
    if pid <= 1:
        return False
    try:
        os.kill(pid, 0)
    except (OSError, ProcessLookupError):
        return False
    except PermissionError:
        pass  # exists, owned by someone else — treat as alive
    try:
        tty = subprocess.run(
            ["ps", "-o", "tty=", "-p", str(pid)],
            capture_output=True, text=True, timeout=4,
        ).stdout.strip()
    except Exception:
        return False
    return tty.startswith("ttys")


def _focus_url_from_hook(job_id: str) -> str | None:
    """Preferred path: read the Claude-hook record keyed by full session id.

    Covers ANY tab the session ran in — including ones you opened by hand —
    because the emit_warp_uuid.sh hook fires regardless of how the tab started.

    Record format (3 lines): focus-url, raw uuid, login-shell-pid.
    Liveness:
      1. If a login-shell PID is present → os.kill(pid,0) + still-on-ttys. This
         is the clean primitive (the login shell dies on tab close).
      2. Otherwise (or PID dead) → fall back to the uuid/tty process scan.
    """
    sid = _full_session_id(job_id)
    if not sid:
        return None
    rec = WARP_BY_CLAUDE_DIR / f"{sid}.focus"
    try:
        lines = rec.read_text().splitlines()
        url = lines[0].strip()
        uuid = lines[1].strip()
    except Exception:
        return None
    shell_pid = 0
    if len(lines) >= 3 and lines[2].strip().isdigit():
        shell_pid = int(lines[2].strip())
    if not _FOCUS_URL_RE.match(url) or not _UUID_RE.match(uuid):
        return None

    alive = _shell_pid_alive(shell_pid) if shell_pid else False
    if not alive:
        # PID absent/dead — fall back to the uuid/tty scan (covers records
        # written before the shell-PID field existed, and edge cases).
        alive = _warp_uuid_alive(uuid)

    if not alive:
        try:
            rec.unlink()  # stale: tab closed
        except Exception:
            pass
        return None
    return url


def _focus_url_from_running_attach(job_id: str) -> str | None:
    """Find an open Warp tab already running `claude attach <job_id>`.

    New bridge opens intentionally run a *direct* `claude attach ...` command so
    Warp can detect Claude and enable the CLI-agent helper footer. We no longer
    need the launcher script to write a focus record; the running Claude process
    inherits WARP_FOCUS_URL, and requiring a real ttys prevents stale daemon hits.
    """
    try:
        out = subprocess.run(
            ["ps", "eww", "-axo", "tty=,command="],
            capture_output=True, text=True, timeout=6,
        ).stdout
    except Exception:
        return None

    resume_id = _session_resume_id(job_id)
    patterns = [r"(?:^|\s)claude\s+attach\s+" + re.escape(job_id) + r"(?:\s|$)"]
    if resume_id:
        patterns.append(r"(?:^|\s)claude\s+(?:--resume|-r)\s+" + re.escape(resume_id) + r"(?:\s|$)")
    attach_re = re.compile("|".join(patterns))
    focus_re = re.compile(r"(?:^|\s)WARP_FOCUS_URL=(warp://session/[0-9a-fA-F]{32})(?:\s|$)")
    uuid_re = re.compile(r"(?:^|\s)WARP_TERMINAL_SESSION_UUID=([0-9a-fA-F]{32})(?:\s|$)")
    for line in out.splitlines():
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        tty, rest = parts
        if not tty.startswith("ttys"):
            continue
        if not attach_re.search(rest):
            continue
        focus = focus_re.search(rest)
        uuid = uuid_re.search(rest)
        if not focus:
            continue
        if uuid and not _warp_uuid_alive(uuid.group(1)):
            continue
        return focus.group(1)
    return None


def _existing_focus_url(job_id: str) -> str | None:
    """Return a focus deep link for this job's Warp tab if one is still open.

    Resolution order:
      1. Claude-hook record (by full session id) — covers manually-opened tabs.
      2. Live `claude attach <job_id>` process scan — supports the direct-command
         bridge path that lets Warp show Rich Input/File explorer.
      3. Legacy bridge-launched record (by short job id, PID liveness) — fallback
         for old wrapper-script tabs.
    """
    # 1) Hook-written record (preferred, broader coverage).
    hooked = _focus_url_from_hook(job_id)
    if hooked:
        return hooked

    # 2) Direct-command tabs opened by the fixed bridge.
    running = _focus_url_from_running_attach(job_id)
    if running:
        return running

    # 3) Legacy bridge-launched record: <job_id>.focus (URL + shell PID).
    rec = WARP_SESSIONS_DIR / f"{job_id}.focus"
    try:
        lines = rec.read_text().splitlines()
        url = lines[0].strip()
        pid = int(lines[1].strip())
    except Exception:
        return None
    if not _FOCUS_URL_RE.match(url):
        return None
    if not _pid_alive(pid):
        try:
            rec.unlink()
        except Exception:
            pass
        return None
    return url



def _session_cwd(job_id: str) -> str:
    """Resolve the working directory for a Claude job or full session UUID."""
    state = JOBS_DIR / job_id / "state.json"
    try:
        data = json.loads(state.read_text())
        cwd = data.get("cwd") or data.get("originCwd")
        if cwd and Path(cwd).is_dir():
            return cwd
    except Exception:
        pass
    sid = _full_session_id(job_id)
    if sid:
        cwd = _transcript_cwd(sid)
        if cwd:
            return cwd
    return str(HOME)


def _session_name(job_id: str) -> str:
    try:
        data = json.loads((JOBS_DIR / job_id / "state.json").read_text())
        return data.get("name") or job_id
    except Exception:
        cwd = _session_cwd(job_id)
        if cwd and cwd != str(HOME):
            return Path(cwd).name
        return job_id


def _write_launcher(job_id: str, cwd: str, name: str, initial_text: str | None = None) -> Path:
    """Write an executable launcher script for this session.

    Fired via `warp://action/new_tab?path=<script>` which opens it as a TAB in
    the CURRENT Warp window (not a new window) and runs it. The script:
      1. cd's into the session repo,
      2. records this tab's focus URL + login-shell PID so a later click can
         RE-FOCUS this exact tab (warp://session/<uuid>),
      3. removes that record on exit (trap), so a click after you close the tab
         opens fresh,
      4. shows recent status, then attaches to the live Claude session.
    Must be a real executable file — Warp's new_tab only runs `path.is_file()`.
    """
    WARP_LAUNCHERS_DIR.mkdir(parents=True, exist_ok=True)
    focus_rec = WARP_SESSIONS_DIR / f"{job_id}.focus"
    fr = shlex_quote(str(focus_rec))
    cwd_q = shlex_quote(cwd)
    command, _consumed, _post_start_prompt = _claude_open_command(job_id, initial_text)
    command = _wrap_resume_full_session_choice(command)
    script = (
        "#!/bin/bash\n"
        f"cd {cwd_q} 2>/dev/null || cd \"$HOME\"\n"
        f"mkdir -p {shlex_quote(str(WARP_SESSIONS_DIR))}\n"
        # record focus url + this shell's pid (login shell of the new tab)
        f"printf '%s\\n%s\\n' \"$WARP_FOCUS_URL\" \"$$\" > {fr} 2>/dev/null || true\n"
        f"trap 'rm -f {fr}' EXIT\n"
        f"echo '── Claude session {job_id} ──'\n"
        f"{CLAUDE_BIN} logs {shlex_quote(job_id)} 2>/dev/null | tail -40\n"
        "echo; echo '── attaching (Ctrl+Z to detach) ──'\n"
        f"exec {command}\n"
    )
    # Use .command so Finder/Warp treat it as runnable; chmod +x so is_file→exec.
    path = WARP_LAUNCHERS_DIR / f"cc-{job_id}.command"
    path.write_text(script)
    path.chmod(0o755)
    return path


def _cua_call(tool: str, payload: dict, timeout: int = 20) -> dict:
    """Call cua-driver one-shot JSON tool and return parsed JSON when present.

    Some input tools can perform the action successfully but print an empty or
    non-JSON acknowledgement. Treat that as success instead of converting it
    into a misleading JSON parse failure after the keystroke already happened.
    """
    result = subprocess.run(
        [CUA_DRIVER, "call", tool, json.dumps(payload)],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()
    if result.returncode != 0:
        raise RuntimeError(stderr or stdout or f"cua-driver {tool} failed")
    if not stdout:
        return {"ok": True}
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return {"ok": True, "raw": stdout}


def _session_terminal_state(job_id: str) -> tuple[str, str]:
    """Return (state, detail) from ~/.claude/jobs/<job>/state.json."""
    try:
        data = json.loads((JOBS_DIR / job_id / "state.json").read_text())
        return str(data.get("state") or ""), str(data.get("detail") or data.get("error") or "")
    except Exception:
        return "", ""


def _session_resume_id(job_id: str) -> str:
    try:
        data = json.loads((JOBS_DIR / job_id / "state.json").read_text())
        return str(data.get("resumeSessionId") or data.get("sessionId") or "")
    except Exception:
        # Dashboard can pass an interactive/full Claude session UUID. There is
        # no ~/.claude/jobs/<uuid>/state.json for that case; resume the UUID
        # directly when a real transcript exists.
        if _SESSION_UUID_RE.match(job_id) and _transcript_has_real_turns(job_id):
            return job_id
        return ""


def _session_has_real_transcript(job_id: str) -> bool:
    """True only when Claude has actual conversation turns to resume.

    Some Agent View jobs have a UUID-named jsonl containing only ai-title /
    agent-name metadata. `claude --resume <uuid>` then says "No conversation
    found". Treat those as non-resumable and start a fresh CLI session with the
    saved summary instead.
    """
    resume_id = _session_resume_id(job_id)
    if not resume_id:
        return False
    return _transcript_has_real_turns(resume_id)


def _session_at_permission_gate(job_id: str) -> bool:
    """True if the LIVE session is parked on a permission/trust/elicitation gate
    rather than the normal conversation input.

    Pressing Enter at such a gate selects the highlighted option (e.g. "Yes,
    trust this folder" / "Allow tool"), so the send path must never auto-submit
    into it. A plain "needs your reply" wait (the agent asked a question) is NOT
    a gate and is fine to answer. Reads `claude agents --json --all` because
    status/waitingFor live there, not in state.json.
    """
    try:
        out = subprocess.run(
            [CLAUDE_BIN, "agents", "--json", "--all"],
            capture_output=True, text=True, timeout=15,
        ).stdout
        for e in json.loads(out):
            if e.get("id") != job_id and e.get("sessionId") != job_id:
                continue
            wf = str(e.get("waitingFor") or "").lower()
            st = str(e.get("status") or "").lower()
            gate_words = ("permission", "trust", "approve", "allow", "elicit", "tool use")
            return any(w in wf for w in gate_words) or st in ("permission", "elicitation")
    except Exception:
        pass
    return False


def _refuse_terminal_session(job_id: str) -> tuple[int, str] | None:
    """Refuse a send only when the session truly cannot receive the message.

    Reconciled with _claude_open_command, which now resumes ANY terminal state
    (failed/done/stopped) that has a real transcript, and starts a fresh
    summary-seeded session for *failed* jobs whose transcript is empty. So the
    only thing left to refuse is a done/stopped job with no resumable
    transcript — there we should NOT silently fresh-spawn a finished task.
    """
    state, detail = _session_terminal_state(job_id)
    resume_id = _session_resume_id(job_id)
    if state not in ("failed", "done", "stopped"):
        return None
    if resume_id and _session_has_real_transcript(job_id):
        return None  # resumable → allow (claude --resume)
    if state == "failed":
        return None  # non-resumable failure → fresh session seeded with summary
    return 409, json.dumps({
        "ok": False,
        "error": f"session is {state} with no resumable transcript; not sending to Claude",
        "job_id": job_id,
        "detail": detail,
        "resume_id": resume_id,
        "hint": "Nothing to resume for this finished session. Start a new session instead.",
    })


def _claude_open_command(
    job_id: str,
    initial_text: str | None = None,
    *,
    bake_resume_prompt: bool = True,
) -> tuple[str, bool, str | None]:
    """Return (shell_command, consumes_initial_text, post_start_prompt).

    Live jobs use `claude attach <short-id>` and receive the dashboard prompt
    after attach. Failed jobs with a real transcript use `claude --resume <uuid>`.
    Failed jobs with only title/name metadata cannot resume; start a clean
    interactive `claude` session and inject the saved summary + dashboard prompt
    after the Claude UI starts. That avoids putting the whole prompt in the
    visible shell command or shell history, and prevents zsh from seeing it.

    `bake_resume_prompt=False` forces a bare `--resume` for resumable sessions
    even when `initial_text` is given: a DRAFT (compose) must open the session
    without auto-submitting, so the caller types the text afterwards with Enter
    withheld. Baking the prompt into `claude --resume <uuid> <prompt>` would run
    and submit it immediately, which is the opposite of a draft.
    """
    state, detail = _session_terminal_state(job_id)
    resume_id = _session_resume_id(job_id)
    # Full UUIDs for interactive Claude sessions are not Agent View job ids;
    # `claude attach <uuid>` fails with "No job matching". Resume them directly.
    if not state and resume_id == job_id and _SESSION_UUID_RE.match(job_id):
        prompt = (initial_text or "").strip()
        if prompt and bake_resume_prompt:
            return f"{CLAUDE_BIN} --resume {shlex_quote(resume_id)} {_prompt_arg_from_file(prompt, resume_id)}", True, None
        return f"{CLAUDE_BIN} --resume {shlex_quote(resume_id)}", False, None
    # done/stopped/failed sessions can't be `claude attach`ed ("can't start").
    # Resume them into a live session when there's a real transcript; otherwise
    # start a fresh session seeded with the saved summary.
    terminal = state in ("failed", "done", "stopped")
    if terminal and resume_id and _session_has_real_transcript(job_id):
        prompt = (initial_text or "").strip()
        if prompt and bake_resume_prompt:
            return f"{CLAUDE_BIN} --resume {shlex_quote(resume_id)} {_prompt_arg_from_file(prompt, resume_id)}", True, None
        return f"{CLAUDE_BIN} --resume {shlex_quote(resume_id)}", False, None
    if terminal:
        prompt = (initial_text or "").strip()
        summary = detail.strip()
        combined = prompt
        if summary:
            combined = (
                f"Previous {state} Agent View session {job_id} could not be resumed. Saved summary:\n"
                f"{summary}\n\nUser prompt:\n{prompt}"
            )
        return CLAUDE_BIN, True, combined
    return f"{CLAUDE_BIN} attach {shlex_quote(job_id)}", False, None


def _warp_pid() -> int:
    """Return the running Warp app pid from cua-driver/list_apps or ps fallback."""
    try:
        data = _cua_call("list_apps", {}, timeout=20)
        apps = data.get("apps", data if isinstance(data, list) else [])
        for app in apps:
            bundle = str(app.get("bundle_id") or app.get("bundleIdentifier") or "")
            name = str(app.get("name") or "")
            if app.get("running") and (bundle == "dev.warp.Warp-Stable" or "warp" in name.lower() or "warp" in bundle.lower()):
                pid = int(app.get("pid") or 0)
                if pid > 0:
                    return pid
    except Exception:
        pass
    out = subprocess.run(["pgrep", "-f", "/Applications/Warp.app/Contents/MacOS/stable$"], capture_output=True, text=True, timeout=5).stdout
    for line in out.splitlines():
        if line.strip().isdigit():
            return int(line.strip())
    raise RuntimeError("Warp is not running or cua-driver cannot find Warp")


def _cua_type_warp(text: str) -> None:
    _cua_call("type_text", {"pid": _warp_pid(), "text": text, "delay_ms": 0}, timeout=30)


def _cua_key_warp(key: str) -> None:
    _cua_call("press_key", {"pid": _warp_pid(), "key": key}, timeout=20)


def _prompt_arg_from_file(text: str, prefix: str) -> str:
    """Write prompt text to a short-lived file and return a shell arg that reads it.

    Claude Code requires a prompt argument when resuming some interactive/full
    UUID sessions. Putting dashboard text directly in the visible Warp command
    leaks it into shell history; this keeps the visible command direct (`claude
    --resume ...`) while passing the prompt through a temp file that is removed
    during shell expansion.
    """
    WARP_SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    # Best-effort sweep: the `$(cat …; rm -f …)` arg self-deletes the file on a
    # successful launch, but a launch that never runs (Warp closed, `open`
    # failed, expect aborted) would otherwise leave the prompt text on disk
    # forever. Drop anything older than an hour so leaked prompts can't pile up.
    cutoff = time.time() - 3600
    for stale in WARP_SESSIONS_DIR.glob("prompt-*.txt"):
        try:
            if stale.stat().st_mtime < cutoff:
                stale.unlink()
        except Exception:
            pass
    safe_prefix = re.sub(r"[^A-Za-z0-9_.-]", "-", prefix)[:64] or "prompt"
    path = WARP_SESSIONS_DIR / f"prompt-{safe_prefix}-{int(time.time() * 1000)}.txt"
    path.write_text(text)
    try:
        path.chmod(0o600)
    except Exception:
        pass
    q = shlex_quote(str(path))
    return f'"$(cat {q}; rm -f {q})"'


def _tcl_dq(s: str) -> str:
    """Quote a string as a Tcl double-quoted word with NO substitution.

    Tcl performs `$var` and `[cmd]` substitution inside `"..."` exactly as it
    does for bare words, so a shell command that contains `$(...)` or `$VAR`
    must have those metacharacters backslash-escaped or Tcl aborts with
    "can't read ...: no such variable" *before the command is ever spawned*.
    `json.dumps` escapes `"` and `\\` (JSON rules) but NOT `$`/`[` — that was the
    bug that broke every resume-with-prompt send. Escape backslash first, then
    the Tcl specials.
    """
    esc = (
        s.replace("\\", "\\\\")
        .replace("$", "\\$")
        .replace("[", "\\[")
        .replace("]", "\\]")
        .replace('"', '\\"')
    )
    return f'"{esc}"'


def _wrap_resume_full_session_choice(command: str) -> str:
    """Auto-select Claude Code's old/large-session resume option 2.

    Claude sometimes prompts:
      1. Resume from summary (recommended)
      2. Resume full session as-is
      3. Don't ask me again

    Sam wants option 2 always. Use expect so we only send `2<Enter>` if that
    prompt text appears; otherwise the process falls through to normal
    interactive mode without injecting stray input.
    """
    if " --resume " not in f" {command} ":
        return command
    expect_bin = "/usr/bin/expect"
    if not Path(expect_bin).exists():
        return command
    # Build a SINGLE-LINE Tcl program: the CUA open path types this command into
    # a Warp shell keystroke-by-keystroke, so any embedded newline would submit
    # early. `;` separates Tcl statements; the `expect {...}` branches are
    # space-separated. The inner zsh command is wrapped with `_tcl_dq` (not
    # `json.dumps`) so its `$(cat …; rm -f …)` prompt-file read reaches zsh
    # instead of being (mis)interpreted by Tcl. `interact` right after answering
    # the menu hands the tty straight to the user; a short timeout keeps the
    # no-menu common case from blocking input for 10s.
    inner = _tcl_dq("exec " + command)
    tcl = (
        "set timeout 4 ; "
        f"spawn -noecho /bin/zsh -lc {inner} ; "
        "expect { "
        "-re {Resume full session as-is} { send \"2\\r\" ; interact } "
        "timeout { interact } "
        "eof { catch wait result ; exit [lindex $result 3] } "
        "}"
    )
    return f"{expect_bin} -c {shlex_quote(tcl)}"


def _open_warp_new_tab(job_id: str, cwd: str, name: str, initial_text: str | None = None,
                       *, bake_resume_prompt: bool = True) -> bool:
    """Open a fresh Warp tab and start Claude via cua-driver.

    No osascript/System Events: CuaDriver owns Accessibility and sends text/key
    events to Warp's pid, avoiding the detached-daemon TCC failure.
    """
    command, consumed, post_start_prompt = _claude_open_command(
        job_id, initial_text, bake_resume_prompt=bake_resume_prompt
    )
    # Auto-answer Claude's "Resume full session as-is" menu so a large/old
    # session resumed here does not hang waiting for a selection. The wrapper is
    # a no-op for `claude attach …` / fresh `claude` commands (no `--resume`),
    # and is single-line so it survives being typed keystroke-by-keystroke.
    command = _wrap_resume_full_session_choice(command)
    subprocess.run(["/usr/bin/open", f"warp://action/new_tab?path={quote(cwd)}"], check=False, timeout=10)
    time.sleep(1.4)
    _cua_type_warp(command)
    _cua_key_warp("return")
    if post_start_prompt:
        # Wait for Claude's interactive prompt to initialize, then send the
        # dashboard text into Claude (not zsh). This keeps the visible command
        # clean (`claude`) and avoids shell history containing prompt content.
        time.sleep(5.0)
        _cua_type_warp(post_start_prompt)
        _cua_key_warp("return")
    return consumed


def _open_warp_wrapper_launcher(job_id: str, cwd: str, name: str, initial_text: str | None = None) -> None:
    """Open the legacy .command launcher fallback in Warp.

    This is for OPENING only. It may attach/resume/start Claude and record a
    focus URL, but the send path must still wait for confirmed Claude focus
    before typing any user text.
    """
    launcher = _write_launcher(job_id, cwd, name, initial_text=initial_text)
    subprocess.run(
        ["/usr/bin/open", f"warp://action/new_tab?path={quote(str(launcher))}"],
        check=False,
        timeout=10,
    )


def _focus_warp(focus_url: str) -> None:
    """Focus an already-open Warp tab via warp://session/<uuid>."""
    subprocess.run(["/usr/bin/open", focus_url], check=False, timeout=10)


def _pbcopy(text: str) -> None:
    subprocess.run(["/usr/bin/pbcopy"], input=text, text=True, check=True, timeout=5)


def _pbpaste_text() -> str | None:
    try:
        p = subprocess.run(["/usr/bin/pbpaste"], capture_output=True, text=True, timeout=5)
        if p.returncode == 0 and p.stdout:
            return p.stdout
    except Exception:
        pass
    return None


def _wait_for_focus(job_id: str, deadline_seconds: float = 16.0) -> str | None:
    deadline = time.time() + deadline_seconds
    while time.time() < deadline:
        focus = _existing_focus_url(job_id)
        if focus:
            return focus
        time.sleep(0.35)
    return None


def _resume_prompt_must_be_command_arg(job_id: str) -> bool:
    """True when a cold send must pass the prompt as `claude --resume <uuid> <prompt>`.

    Full interactive UUIDs and terminal Agent View jobs with real transcripts are
    not attachable. Running plain `claude --resume <uuid>` exits with "Provide a
    prompt" on this Claude version, so a cold send has to start the resumed
    session with the prompt as an argument. That command must be launched via the
    wrapper file, not frontmost CUA typing, or it can land in an unrelated live
    Claude tab before the focus guard exists.
    """
    state, _detail = _session_terminal_state(job_id)
    resume_id = _session_resume_id(job_id)
    if not resume_id or not _session_has_real_transcript(job_id):
        return False
    if not state and resume_id == job_id and _SESSION_UUID_RE.match(job_id):
        return True
    return state in ("failed", "done", "stopped")


def _focus_and_inject(job_id: str, text: str, *, submit: bool) -> tuple[int, str]:
    """Focus/open Warp and send text using cua-driver, never osascript."""
    if not text.strip():
        return 400, json.dumps({"ok": False, "error": "empty text"})
    refused = _refuse_terminal_session(job_id)
    if refused:
        return refused
    with _INJECT_LOCK:
        opened = False
        focus = _existing_focus_url(job_id)
        if not focus:
            if submit and _resume_prompt_must_be_command_arg(job_id):
                # For full UUID / terminal resume sends, the prompt has to be
                # supplied as the initial `claude --resume ... <prompt>` arg. Do
                # that with the keystroke-free wrapper launcher so CUA never
                # types a command/prompt into whatever Warp tab is currently
                # frontmost.
                try:
                    _open_warp_wrapper_launcher(job_id, _session_cwd(job_id), _session_name(job_id), initial_text=text)
                except Exception as exc:
                    return 500, json.dumps({"ok": False, "job_id": job_id, "error": "failed to open resume wrapper", "detail": str(exc)})
                # The launcher delivers the prompt as the `claude --resume …
                # <prompt>` arg at exec time, but `open warp://…` is
                # fire-and-forget — so confirm the tab actually came up (the
                # launcher records its focus URL before exec) before telling the
                # dashboard the message was sent. Otherwise a failed launch (Warp
                # closed, launcher errored) is silently reported as success.
                focus = _wait_for_focus(job_id, deadline_seconds=24.0)
                if not focus:
                    return 504, json.dumps({
                        "ok": False, "job_id": job_id, "opened": True, "submitted": False,
                        "driver": "wrapper-launcher",
                        "error": "resume launcher fired but Claude never came up — message not confirmed",
                        "hint": "Open the session in Warp, wait for Claude to attach, then retry Send to Claude.",
                    })
                return 200, json.dumps({"ok": True, "job_id": job_id, "submitted": True, "opened": True, "driver": "wrapper-launcher", "mode": "resume-with-prompt"})
            try:
                # A draft (submit=False) must NOT bake the prompt into an
                # auto-running `--resume <uuid> <prompt>` command; open bare and
                # type the draft below with Enter withheld.
                consumed = _open_warp_new_tab(
                    job_id, _session_cwd(job_id), _session_name(job_id),
                    initial_text=text, bake_resume_prompt=submit,
                )
                opened = True
                if consumed:
                    mode = "resume-with-prompt" if _session_has_real_transcript(job_id) else "fresh-failed-session"
                    return 200, json.dumps({"ok": True, "job_id": job_id, "submitted": submit, "opened": True, "driver": "cua-driver", "mode": mode})
            except Exception as exc:
                # Opening fallback only: use the legacy .command wrapper if CUA
                # cannot type the direct command. Do NOT type the dashboard text
                # here; the send path still waits for a confirmed Claude focus
                # target below before any user text is injected.
                try:
                    _open_warp_wrapper_launcher(job_id, _session_cwd(job_id), _session_name(job_id))
                    opened = True
                except Exception as fallback_exc:
                    return 500, json.dumps({
                        "ok": False,
                        "error": "failed to open Warp via cua-driver and wrapper fallback",
                        "detail": str(exc),
                        "fallback_detail": str(fallback_exc),
                        "hint": "Open the session manually in Warp, wait for Claude, then retry Send to Claude.",
                    })
            focus = _wait_for_focus(job_id, deadline_seconds=24.0)
            if not focus:
                return 504, json.dumps({
                    "ok": False,
                    "job_id": job_id,
                    "opened": opened,
                    "error": "Claude never attached — not typing (would land in the shell)",
                    "hint": "Session may be unresumable or still loading; open it manually, wait for Claude, then retry.",
                })
        if not focus:
            return 409, json.dumps({
                "ok": False,
                "job_id": job_id,
                "opened": opened,
                "error": "No live Claude focus target — not typing (would land in the shell)",
                "hint": "Open this session in Warp and wait until Claude is attached, then retry.",
            })
        _focus_warp(focus)
        time.sleep(0.45)
        # Permission/trust-gate guard: only press Enter when we're confident
        # Claude is at the conversation input. A freshly-opened tab may sit on a
        # startup gate (trust-folder, theme, resume-loading) and a live session
        # may be parked on a permission/elicitation prompt — in both cases the
        # trailing Enter would SELECT the highlighted option (e.g. auto-trust the
        # folder / allow a tool). So we type the text as a draft but withhold
        # Enter, and tell the caller to review and submit manually.
        gate_reason = ""
        if opened:
            gate_reason = "tab just opened — Claude may be on a startup/trust prompt"
        elif _session_at_permission_gate(job_id):
            gate_reason = "session is on a permission/approval prompt"
        do_submit = submit and not gate_reason
        try:
            _cua_type_warp(text)
            if do_submit:
                _cua_key_warp("return")
            resp = {"ok": True, "job_id": job_id, "submitted": do_submit, "opened": opened, "driver": "cua-driver"}
            if submit and not do_submit:
                resp["drafted"] = True
                resp["note"] = f"typed as draft, not auto-submitted: {gate_reason}. Review Claude in Warp and press Enter to send."
            return 200, json.dumps(resp)
        except Exception as exc:
            return 500, json.dumps({
                "ok": False,
                "error": "failed to send via cua-driver",
                "detail": str(exc),
                "opened": opened,
                "hint": "Run `hermes computer-use doctor`; Accessibility must be granted to CuaDriver.",
            })


def _open_warp_dir(cwd: str) -> None:
    """Fallback: just open a Warp tab in the directory."""
    subprocess.run(["/usr/bin/open", f"warp://action/new_tab?path={quote(cwd)}"], check=False, timeout=10)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):  # silence default stderr logging
        pass

    def _send(self, code: int, body: str, ctype: str = "text/html; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path in ("/", "/health"):
            self._send(200, json.dumps({"ok": True, "service": "warp-kanban-bridge", "port": PORT}),
                       ctype="application/json")
            return

        if path.startswith("/open/"):
            job_id = _safe_id(path[len("/open/"):])
            if not job_id:
                self._send(400, "<h3>Bad session id</h3>")
                return
            cwd = _session_cwd(job_id)
            name = _session_name(job_id)

            # REUSE: if we already have an open Warp tab for this session,
            # just focus it instead of spawning a new one.
            existing = _existing_focus_url(job_id)
            if existing:
                try:
                    _focus_warp(existing)
                    self._send(
                        200,
                        f"<!doctype html><meta charset=utf-8>"
                        f"<title>Focusing Warp…</title>"
                        f"<body style='font-family:-apple-system,system-ui;padding:2rem'>"
                        f"<h2>Focusing existing Warp tab…</h2>"
                        f"<p>Session <code>{job_id}</code> &mdash; {name}</p>"
                        f"<p style='color:#888'>You can close this tab.</p></body>",
                    )
                    return
                except Exception:
                    pass  # fall through to a fresh launch

            try:
                # Fresh open as a TAB in the current window (not a new window).
                _open_warp_new_tab(job_id, cwd, name)
            except Exception as exc:
                # If macOS Accessibility blocks osascript keystrokes, preserve
                # the old always-on behavior: open/attach via the wrapper tab.
                # That fallback attaches correctly but cannot enable Warp's
                # helper footer because the visible command is the wrapper file.
                try:
                    _open_warp_wrapper_launcher(job_id, cwd, name)
                except Exception as fallback_exc:
                    self._send(500, f"<h3>Failed to open Warp</h3><pre>{exc}</pre><pre>{fallback_exc}</pre>")
                    return
            self._send(
                200,
                f"<!doctype html><meta charset=utf-8>"
                f"<title>Opening Warp…</title>"
                f"<body style='font-family:-apple-system,system-ui;padding:2rem'>"
                f"<h2>Opening Warp…</h2>"
                f"<p>Session <code>{job_id}</code> &mdash; {name}</p>"
                f"<p style='color:#888'>Directory: <code>{cwd}</code></p>"
                f"<p style='color:#888'>You can close this tab.</p></body>",
            )
            return

        if path.startswith("/compose/") or path.startswith("/send/"):
            is_send = path.startswith("/send/")
            prefix = "/send/" if is_send else "/compose/"
            job_id = _safe_id(path[len(prefix):])
            if not job_id:
                self._send(400, json.dumps({"ok": False, "error": "bad session id"}), ctype="application/json")
                return
            text = (params.get("text") or [""])[0]
            code, body = _focus_and_inject(job_id, text, submit=is_send)
            self._send(code, body, ctype="application/json")
            return

        if path.startswith("/dir/"):
            # /dir/<urlencoded path> — open a plain Warp tab in any directory.
            raw = unquote(path[len("/dir/"):])
            if raw and Path(raw).is_dir():
                _open_warp_dir(raw)
                self._send(200, f"<h2>Opening Warp…</h2><p>{raw}</p>")
            else:
                self._send(400, "<h3>Unknown directory</h3>")
            return

        self._send(404, "<h3>Not found</h3>")


def main() -> int:
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as exc:
        # Already running (port in use) — that's fine for the watchdog path.
        print(f"warp-kanban-bridge: port {PORT} unavailable: {exc}", file=sys.stderr)
        return 0
    print(f"warp-kanban-bridge listening on http://127.0.0.1:{PORT}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
