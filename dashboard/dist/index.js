/**
 * Kanban Projects — "Mission Control" cockpit.
 *
 * UI-only dashboard plugin. Reads the live Claude-session Kanban board and a
 * human-owned project-goals board, joins them by canonical cwd path, then
 * renders a master/detail cockpit: a left rail of agents grouped by project
 * (blocked-first), and a right detail pane for the selected worktree-agent
 * (collision awareness, blocker, sub-objectives, activity, push-forward
 * composer). Goal cards stay unassigned and status=triage; the human bucket
 * lives in `Bucket:` inside the card body so the Kanban dispatcher can never
 * run a goal.
 */
(function () {
  "use strict";

  function ensureFonts() {
    try {
      if (typeof document === "undefined" || document.getElementById("mc-fonts")) return;
      const pre1 = document.createElement("link");
      pre1.rel = "preconnect"; pre1.href = "https://fonts.googleapis.com";
      const pre2 = document.createElement("link");
      pre2.rel = "preconnect"; pre2.href = "https://fonts.gstatic.com"; pre2.crossOrigin = "";
      const link = document.createElement("link");
      link.id = "mc-fonts";
      link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap";
      document.head.appendChild(pre1);
      document.head.appendChild(pre2);
      document.head.appendChild(link);
    } catch (_e) {}
  }

  function boot() {
    const SDK = window.__HERMES_PLUGIN_SDK__;
    if (!SDK || !window.__HERMES_PLUGINS__ || typeof window.__HERMES_PLUGINS__.register !== "function") {
      setTimeout(boot, 50);
      return;
    }
    ensureFonts();

    const { React } = SDK;
    const h = React.createElement;
    const hooks = SDK.hooks || React;
    const { useCallback, useEffect, useMemo, useState } = hooks;

    const API = "/api/plugins/kanban";
    const DEFAULT_BOARD = "claude-code-work";
    const GOALS_BOARD = "project-goals";
    const WARP = "http://127.0.0.1:9777";
    const STORAGE_BOARD = "hermes-kanban-projects-board";
    const STORAGE_COMPOSE = "hermes-kanban-projects-compose-links";
    const STATUS_ORDER = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"];
    const BUCKETS = [
      { key: "now", label: "Now", rank: 50 },
      { key: "next", label: "Next", rank: 40 },
      { key: "later", label: "Later", rank: 20 },
      { key: "blocked", label: "Blocked", rank: 45 },
      { key: "done", label: "Done", rank: 0 },
    ];
    const BUCKET_LABEL = BUCKETS.reduce(function (acc, b) { acc[b.key] = b.label; return acc; }, {});

    // Accent per derived agent state, mirroring the cockpit design palette.
    const ACC = { blocked: "#f87171", idle: "#fbbf24", active: "#34d399", done: "#6b7280" };
    const STATE_FLAG = { blocked: "Needs you", active: "In motion", idle: "Idling — no next step", done: "Done" };
    const STATE_PILL = { blocked: "paused · needs you", active: "running", idle: "idle", done: "done" };
    const STATE_RANK = { blocked: 3, active: 2, idle: 1, done: 0 };

    // ---------- data layer (unchanged join logic) ----------

    function qsBoard() {
      try {
        const q = new URLSearchParams(window.location.search || "");
        return q.get("board") || localStorage.getItem(STORAGE_BOARD) || DEFAULT_BOARD;
      } catch (_e) {
        return DEFAULT_BOARD;
      }
    }

    function fetchJSON(url, opts) {
      if (SDK.fetchJSON) return SDK.fetchJSON(url, opts);
      const merged = Object.assign({ credentials: "same-origin" }, opts || {});
      return fetch(url, merged).then(function (r) {
        if (!r.ok) throw new Error(r.status + ": " + r.statusText);
        return r.json();
      });
    }

    function withBoard(url, board) {
      const sep = url.indexOf("?") === -1 ? "?" : "&";
      return url + sep + "board=" + encodeURIComponent(board || DEFAULT_BOARD);
    }

    function cleanPath(raw) {
      if (!raw) return "";
      return String(raw)
        .trim()
        .replace(/^`|`$/g, "")
        .replace(/[),.;\]]+$/g, "")
        .replace(/\/$/, "");
    }

    function basename(path) {
      if (!path) return "Unknown project";
      const parts = String(path).split("/").filter(Boolean);
      return parts[parts.length - 1] || path;
    }

    function compactPath(path) {
      if (!path) return "—";
      const marker = "/Documents/dev/";
      const idx = path.indexOf(marker);
      if (idx !== -1) return "~/Documents/dev/" + path.slice(idx + marker.length);
      const home = "/Users/sam/";
      if (path.startsWith(home)) return "~/" + path.slice(home.length);
      return path;
    }

    function fullPathKey(path) {
      const p = cleanPath(path);
      if (!p || p === "/Users/sam" || p === "__unknown__") return "";
      return p;
    }

    function lineValue(body, label) {
      const re = new RegExp("^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:\\s*(.+?)\\s*$", "im");
      const m = String(body || "").match(re);
      return m ? m[1].trim() : "";
    }

    function extractJobId(task) {
      const title = task && task.title ? String(task.title) : "";
      const m = title.match(/\[([A-Za-z0-9_-]{4,64})\]\s*$/);
      if (m) return m[1];
      const body = task && task.body ? String(task.body) : "";
      const b = body.match(/(?:job|session|Claude Code)\s*(?:id)?\s*[:#-]?\s*([A-Za-z0-9_-]{6,64})/i);
      return b ? b[1] : "";
    }

    function extractProject(task) {
      if (task && task.tenant) {
        const tenant = String(task.tenant);
        return { key: "tenant:" + tenant, label: tenant, path: tenant, source: "tenant" };
      }

      const body = task && task.body ? String(task.body) : "";
      const patterns = [
        /Directory:\s*`?([^`\n]+)`?/i,
        /Working directory:\s*`?([^`\n]+)`?/i,
        /cwd:\s*`?([^`\n]+)`?/i,
        /(\/Users\/sam\/Documents\/dev\/[^\s`\])]+)/,
      ];
      for (const re of patterns) {
        const m = body.match(re);
        if (m && m[1]) {
          const path = fullPathKey(m[1]);
          if (path) return { key: path, label: basename(path), path: path, source: "body" };
        }
      }

      const wp = fullPathKey(task && task.workspace_path);
      if (wp && wp.indexOf("/.hermes/kanban/") === -1) {
        return { key: wp, label: basename(wp), path: wp, source: "workspace" };
      }

      return { key: "__unknown__", label: "Unknown project", path: "", source: "unknown" };
    }

    function cleanTitle(task) {
      return String((task && task.title) || "")
        .replace(/^Claude Code:\s*/i, "")
        .replace(/\s*\[[A-Za-z0-9_-]{4,64}\]\s*$/, "")
        .trim() || (task && task.id) || "Untitled";
    }

    function flattenBoard(data) {
      const out = [];
      ((data && data.columns) || []).forEach(function (col) {
        (col.tasks || []).forEach(function (task) {
          out.push(Object.assign({}, task, { _column: col.name || task.status || "todo" }));
        });
      });
      return out;
    }

    function parseSessionSignals(task) {
      const body = String((task && task.body) || "");
      const stateMatch = body.match(/State:\s*`?([^`\n·]+)`?/i);
      const state = String((stateMatch && stateMatch[1]) || task.status || task._column || "").trim().replace(/`/g, "");
      const status = String(task.status || task._column || "").trim();
      let process = "";
      const processMatch = body.match(/Process:\s*`?([^`\n·]+)`?/i);
      if (processMatch) process = processMatch[1].trim();
      const waiting = (body.match(/Waiting:\s*`?([^`\n·]+)`?/i) || [])[1] || "";
      const needs = lineValue(body, "- Needs") || lineValue(body, "Needs");
      const blocked = state === "blocked" || status === "blocked";
      const needsMe = !!(String(waiting).trim() || String(needs).trim() || (blocked && process !== "busy"));
      return {
        state: state,
        process: process,
        waiting: String(waiting || "").trim(),
        needs: String(needs || "").trim(),
        needsMe: needsMe,
        working: process === "busy" || state === "working" || status === "running",
        done: state === "done" || status === "done" || status === "archived",
      };
    }

    function markdownField(body, label) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp("^\\*\\*" + escaped + "\\s*:?\\*\\*\\s*(.*?)\\s*$", "im");
      const m = String(body || "").match(re);
      if (m) return m[1].trim();
      return lineValue(body, label);
    }

    function parseGoal(task) {
      const body = String((task && task.body) || "");
      const path = fullPathKey(lineValue(body, "Path"));
      if (!path) return null;
      const rawBucket = (lineValue(body, "Bucket") || "later").toLowerCase();
      const bucket = BUCKET_LABEL[rawBucket] ? rawBucket : "later";
      const objective = markdownField(body, "Objective") || "";
      const next = markdownField(body, "Next") || "";
      const notePath = lineValue(body, "Note path");
      const obsidian = lineValue(body, "Obsidian");
      return {
        id: task.id,
        task: task,
        path: path,
        bucket: bucket,
        objective: objective,
        next: next,
        notePath: notePath,
        obsidian: obsidian,
        body: body,
        duplicateCount: 0,
      };
    }

    function replaceMarkdownField(body, label, value) {
      const src = String(body || "");
      const line = "**" + label + ":** " + (value || "");
      const re = new RegExp("^\\*\\*" + label + "\\*\\*\\s*:?\\s*.*$", "im");
      const re2 = new RegExp("^\\*\\*" + label + ":\\*\\*\\s*.*$", "im");
      const re3 = new RegExp("^" + label + "\\s*:\\s*.*$", "im");
      if (re2.test(src)) return src.replace(re2, line);
      if (re.test(src)) return src.replace(re, line);
      if (re3.test(src)) return src.replace(re3, line);
      return src.replace(/^(Bucket:.*)$/im, "$1\n" + line);
    }

    function setGoalBodyFields(body, fields) {
      const f = fields || {};
      let out = String((f.body !== undefined ? f.body : body) || "").replace(/\r\n/g, "\n");
      if (f.objective !== undefined) out = replaceMarkdownField(out, "Objective", f.objective);
      if (f.next !== undefined) out = replaceMarkdownField(out, "Next", f.next);

      const path = f.path !== undefined ? f.path : lineValue(out, "Path");
      const bucket = f.bucket !== undefined ? f.bucket : (lineValue(out, "Bucket") || "later");
      const obsidian = f.obsidian !== undefined ? f.obsidian : lineValue(out, "Obsidian");
      const notePath = f.notePath !== undefined ? f.notePath : lineValue(out, "Note path");

      // Keep routing metadata in a deterministic header. Path must remain first
      // so humans and helper scripts can identify the canonical project key.
      out = out
        .split("\n")
        .filter(function (line) { return !/^(Path|Bucket|Obsidian|Note path)\s*:/i.test(line); })
        .join("\n")
        .replace(/^\n+/, "");
      const header = [];
      if (path) header.push("Path: " + path);
      header.push("Bucket: " + bucket);
      if (obsidian) header.push("Obsidian: " + obsidian);
      if (notePath) header.push("Note path: " + notePath);
      return header.join("\n") + (out ? "\n" + out : "");
    }

    function suggestedNotePath(path) {
      const slug = basename(path).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
      return "wiki/projects/" + slug + ".md";
    }

    function obsidianHref(goal) {
      const note = goal && goal.notePath;
      if (!note) return "";
      return "obsidian://open?vault=obsidian_vault_pro&file=" + encodeURIComponent(note);
    }

    function buildGoalsByPath(goalTasks) {
      const map = new Map();
      const dupes = new Map();
      goalTasks.forEach(function (task) {
        const goal = parseGoal(task);
        if (!goal) return;
        const prev = map.get(goal.path);
        if (!prev) {
          map.set(goal.path, goal);
          dupes.set(goal.path, [goal]);
        } else {
          const arr = dupes.get(goal.path) || [prev];
          arr.push(goal);
          dupes.set(goal.path, arr);
          if ((prev.task.status === "archived" || prev.task.status === "done") && goal.task.status !== "archived" && goal.task.status !== "done") {
            map.set(goal.path, goal);
          }
        }
      });
      dupes.forEach(function (arr, path) {
        if (arr.length > 1 && map.has(path)) map.get(path).duplicateCount = arr.length;
      });
      return map;
    }

    // ---------- cockpit-specific derivations ----------

    function toMs(v) {
      if (v == null || v === "") return 0;
      if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
      const n = Number(v);
      if (!isNaN(n) && n > 0) return n < 1e12 ? n * 1000 : n;
      const p = Date.parse(v);
      return isNaN(p) ? 0 : p;
    }

    function latestMs(task) {
      return Math.max(
        toMs(task && task.completed_at),
        toMs(task && task.started_at),
        toMs(task && task.updated_at),
        toMs(task && task.created_at)
      );
    }

    function relTime(ms) {
      if (!ms) return "";
      let now;
      try { now = Date.now(); } catch (_e) { now = ms; }
      const d = Math.max(0, now - ms);
      const s = Math.round(d / 1000);
      if (s < 45) return "just now";
      const m = Math.round(s / 60);
      if (m < 60) return m + "m ago";
      const hr = Math.round(m / 60);
      if (hr < 24) return hr + "h ago";
      const days = Math.round(hr / 24);
      if (days < 7) return days + "d ago";
      return Math.round(days / 7) + "w ago";
    }

    function detectAgentKind(task) {
      const hay = String((task && task.title) || "") + " " + String((task && task.body) || "") + " " + String((task && task.tenant) || "");
      if (/\bcodex\b/i.test(hay)) return { key: "codex", label: "Codex", color: "#2dd4bf", bg: "rgba(45,212,191,.12)" };
      if (/\bcursor\b/i.test(hay)) return { key: "cursor", label: "Cursor", color: "#e5e7eb", bg: "rgba(229,231,235,.1)" };
      if (/\baider\b/i.test(hay)) return { key: "aider", label: "Aider", color: "#fbbf24", bg: "rgba(251,191,36,.12)" };
      return { key: "claude", label: "Claude Code", color: "#818cf8", bg: "rgba(99,102,241,.13)" };
    }

    function parseBranch(task) {
      const body = String((task && task.body) || "");
      const m = body.match(/(?:Branch|Worktree|Git branch)\s*:\s*`?([^\s`\n]+)`?/i);
      if (m) return m[1];
      const m2 = body.match(/\b((?:feature|feat|fix|bugfix|hotfix|spike|chore|release|wip)\/[A-Za-z0-9._\-\/]+)/);
      if (m2) return m2[1];
      return cleanTitle(task);
    }

    function agentState(signals) {
      if (!signals) return "idle";
      if (signals.needsMe) return "blocked";
      if (signals.done) return "done";
      if (signals.working) return "active";
      return "idle";
    }

    function parseChecklist(body) {
      const items = [];
      String(body || "").replace(/\r\n/g, "\n").split("\n").forEach(function (raw) {
        const m = raw.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/);
        if (m) items.push({ done: m[1].toLowerCase() === "x", text: m[2].trim() });
      });
      return items;
    }

    function checklistStats(items) {
      const total = items.length;
      const done = items.filter(function (i) { return i.done; }).length;
      return { done: done, total: total, pct: total ? Math.round((done / total) * 100) : 0 };
    }

    // The agent's own live task list (Claude Code TaskCreate/TodoWrite store),
    // which the sync packs into the session card body as a "- Tasks: a/b" block
    // of "  - [x]/[>]/[ ]" items (x=done, >=in progress, blank=pending), with an
    // optional "⛔ blocked by #N" hint on pending items.
    function parseSessionTasks(task) {
      const lines = String((task && task.body) || "").replace(/\r\n/g, "\n").split("\n");
      let started = false;
      const items = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!started) {
          if (/^\s*-\s*Tasks:\s*\d+\s*\/\s*\d+/i.test(line)) started = true;
          continue;
        }
        const m = line.match(/^\s*-\s*\[([ xX>~])\]\s*(.+?)\s*$/);
        if (m) {
          let text = m[2], blockedBy = null;
          const bm = text.match(/⛔\s*blocked by\s*([0-9,#\s]+)$/i);
          if (bm) {
            blockedBy = bm[1].replace(/#/g, "").trim().replace(/\s*,\s*/g, ", ").replace(/,\s*$/, "");
            text = text.slice(0, bm.index).trim();
          }
          const ch = m[1].toLowerCase();
          const status = ch === "x" ? "done" : (ch === ">" || ch === "~") ? "active" : "pending";
          items.push({ status: status, text: text, blockedBy: blockedBy });
          continue;
        }
        if (line.trim() === "") continue;
        break;
      }
      if (!items.length) return null;
      const done = items.filter(function (i) { return i.status === "done"; }).length;
      const inprog = items.filter(function (i) { return i.status === "active"; }).length;
      return { items: items, done: done, inprog: inprog, total: items.length, pct: Math.round(done / items.length * 100) };
    }

    function buildTimeline(task, signals, goal, sessionTasks) {
      const out = [];
      const last = task._latest || latestMs(task);
      if (signals && signals.needsMe) {
        const reason = signals.waiting ? "Waiting: " + signals.waiting
          : signals.needs ? "Needs: " + signals.needs
          : "Session paused — awaiting your input";
        out.push({ text: reason, time: relTime(last) || "now", dot: ACC.blocked });
      } else if (signals && signals.working) {
        out.push({ text: "Working — " + (signals.state || "in progress"), time: relTime(last) || "running now", dot: ACC.active });
      } else if (signals && signals.done) {
        out.push({ text: "Session finished", time: relTime(last), dot: ACC.done });
      } else {
        out.push({ text: "Idle — no next step queued", time: relTime(last), dot: ACC.idle });
      }
      const active = sessionTasks && sessionTasks.items.filter(function (i) { return i.status === "active"; })[0];
      if (active) out.push({ text: "▸ Working on: " + active.text, time: "", dot: "#818cf8" });
      const summary = (task && (task.latest_summary || task.result)) || "";
      if (summary) out.push({ text: String(summary).slice(0, 220), time: "", dot: "#60a5fa" });
      if (goal && goal.next) out.push({ text: "Next objective: " + goal.next, time: "", dot: "#a78bfa" });
      return out;
    }

    function buildPrompts(state, signals) {
      if (state === "blocked") {
        const reason = signals && (signals.waiting || signals.needs);
        return [
          { text: reason ? "You're unblocked — handle “" + reason + "” and continue" : "You're unblocked — continue the session", primary: true },
          { text: "Explain exactly what you're blocked on and the options" },
          { text: "Show me the diff / output before deciding" },
        ];
      }
      if (state === "done") {
        return [
          { text: "Open a PR and summarize the changes", primary: true },
          { text: "List any follow-ups or loose ends" },
          { text: "Start the next objective for this project" },
        ];
      }
      if (state === "active") {
        return [
          { text: "Status check — what's done and what's left?", primary: true },
          { text: "Prioritize the blocking sub-objective" },
          { text: "Flag any risks before continuing" },
        ];
      }
      return [
        { text: "Pick the next sub-objective and start it", primary: true },
        { text: "Summarize where this is and propose next steps" },
        { text: "Anything blocking you? If not, keep going" },
      ];
    }

    function groupByProject(tasks, goalsByPath) {
      const map = new Map();
      tasks.forEach(function (task) {
        const project = extractProject(task);
        let g = map.get(project.key);
        if (!g) {
          g = { key: project.key, project: project, tasks: [], counts: {}, latest: 0, rollup: { needs: 0, working: 0, done: 0 } };
          map.set(project.key, g);
        }
        const signals = parseSessionSignals(task);
        const withSignals = Object.assign({}, task, { _signals: signals, _latest: latestMs(task) });
        g.tasks.push(withSignals);
        const st = task.status || task._column || "todo";
        g.counts[st] = (g.counts[st] || 0) + 1;
        if (signals.needsMe) g.rollup.needs += 1;
        if (signals.working) g.rollup.working += 1;
        if (signals.done) g.rollup.done += 1;
        g.latest = Math.max(g.latest, withSignals._latest);
      });
      goalsByPath.forEach(function (goal, path) {
        if (map.has(path)) return;
        map.set(path, {
          key: path,
          project: { key: path, label: basename(path), path: path, source: "goal" },
          tasks: [],
          counts: {},
          latest: 0,
          rollup: { needs: 0, working: 0, done: 0 },
        });
      });
      map.forEach(function (g) { g.goal = goalsByPath.get(g.key) || null; });
      return Array.from(map.values());
    }

    function sortCockpit(groups) {
      return groups.slice().sort(function (a, b) {
        if (b.rollup.needs !== a.rollup.needs) return b.rollup.needs - a.rollup.needs;
        if (b.rollup.working !== a.rollup.working) return b.rollup.working - a.rollup.working;
        if ((b.latest || 0) !== (a.latest || 0)) return (b.latest || 0) - (a.latest || 0);
        return (a.project.path || a.project.label).localeCompare(b.project.path || b.project.label);
      });
    }

    function byAttention(a, b) {
      const ra = STATE_RANK[agentState(a._signals)], rb = STATE_RANK[agentState(b._signals)];
      if (rb !== ra) return rb - ra;
      return (b._latest || 0) - (a._latest || 0);
    }

    function warpOpen(job) { return WARP + "/open/" + encodeURIComponent(job); }
    function warpCompose(job, text) {
      return WARP + "/compose/" + encodeURIComponent(job) + (text ? "?text=" + encodeURIComponent(text) : "");
    }
    function openUrl(url) { try { window.open(url, "_blank", "noopener"); } catch (_e) {} }

    // ---------- view ----------

    function MissionControlPage() {
      const [board, setBoard] = useState(qsBoard);
      const [sessionData, setSessionData] = useState(null);
      const [goalData, setGoalData] = useState(null);
      const [goalError, setGoalError] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState(null);
      const [search, setSearch] = useState("");
      const [busy, setBusy] = useState(false);
      const [selectedId, setSelectedId] = useState(null);
      const [composeLinks, setComposeLinks] = useState(function () {
        try { return localStorage.getItem(STORAGE_COMPOSE) === "1"; } catch (_e) { return false; }
      });

      const load = useCallback(function () {
        const b = board || DEFAULT_BOARD;
        setLoading(true);
        setError(null);
        setGoalError(null);
        try { localStorage.setItem(STORAGE_BOARD, b); } catch (_e) {}
        const sessionReq = fetchJSON(withBoard(API + "/board", b));
        const goalReq = fetchJSON(withBoard(API + "/board", GOALS_BOARD)).catch(function (err) {
          setGoalError(String((err && err.message) || err));
          return null;
        });
        return Promise.all([sessionReq, goalReq])
          .then(function (payloads) { setSessionData(payloads[0]); setGoalData(payloads[1]); })
          .catch(function (err) { setError(String((err && err.message) || err)); })
          .finally(function () { setLoading(false); });
      }, [board]);

      useEffect(function () { load(); }, [load]);

      const goalTasks = useMemo(function () { return flattenBoard(goalData); }, [goalData]);
      const goalsByPath = useMemo(function () { return buildGoalsByPath(goalTasks); }, [goalTasks]);

      const tasks = useMemo(function () {
        const q = search.trim().toLowerCase();
        return flattenBoard(sessionData).filter(function (task) {
          if (!q) return true;
          const project = extractProject(task);
          const hay = [task.id, task.title, task.body, task.status, task.tenant, project.path, project.label].join(" ").toLowerCase();
          return hay.indexOf(q) !== -1;
        });
      }, [sessionData, search]);

      const groups = useMemo(function () {
        const grouped = groupByProject(tasks, goalsByPath).filter(function (g) {
          if (g.key === "__unknown__") return g.tasks.length > 0;
          if (!search.trim()) return true;
          const q = search.trim().toLowerCase();
          const goal = g.goal;
          const hay = [g.project.label, g.project.path, goal && goal.objective, goal && goal.next, goal && goal.body].join(" ").toLowerCase();
          return hay.indexOf(q) !== -1 || g.tasks.length > 0;
        });
        return sortCockpit(grouped);
      }, [tasks, goalsByPath, search]);

      // Flat rail (project headers + agent rows) plus a lookup of selectable entries.
      const model = useMemo(function () {
        const rail = [];
        const entries = [];
        groups.forEach(function (g) {
          const goal = g.goal;
          const stats = checklistStats(parseChecklist(goal && goal.body));
          rail.push({ kind: "project", group: g });
          const agents = g.tasks.slice().sort(byAttention);
          agents.forEach(function (t) {
            const signals = t._signals || parseSessionSignals(t);
            const sessionTasks = parseSessionTasks(t);
            const entry = {
              id: g.key + "::" + t.id,
              group: g, goal: goal, task: t, signals: signals,
              kind: detectAgentKind(t), state: agentState(signals),
              branch: parseBranch(t),
              sessionTasks: sessionTasks,
              stats: sessionTasks || stats,
            };
            entries.push(entry);
            rail.push({ kind: "agent", entry: entry });
          });
          if (!agents.length) {
            const entry = {
              id: g.key + "::__goal__",
              group: g, goal: goal, task: null, signals: null,
              kind: null, state: "idle", branch: null, stats: stats, sessionTasks: null, goalOnly: true,
            };
            entries.push(entry);
            rail.push({ kind: "agent", entry: entry });
          }
        });
        return { rail: rail, entries: entries };
      }, [groups]);

      const chips = useMemo(function () {
        let need = 0, idle = 0, motion = 0, done = 0;
        model.entries.forEach(function (e) {
          if (!e.task) return;
          if (e.state === "blocked") need++;
          else if (e.state === "active") motion++;
          else if (e.state === "done") done++;
          else idle++;
        });
        return { need: need, idle: idle, motion: motion, done: done };
      }, [model]);

      useEffect(function () {
        const ids = model.entries.map(function (e) { return e.id; });
        if (selectedId && ids.indexOf(selectedId) !== -1) return;
        const firstNeed = model.entries.filter(function (e) { return e.state === "blocked"; })[0];
        const pick = firstNeed || model.entries[0];
        setSelectedId(pick ? pick.id : null);
      }, [model, selectedId]);

      const selected = useMemo(function () {
        return model.entries.filter(function (e) { return e.id === selectedId; })[0] || model.entries[0] || null;
      }, [model, selectedId]);

      function setComposeAndStore(value) {
        setComposeLinks(value);
        try { localStorage.setItem(STORAGE_COMPOSE, value ? "1" : "0"); } catch (_e) {}
      }

      function sessionBoardUrl() { return "/kanban?board=" + encodeURIComponent(board || DEFAULT_BOARD); }

      function writeGoal(path, existingGoal, patch) {
        const key = fullPathKey(path);
        if (!key) return Promise.reject(new Error("Cannot create a goal for an unknown project path."));
        setBusy(true);
        const freshGoals = fetchJSON(withBoard(API + "/board", GOALS_BOARD)).catch(function () { return null; });
        return freshGoals.then(function (fresh) {
          const freshMap = buildGoalsByPath(flattenBoard(fresh));
          const goal = freshMap.get(key) || existingGoal;
          if (!goal) {
            const body = setGoalBodyFields("Path: " + key + "\nBucket: later\n**Objective:** \n**Next:** \n**Done when:**\n- [ ] ", Object.assign({ path: key, bucket: "later" }, patch || {}));
            return fetchJSON(withBoard(API + "/tasks", GOALS_BOARD), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title: basename(key), body: body, triage: true, idempotency_key: "project:" + key }),
            });
          }
          const nextBody = setGoalBodyFields(goal.body, patch || {});
          return fetchJSON(withBoard(API + "/tasks/" + encodeURIComponent(goal.id), GOALS_BOARD), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: nextBody }),
          });
        }).then(load).catch(function (err) {
          setError(String((err && err.message) || err));
        }).finally(function () { setBusy(false); });
      }

      function addGoalNote(goal, note) {
        if (!goal || !goal.id || !note.trim()) return Promise.resolve();
        setBusy(true);
        return fetchJSON(withBoard(API + "/tasks/" + encodeURIComponent(goal.id) + "/comments", GOALS_BOARD), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: note.trim() }),
        }).then(load).catch(function (err) {
          setError(String((err && err.message) || err));
        }).finally(function () { setBusy(false); });
      }

      return h("div", { className: "mc-root" },

        // ---- top bar ----
        h("div", { className: "mc-topbar" },
          h("div", { className: "mc-titles" },
            h("span", { className: "mc-title" }, "Mission Control"),
            h("span", { className: "mc-subtitle" }, "Keep every agent moving — nothing idling.")
          ),
          h("span", { className: "mc-grow" }),
          h("div", { className: "mc-chips" },
            chips.need ? h("span", { className: "mc-stat is-need" }, chips.need + " need you") : null,
            chips.idle ? h("span", { className: "mc-stat is-idle" }, chips.idle + " idling") : null,
            chips.motion ? h("span", { className: "mc-stat is-motion" }, chips.motion + " in motion") : null,
            (!chips.need && !chips.idle && !chips.motion) ? h("span", { className: "mc-stat is-motion" }, "all clear") : null
          ),
          h("input", {
            className: "mc-search mc-mono",
            value: search,
            placeholder: "filter…",
            onChange: function (e) { setSearch(e.target.value); },
          }),
          h("button", {
            className: "mc-ghost" + (composeLinks ? " is-on" : ""),
            title: "Toggle Warp compose links (Send to Claude)",
            onClick: function () { setComposeAndStore(!composeLinks); },
          }, composeLinks ? "Compose: on" : "Compose: off"),
          h("button", { className: "mc-ghost", onClick: load, disabled: loading || busy }, loading ? "Reloading…" : "Reload")
        ),

        error ? h("div", { className: "mc-banner is-error" }, error) : null,
        goalError ? h("div", { className: "mc-banner is-warn" }, "Goals board unavailable: " + goalError + " — showing session grouping only.") : null,

        // ---- body grid ----
        h("div", { className: "mc-body" },

          // LEFT RAIL
          h("div", { className: "mc-rail mc-scroll" },
            h("div", { className: "mc-rail-label" }, "Agents · sorted by who needs you"),
            !model.rail.length && !loading ? h("div", { className: "mc-rail-empty" }, search.trim() ? "No agents match “" + search.trim() + "”." : "No agent sessions yet.") : null,
            model.rail.map(function (row, i) {
              if (row.kind === "project") {
                const g = row.group;
                return h("div", { key: "p:" + g.key + ":" + i, className: "mc-proj" },
                  h("span", { className: "mc-proj-name" }, g.project.label),
                  h("span", { className: "mc-proj-count" }, g.tasks.length + (g.tasks.length === 1 ? " agent" : " agents")),
                  h("span", { className: "mc-grow" }),
                  h("span", { className: "mc-proj-path mc-mono", title: g.project.path || g.project.label }, compactPath(g.project.path))
                );
              }
              const e = row.entry;
              const accent = ACC[e.state];
              const isSel = selected && e.id === selected.id;
              const last = e.task ? (relTime(e.task._latest) || "") : (e.goal ? "no active session" : "—");
              const activeTask = e.sessionTasks && e.sessionTasks.items.filter(function (x) { return x.status === "active"; })[0];
              const flagText = e.goalOnly
                ? (e.goal ? (BUCKET_LABEL[e.goal.bucket] || e.goal.bucket) : "No goal")
                : (activeTask ? "▸ " + activeTask.text : STATE_FLAG[e.state]);
              return h("div", {
                key: e.id,
                className: "mc-row" + (isSel ? " is-selected" : ""),
                style: isSel ? { background: "#14141a", boxShadow: "inset 3px 0 0 " + accent } : null,
                onClick: function () { setSelectedId(e.id); },
              },
                h("div", { className: "mc-row-top" },
                  h("span", { className: "mc-dot", style: { background: accent } }),
                  h("span", { className: "mc-branch mc-mono" }, e.goalOnly ? (e.goal ? "goal only" : "no session") : e.branch),
                  h("span", { className: "mc-grow" }),
                  e.kind ? h("span", { className: "mc-tag", style: { color: e.kind.color, background: e.kind.bg } }, e.kind.label) : null
                ),
                h("div", { className: "mc-row-bar" },
                  h("div", { className: "mc-bar" }, h("div", { className: "mc-bar-fill", style: { width: e.stats.pct + "%", background: accent } })),
                  h("span", { className: "mc-pct mc-mono" }, e.stats.total ? e.stats.done + "/" + e.stats.total : "—")
                ),
                h("div", { className: "mc-row-foot" },
                  h("span", { className: "mc-flag", style: { color: accent }, title: flagText }, flagText),
                  h("span", { className: "mc-grow" }),
                  h("span", { className: "mc-last" }, last)
                )
              );
            }),
            h("button", {
              className: "mc-ghost mc-dashed",
              title: "Start agents from your terminal / session board",
              onClick: function () { openUrl(sessionBoardUrl()); },
            }, "+ Start a new agent")
          ),

          // RIGHT DETAIL
          selected
            ? h(DetailPane, {
                key: selected.id,
                entry: selected,
                composeLinks: composeLinks,
                busy: busy,
                onSelect: setSelectedId,
                onSaveGoal: writeGoal,
                onAddNote: addGoalNote,
                onOpenSessionBoard: function () { openUrl(sessionBoardUrl()); },
              })
            : h("div", { className: "mc-detail mc-scroll" },
                h("div", { className: "mc-empty" }, loading ? "Loading mission control…" : "Nothing to show. Start an agent or add a project goal.")
              )
        )
      );
    }

    function DetailPane(props) {
      const e = props.entry;
      const g = e.group;
      const p = g.project;
      const goal = e.goal;
      const task = e.task;
      const signals = e.signals;
      const accent = ACC[e.state];
      const job = task ? extractJobId(task) : "";
      const isUnknown = p.key === "__unknown__" || !p.path;

      const checklist = parseChecklist(goal && goal.body);
      const stats = checklistStats(checklist);
      const sessionTasks = e.sessionTasks;
      const useTasks = !!(sessionTasks && sessionTasks.total);
      const progress = useTasks ? sessionTasks : stats;
      const timeline = task ? buildTimeline(task, signals, goal, sessionTasks) : [];
      const siblings = g.tasks.filter(function (t) { return !task || t.id !== task.id; });
      const noteHref = obsidianHref(goal);

      const [text, setText] = useState("");
      const [editing, setEditing] = useState(false);
      const [objective, setObjective] = useState(goal ? goal.objective : "");
      const [next, setNext] = useState(goal ? goal.next : "");
      const [bucket, setBucket] = useState(goal ? goal.bucket : "later");
      const [notePath, setNotePath] = useState(goal ? goal.notePath : "");
      const [details, setDetails] = useState(goal ? goal.body : "");
      const [comment, setComment] = useState("");

      // Re-sync editor fields if the goal changes underneath us (e.g. after save/reload).
      useEffect(function () {
        setObjective(goal ? goal.objective : "");
        setNext(goal ? goal.next : "");
        setBucket(goal ? goal.bucket : "later");
        setNotePath(goal ? goal.notePath : "");
        setDetails(goal ? goal.body : "");
      }, [goal && goal.id, goal && goal.body]);

      const canSend = props.composeLinks && !!job;
      function send(value) {
        const v = (value != null ? value : text).trim();
        if (!canSend) return;
        openUrl(warpCompose(job, v));
      }

      function saveGoal() {
        let body = details || ("Path: " + p.path + "\nBucket: " + bucket + "\n**Objective:** " + objective + "\n**Next:** " + next + "\n**Done when:**\n- [ ] ");
        const obsidian = notePath ? "[[" + notePath.replace(/\.md$/i, "") + "]]" : undefined;
        body = setGoalBodyFields(body, { path: p.path, bucket: bucket, objective: objective, next: next, notePath: notePath, obsidian: obsidian });
        return props.onSaveGoal(p.path, goal, { bucket: bucket, objective: objective, next: next, notePath: notePath, obsidian: obsidian, body: body })
          .then(function () { setEditing(false); });
      }

      const prompts = buildPrompts(e.state, signals);

      return h("div", { className: "mc-detail mc-scroll" },

        // header
        h("div", null,
          h("div", { className: "mc-detail-head" },
            h("span", { className: "mc-status-dot", style: { background: accent, boxShadow: "0 0 0 4px " + accent + "2e" } }),
            h("span", { className: "mc-detail-title" }, p.label),
            task ? h("span", { className: "mc-sep mc-mono" }, "/") : null,
            task ? h("span", { className: "mc-detail-branch mc-mono" }, e.branch) : null,
            e.kind ? h("span", { className: "mc-detail-agent", style: { color: e.kind.color, background: e.kind.bg, borderColor: e.kind.color + "4d" } }, e.kind.label) : null,
            h("span", { className: "mc-detail-state", style: { color: accent } }, task ? STATE_PILL[e.state] : (goal ? (BUCKET_LABEL[goal.bucket] || goal.bucket) : "no goal")),
            h("span", { className: "mc-grow" }),
            h("span", { className: "mc-detail-loc mc-mono" }, compactPath(p.path) + (task && relTime(task._latest) ? " · " + relTime(task._latest) : ""))
          ),
          h("div", { className: "mc-detail-obj" },
            goal && goal.objective
              ? [h("span", { key: "l", className: "mc-obj-label" }, "Objective · "), goal.objective]
              : h("span", { className: "mc-obj-label" }, "No objective set for this project yet."),
            noteHref ? h("a", { className: "mc-note-link", href: noteHref }, "Open note") : null,
            h("button", {
              className: "mc-inline-edit",
              disabled: props.busy || isUnknown,
              title: isUnknown ? "Unknown project path — cannot attach a goal" : "",
              onClick: function () { setEditing(!editing); },
            }, goal ? (editing ? "Close" : "Edit goal") : "+ Add goal")
          )
        ),

        // goal editor (collapsible — preserves the plugin's core goal CRUD)
        editing ? h("div", { className: "mc-goal-editor" },
          h("label", null, h("span", null, "Bucket"),
            h("select", { className: "mc-input", value: bucket, onChange: function (ev) { setBucket(ev.target.value); } },
              BUCKETS.map(function (b) { return h("option", { key: b.key, value: b.key }, b.label); }))
          ),
          h("label", null, h("span", null, "Objective"),
            h("input", { className: "mc-input", value: objective, placeholder: "What are we trying to ship?", onChange: function (ev) { setObjective(ev.target.value); } })
          ),
          h("label", null, h("span", null, "Next"),
            h("input", { className: "mc-input", value: next, placeholder: "Next concrete action", onChange: function (ev) { setNext(ev.target.value); } })
          ),
          h("label", null, h("span", null, "Note path"),
            h("input", { className: "mc-input", value: notePath, placeholder: suggestedNotePath(p.path), onChange: function (ev) { setNotePath(ev.target.value); } })
          ),
          h("label", { className: "mc-field-wide" }, h("span", null, "Details (sub-objectives live here as “- [ ]” checklist)"),
            h("textarea", {
              className: "mc-input mc-mono", rows: 8,
              value: details || ("Path: " + p.path + "\nBucket: " + bucket + "\n**Objective:** " + objective + "\n**Next:** " + next + "\n**Done when:**\n- [ ] "),
              onChange: function (ev) { setDetails(ev.target.value); },
            })
          ),
          h("div", { className: "mc-editor-actions" },
            h("button", { className: "mc-send", onClick: saveGoal, disabled: props.busy }, props.busy ? "Saving…" : "Save goal"),
            h("button", { className: "mc-ghost", onClick: function () { setEditing(false); }, disabled: props.busy }, "Cancel"),
            goal ? h("span", { className: "mc-grow" }) : null,
            goal ? h("input", { className: "mc-input mc-comment", value: comment, placeholder: "Add a triage note / comment", onChange: function (ev) { setComment(ev.target.value); } }) : null,
            goal ? h("button", { className: "mc-ghost", disabled: props.busy || !comment.trim(), onClick: function () { props.onAddNote(goal, comment).then(function () { setComment(""); }); } }, "Add note") : null
          )
        ) : null,

        // collision awareness
        g.tasks.length > 1 ? h("div", { className: "mc-collision" },
          h("span", { className: "mc-collision-label" }, g.tasks.length + " agents in this folder"),
          g.tasks.map(function (t) {
            const sig = t._signals || parseSessionSignals(t);
            const st = agentState(sig);
            const kind = detectAgentKind(t);
            const sel = task && t.id === task.id;
            const id = g.key + "::" + t.id;
            return h("div", {
              key: id,
              className: "mc-sib" + (sel ? " is-selected" : ""),
              style: { background: sel ? "#14141a" : "transparent", borderColor: sel ? "#3a3a44" : "#22222a" },
              onClick: function () { props.onSelect(id); },
            },
              h("span", { className: "mc-sib-dot", style: { background: ACC[st] } }),
              h("span", { className: "mc-sib-branch mc-mono", style: { color: sel ? "#fafafa" : "#a1a1aa" } }, parseBranch(t)),
              h("span", { className: "mc-sib-agent", style: { color: kind.color } }, kind.label),
              h("span", { className: "mc-sib-state" }, STATE_PILL[st])
            );
          })
        ) : null,

        // blocker callout
        signals && signals.needsMe ? h("div", { className: "mc-blocker" },
          h("span", { className: "mc-blocker-icon" }, "⛔"),
          h("div", null,
            h("div", { className: "mc-blocker-title" }, "Blocked on you"),
            h("div", { className: "mc-blocker-text" },
              signals.waiting ? "Waiting: " + signals.waiting
              : signals.needs ? "Needs: " + signals.needs
              : "The session is paused awaiting your input. Push it forward below to let the agent continue."
            )
          )
        ) : null,

        // tasks — the agent's own live task list takes priority over the goal checklist
        h("div", null,
          h("div", { className: "mc-subobj-head" },
            h("span", { className: "mc-section-label" },
              useTasks ? "Tasks" : "Sub-objectives",
              h("span", { className: "mc-section-sub" }, useTasks ? "live from session" : (goal ? "project goal" : ""))
            ),
            h("span", { className: "mc-subobj-count mc-mono" },
              progress.total
                ? progress.done + " / " + progress.total + " done" + (useTasks && sessionTasks.inprog ? " · " + sessionTasks.inprog + " active" : "")
                : "none yet")
          ),
          h("div", { className: "mc-progress" }, h("div", { className: "mc-progress-fill", style: { width: progress.pct + "%", background: accent } })),
          useTasks
            ? h("div", { className: "mc-check-list" }, sessionTasks.items.map(function (it, i) {
                const isDone = it.status === "done", isActive = it.status === "active";
                return h("div", { key: i, className: "mc-check" + (isActive ? " is-active" : "") },
                  h("span", { className: "mc-check-box", style: {
                    background: isDone ? "#34d399" : "transparent",
                    borderColor: isDone ? "#34d399" : isActive ? "#818cf8" : "#3f3f46",
                    color: isDone ? "#0a0a0c" : "#818cf8",
                  } }, isDone ? "✓" : isActive ? "▸" : ""),
                  h("span", { className: "mc-check-text", style: {
                    color: isDone ? "#71717a" : isActive ? "#fafafa" : "#d4d4d8",
                    textDecoration: isDone ? "line-through" : "none",
                  } }, it.text),
                  isActive ? h("span", { className: "mc-task-tag" }, "in progress") : null,
                  it.blockedBy ? h("span", { className: "mc-task-blocked" }, "blocked by #" + it.blockedBy) : null
                );
              }))
            : (stats.total
                ? h("div", { className: "mc-check-list" }, checklist.map(function (c, i) {
                    return h("div", { key: i, className: "mc-check" },
                      h("span", { className: "mc-check-box", style: { background: c.done ? "#34d399" : "transparent", borderColor: c.done ? "#34d399" : "#3f3f46", color: "#0a0a0c" } }, c.done ? "✓" : ""),
                      h("span", { className: "mc-check-text", style: { color: c.done ? "#71717a" : "#d4d4d8", textDecoration: c.done ? "line-through" : "none" } }, c.text)
                    );
                  }))
                : h("div", { className: "mc-faint" }, task ? "No task list published for this agent yet — it appears once the agent uses the task tracker." : (goal ? "No checklist yet — add “- [ ]” items in the goal details." : "No goal for this project yet — add one above to track sub-objectives.")))
        ),

        // activity timeline
        task ? h("div", null,
          h("div", { className: "mc-section-label mc-tl-head" }, "Recent session activity"),
          h("div", { className: "mc-timeline" }, timeline.map(function (t, i) {
            return h("div", { key: i, className: "mc-tl-row" },
              h("div", { className: "mc-tl-rail" },
                h("span", { className: "mc-tl-dot", style: { background: t.dot } }),
                h("span", { className: "mc-tl-line", style: { visibility: i === timeline.length - 1 ? "hidden" : "visible" } })
              ),
              h("div", { className: "mc-tl-body" },
                h("div", { className: "mc-tl-text" }, t.text),
                t.time ? h("div", { className: "mc-tl-time mc-mono" }, t.time) : null
              )
            );
          }))
        ) : null,

        // push-forward composer
        h("div", { className: "mc-composer" },
          h("div", { className: "mc-composer-head" },
            h("span", { className: "mc-composer-label" }, "✦ Push forward — pick a prompt for this agent"),
            h("span", { className: "mc-grow" }),
            h("span", { className: "mc-composer-target mc-mono" }, task ? "→ " + e.branch : "→ no active session")
          ),
          h("div", { className: "mc-prompts" }, prompts.map(function (pr, i) {
            return h("button", {
              key: i,
              className: "mc-prompt" + (pr.primary ? " is-primary" : ""),
              onClick: function () { setText(pr.text); },
              title: "Use this prompt",
            },
              h("span", { className: "mc-prompt-mark", style: { color: pr.primary ? "#818cf8" : "#6366f1" } }, pr.primary ? "●" : "›"),
              pr.text
            );
          })),
          h("div", { className: "mc-composer-row" },
            h("input", {
              className: "mc-input mc-composer-input",
              value: text,
              placeholder: "…or write your own prompt for this agent",
              onChange: function (ev) { setText(ev.target.value); },
              onKeyDown: function (ev) { if (ev.key === "Enter") send(); },
            }),
            h("button", {
              className: "mc-send",
              disabled: !canSend || !text.trim(),
              title: !job ? "No Warp session id for this agent" : (!props.composeLinks ? "Turn on Compose links in the top bar to send" : "Open this prompt in Warp"),
              onClick: function () { send(); },
            }, "Send to Claude")
          ),
          h("div", { className: "mc-composer-foot" },
            job ? h("a", { className: "mc-ghost", href: warpOpen(job), target: "_blank", rel: "noreferrer" }, "Open in Warp") : null,
            h("button", { className: "mc-ghost", onClick: props.onOpenSessionBoard }, "Open session board"),
            h("span", { className: "mc-grow" }),
            !job && task ? h("span", { className: "mc-faint mc-small" }, "No Warp session id parsed from this card.") : null
          )
        )
      );
    }

    window.__HERMES_PLUGINS__.register("kanban-projects", MissionControlPage);
  }

  boot();
})();
