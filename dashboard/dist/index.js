/**
 * Kanban Projects — project-path grouped view + per-project goals.
 *
 * UI-only dashboard plugin. Reads the live Claude-session Kanban board and a
 * human-owned project-goals board, then joins them by canonical cwd path. Goal
 * cards stay unassigned and status=triage; the human bucket lives in `Bucket:`
 * inside the card body so the global Kanban dispatcher can never run a goal.
 */
(function () {
  "use strict";

  function boot() {
    const SDK = window.__HERMES_PLUGIN_SDK__;
    if (!SDK || !window.__HERMES_PLUGINS__ || typeof window.__HERMES_PLUGINS__.register !== "function") {
      setTimeout(boot, 50);
      return;
    }

    const { React } = SDK;
    const h = React.createElement;
    const hooks = SDK.hooks || React;
    const { useCallback, useEffect, useMemo, useState } = hooks;
    const C = SDK.components || {};
    const Button = C.Button || function Button(props) { return h("button", props, props.children); };
    const Input = C.Input || function Input(props) { return h("input", props); };
    const Badge = C.Badge || function Badge(props) { return h("span", props, props.children); };

    const API = "/api/plugins/kanban";
    const DEFAULT_BOARD = "claude-code-work";
    const GOALS_BOARD = "project-goals";
    const STORAGE_BOARD = "hermes-kanban-projects-board";
    const STORAGE_COLLAPSED = "hermes-kanban-projects-collapsed";
    const STORAGE_TRIAGE = "hermes-kanban-projects-triage";
    const STORAGE_COMPOSE = "hermes-kanban-projects-compose-links";
    const STATUS_ORDER = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"];
    const STATUS_LABEL = {
      triage: "Triage",
      todo: "Todo",
      scheduled: "Scheduled",
      ready: "Ready",
      running: "Running",
      blocked: "Blocked",
      review: "Review",
      done: "Done",
      archived: "Archived",
    };
    const BUCKETS = [
      { key: "now", label: "Now", rank: 50 },
      { key: "next", label: "Next", rank: 40 },
      { key: "later", label: "Later", rank: 20 },
      { key: "blocked", label: "Blocked", rank: 45 },
      { key: "done", label: "Done", rank: 0 },
    ];
    const BUCKET_LABEL = BUCKETS.reduce(function (acc, b) { acc[b.key] = b.label; return acc; }, {});
    const BUCKET_RANK = BUCKETS.reduce(function (acc, b) { acc[b.key] = b.rank; return acc; }, {});

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
      if (!path) return "Unknown project path";
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

    function replaceOrInsertLine(body, label, value, afterLabel) {
      const src = String(body || "").replace(/\r\n/g, "\n");
      const line = label + ": " + value;
      const re = new RegExp("^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:.*$", "im");
      if (re.test(src)) return src.replace(re, line);
      const lines = src ? src.split("\n") : [];
      let idx = -1;
      if (afterLabel) {
        const afterRe = new RegExp("^" + afterLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:", "i");
        idx = lines.findIndex(function (l) { return afterRe.test(l); });
      }
      if (idx >= 0) lines.splice(idx + 1, 0, line);
      else lines.unshift(line);
      return lines.join("\n");
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
          // Prefer non-archived/non-done-ish card, then newest numeric-ish id/date fallback.
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
        const withSignals = Object.assign({}, task, { _signals: signals });
        g.tasks.push(withSignals);
        const st = task.status || task._column || "todo";
        g.counts[st] = (g.counts[st] || 0) + 1;
        if (signals.needsMe) g.rollup.needs += 1;
        if (signals.working) g.rollup.working += 1;
        if (signals.done) g.rollup.done += 1;
        g.latest = Math.max(g.latest, Number(task.created_at || task.started_at || task.completed_at || 0));
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

    function sortGroups(groups, triageMode) {
      return groups.slice().sort(function (a, b) {
        if (triageMode) {
          const scoreA = (a.rollup.needs * 1000) + (BUCKET_RANK[(a.goal && a.goal.bucket) || "later"] || 0) + Math.min(a.latest || 0, 999999) / 1000000;
          const scoreB = (b.rollup.needs * 1000) + (BUCKET_RANK[(b.goal && b.goal.bucket) || "later"] || 0) + Math.min(b.latest || 0, 999999) / 1000000;
          if (scoreB !== scoreA) return scoreB - scoreA;
        }
        if (b.tasks.length !== a.tasks.length) return b.tasks.length - a.tasks.length;
        return (a.project.path || a.project.label).localeCompare(b.project.path || b.project.label);
      });
    }

    function ProjectKanbanPage() {
      const [board, setBoard] = useState(qsBoard);
      const [sessionData, setSessionData] = useState(null);
      const [goalData, setGoalData] = useState(null);
      const [goalError, setGoalError] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState(null);
      const [search, setSearch] = useState("");
      const [hideDone, setHideDone] = useState(false);
      const [triageMode, setTriageMode] = useState(function () { try { return localStorage.getItem(STORAGE_TRIAGE) === "1"; } catch (_e) { return false; } });
      const [composeLinks, setComposeLinks] = useState(function () { try { return localStorage.getItem(STORAGE_COMPOSE) === "1"; } catch (_e) { return false; } });
      const [collapsed, setCollapsed] = useState(function () {
        try { return JSON.parse(localStorage.getItem(STORAGE_COLLAPSED) || "{}"); }
        catch (_e) { return {}; }
      });
      const [busy, setBusy] = useState(false);

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
          if (hideDone && (task.status === "done" || task.status === "archived")) return false;
          const project = extractProject(task);
          if (q) {
            const hay = [task.id, task.title, task.body, task.status, task.tenant, project.path, project.label].join(" ").toLowerCase();
            if (hay.indexOf(q) === -1) return false;
          }
          return true;
        });
      }, [sessionData, search, hideDone]);

      const rawGroups = useMemo(function () {
        const grouped = groupByProject(tasks, goalsByPath).filter(function (g) {
          if (g.key === "__unknown__") return true;
          if (!search.trim()) return true;
          const q = search.trim().toLowerCase();
          const goal = g.goal;
          const hay = [g.project.label, g.project.path, goal && goal.objective, goal && goal.next, goal && goal.body].join(" ").toLowerCase();
          return hay.indexOf(q) !== -1 || g.tasks.length > 0;
        });
        return triageMode ? grouped.filter(function (g) { return g.rollup.needs > 0 || ((g.goal && g.goal.bucket) === "now"); }) : grouped;
      }, [tasks, goalsByPath, search, triageMode]);
      const groups = useMemo(function () { return sortGroups(rawGroups, triageMode); }, [rawGroups, triageMode]);

      const triageRows = useMemo(function () {
        const rows = [];
        groups.forEach(function (g) {
          g.tasks.forEach(function (t) {
            if (t._signals && t._signals.needsMe) rows.push({ group: g, task: t });
          });
        });
        return rows.sort(function (a, b) {
          const ba = BUCKET_RANK[(a.group.goal && a.group.goal.bucket) || "later"] || 0;
          const bb = BUCKET_RANK[(b.group.goal && b.group.goal.bucket) || "later"] || 0;
          return bb - ba;
        });
      }, [groups]);

      const totals = useMemo(function () {
        const counts = {};
        tasks.forEach(function (t) { const s = t.status || "todo"; counts[s] = (counts[s] || 0) + 1; });
        return counts;
      }, [tasks]);

      function toggle(key) {
        setCollapsed(function (prev) {
          const next = Object.assign({}, prev, { [key]: !prev[key] });
          try { localStorage.setItem(STORAGE_COLLAPSED, JSON.stringify(next)); } catch (_e) {}
          return next;
        });
      }

      function setTriageModeAndStore(value) {
        setTriageMode(value);
        try { localStorage.setItem(STORAGE_TRIAGE, value ? "1" : "0"); } catch (_e) {}
      }

      function setComposeAndStore(value) {
        setComposeLinks(value);
        try { localStorage.setItem(STORAGE_COMPOSE, value ? "1" : "0"); } catch (_e) {}
      }

      function boardUrl() {
        return "/kanban?board=" + encodeURIComponent(board || DEFAULT_BOARD);
      }

      function goalBoardUrl() {
        return "/kanban?board=" + encodeURIComponent(GOALS_BOARD);
      }

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
              body: JSON.stringify({
                title: basename(key),
                body: body,
                triage: true,
                idempotency_key: "project:" + key,
              }),
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

      return h("div", { className: "kp-page" },
        h("div", { className: "kp-header" },
          h("div", null,
            h("h2", null, "Kanban by project path"),
            h("p", { className: "kp-muted" }, "A project-grouped view over Claude Code sessions, joined with a human-owned project-goals board for objectives, triage, and Obsidian note links.")
          ),
          h("div", { className: "kp-header-actions" },
            h("a", { className: "kp-link-button", href: boardUrl() }, "Open session board"),
            h("a", { className: "kp-link-button", href: goalBoardUrl() }, "Open goals board"),
            h(Button, { onClick: load, disabled: loading || busy }, loading ? "Loading…" : "Reload")
          )
        ),

        h("div", { className: "kp-toolbar" },
          h("label", null,
            h("span", null, "Session board"),
            h(Input, {
              value: board,
              onChange: function (e) { setBoard(e.target.value); },
              onKeyDown: function (e) { if (e.key === "Enter") load(); },
              placeholder: DEFAULT_BOARD,
            })
          ),
          h("label", null,
            h("span", null, "Search path/card/goal"),
            h(Input, {
              value: search,
              onChange: function (e) { setSearch(e.target.value); },
              placeholder: "inbox-ai-flow, objective, blocked…",
            })
          ),
          h("label", { className: "kp-check" },
            h("input", { type: "checkbox", checked: hideDone, onChange: function (e) { setHideDone(e.target.checked); } }),
            h("span", null, "Hide done/archived")
          ),
          h("label", { className: "kp-check" },
            h("input", { type: "checkbox", checked: triageMode, onChange: function (e) { setTriageModeAndStore(e.target.checked); } }),
            h("span", null, "Triage mode")
          ),
          h("label", { className: "kp-check" },
            h("input", { type: "checkbox", checked: composeLinks, onChange: function (e) { setComposeAndStore(e.target.checked); } }),
            h("span", null, "Compose links")
          )
        ),

        error ? h("div", { className: "kp-error" }, error) : null,
        goalError ? h("div", { className: "kp-warn" }, "Goals board unavailable: " + goalError + " — showing session grouping only.") : null,

        h("div", { className: "kp-summary" },
          h("span", null, groups.length + " project group" + (groups.length === 1 ? "" : "s")),
          h("span", null, tasks.length + " session card" + (tasks.length === 1 ? "" : "s")),
          h("span", null, goalTasks.length + " goal card" + (goalTasks.length === 1 ? "" : "s")),
          STATUS_ORDER.filter(function (s) { return totals[s]; }).map(function (s) {
            return h("span", { key: s, className: "kp-pill kp-pill-" + s }, (STATUS_LABEL[s] || s) + ": " + totals[s]);
          })
        ),

        h(TriageStrip, { rows: triageRows, composeLinks: composeLinks }),

        loading && !sessionData ? h("div", { className: "kp-muted kp-loading" }, "Loading board…") : null,

        h("div", { className: "kp-groups" },
          groups.map(function (group) {
            const isCollapsed = !!collapsed[group.key];
            return h(ProjectGroup, {
              key: group.key,
              group: group,
              collapsed: isCollapsed,
              composeLinks: composeLinks,
              onToggle: function () { toggle(group.key); },
              onSaveGoal: writeGoal,
              onAddNote: addGoalNote,
              busy: busy,
            });
          })
        )
      );
    }

    function TriageStrip(props) {
      if (!props.rows.length) {
        return h("div", { className: "kp-triage kp-triage-empty" }, "No sessions currently need attention.");
      }
      return h("section", { className: "kp-triage" },
        h("div", { className: "kp-triage-head" },
          h("strong", null, "Needs attention"),
          h("span", null, props.rows.length + " session" + (props.rows.length === 1 ? "" : "s"))
        ),
        props.rows.map(function (row) {
          const job = extractJobId(row.task);
          const signals = row.task._signals || {};
          return h("div", { key: row.group.key + ":" + row.task.id, className: "kp-triage-row" },
            h("span", { className: "kp-triage-project" }, row.group.project.label),
            h("span", { className: "kp-triage-title" }, cleanTitle(row.task)),
            signals.waiting ? h("span", { className: "kp-mini kp-mini-blocked" }, "Waiting: " + signals.waiting) : null,
            signals.needs ? h("span", { className: "kp-mini kp-mini-blocked" }, "Needs") : null,
            h("span", { className: "kp-spacer" }),
            job ? h("a", { href: "http://127.0.0.1:9777/open/" + encodeURIComponent(job), target: "_blank", rel: "noreferrer" }, "Open in Warp") : null,
            props.composeLinks && job ? h("a", { href: "http://127.0.0.1:9777/compose/" + encodeURIComponent(job), target: "_blank", rel: "noreferrer" }, "Send/Draft") : null
          );
        })
      );
    }

    function ProjectGroup(props) {
      const g = props.group;
      const p = g.project;
      const goal = g.goal;
      const [editing, setEditing] = useState(false);
      const [objective, setObjective] = useState(goal ? goal.objective : "");
      const [next, setNext] = useState(goal ? goal.next : "");
      const [bucket, setBucket] = useState(goal ? goal.bucket : "later");
      const [notePath, setNotePath] = useState(goal ? goal.notePath : "");
      const [details, setDetails] = useState(goal ? goal.body : "");
      const [comment, setComment] = useState("");

      useEffect(function () {
        setObjective(goal ? goal.objective : "");
        setNext(goal ? goal.next : "");
        setBucket(goal ? goal.bucket : "later");
        setNotePath(goal ? goal.notePath : "");
        setDetails(goal ? goal.body : "");
      }, [goal && goal.id, goal && goal.body]);

      const byStatus = {};
      STATUS_ORDER.forEach(function (s) { byStatus[s] = []; });
      g.tasks.forEach(function (t) {
        const s = STATUS_ORDER.indexOf(t.status) !== -1 ? t.status : (t._column || "todo");
        if (!byStatus[s]) byStatus[s] = [];
        byStatus[s].push(t);
      });
      const activeColumns = STATUS_ORDER.filter(function (s) { return byStatus[s] && byStatus[s].length; });
      const columns = activeColumns.length ? activeColumns : ["triage"];
      const noteHref = obsidianHref(goal);

      function saveGoal() {
        let body = details || "Path: " + p.path + "\nBucket: " + bucket + "\n**Objective:** " + objective + "\n**Next:** " + next;
        body = setGoalBodyFields(body, { path: p.path, bucket: bucket, objective: objective, next: next, notePath: notePath, obsidian: notePath ? "[[" + notePath.replace(/\.md$/i, "") + "]]" : undefined });
        return props.onSaveGoal(p.path, goal, { bucket: bucket, objective: objective, next: next, notePath: notePath, obsidian: notePath ? "[[" + notePath.replace(/\.md$/i, "") + "]]" : undefined, body: body }).then(function () { setEditing(false); });
      }

      return h("section", { className: "kp-group" },
        h("div", { className: "kp-group-head" },
          h("button", { className: "kp-group-toggle", onClick: props.onToggle }, h("span", { className: "kp-collapse" }, props.collapsed ? "▸" : "▾")),
          h("div", { className: "kp-head-main" },
            h("div", { className: "kp-head-line" },
              h("span", { className: "kp-project-title" }, p.label),
              h("code", { className: "kp-project-path", title: p.path || p.label }, compactPath(p.path)),
              goal ? h("span", { className: "kp-bucket kp-bucket-" + goal.bucket }, BUCKET_LABEL[goal.bucket] || goal.bucket) : h("span", { className: "kp-bucket kp-bucket-missing" }, "No goal")
            ),
            h("div", { className: "kp-goal-lines" },
              goal && goal.objective ? h("div", null, h("span", null, "🎯 Objective: "), goal.objective) : h("div", { className: "kp-muted" }, "No objective yet"),
              goal && goal.next ? h("div", null, h("span", null, "→ Next: "), goal.next) : null,
              goal && goal.duplicateCount > 1 ? h("div", { className: "kp-dup" }, "Duplicate goal cards for this path: " + goal.duplicateCount) : null
            )
          ),
          h("span", { className: "kp-spacer" }),
          h("span", { className: "kp-roll kp-roll-needs" }, "🔴 " + g.rollup.needs),
          h("span", { className: "kp-roll kp-roll-working" }, "🟡 " + g.rollup.working),
          h("span", { className: "kp-roll kp-roll-done" }, "✅ " + g.rollup.done),
          noteHref ? h("a", { className: "kp-small-link", href: noteHref }, "Open note") : goal ? h("span", { className: "kp-muted" }, suggestedNotePath(p.path)) : null,
          h(Button, { onClick: function () { setEditing(!editing); }, disabled: props.busy || p.key === "__unknown__" }, goal ? "Edit" : "+ Add goal")
        ),
        editing ? h("div", { className: "kp-editor" },
          h("label", null, h("span", null, "Bucket"), h("select", { value: bucket, onChange: function (e) { setBucket(e.target.value); } }, BUCKETS.map(function (b) { return h("option", { key: b.key, value: b.key }, b.label); }))),
          h("label", null, h("span", null, "Objective"), h("input", { value: objective, onChange: function (e) { setObjective(e.target.value); }, placeholder: "What are we trying to ship?" })),
          h("label", null, h("span", null, "Next"), h("input", { value: next, onChange: function (e) { setNext(e.target.value); }, placeholder: "Next concrete action" })),
          h("label", null, h("span", null, "Note path"), h("input", { value: notePath, onChange: function (e) { setNotePath(e.target.value); }, placeholder: suggestedNotePath(p.path) })),
          h("label", { className: "kp-editor-wide" }, h("span", null, "Details body"), h("textarea", { rows: 8, value: details || ("Path: " + p.path + "\nBucket: " + bucket + "\n**Objective:** " + objective + "\n**Next:** " + next + "\n**Done when:**\n- [ ] "), onChange: function (e) { setDetails(e.target.value); } })),
          h("div", { className: "kp-editor-actions" },
            h(Button, { onClick: saveGoal, disabled: props.busy }, props.busy ? "Saving…" : "Save goal"),
            h(Button, { onClick: function () { setEditing(false); }, disabled: props.busy }, "Cancel")
          ),
          goal ? h("div", { className: "kp-comment-row" },
            h("input", { value: comment, onChange: function (e) { setComment(e.target.value); }, placeholder: "Add triage note/comment" }),
            h(Button, { disabled: props.busy || !comment.trim(), onClick: function () { props.onAddNote(goal, comment).then(function () { setComment(""); }); } }, "Add note")
          ) : null
        ) : null,
        props.collapsed ? null : h("div", { className: "kp-columns", style: { gridTemplateColumns: "repeat(" + Math.max(1, columns.length) + ", minmax(220px, 1fr))" } },
          columns.map(function (status) {
            return h("div", { key: status, className: "kp-column" },
              h("div", { className: "kp-column-head" },
                h("span", null, STATUS_LABEL[status] || status),
                h(Badge, { className: "kp-badge" }, String((byStatus[status] || []).length))
              ),
              (byStatus[status] || []).map(function (task) { return h(ProjectCard, { key: task.id, task: task, composeLinks: props.composeLinks }); }),
              !(byStatus[status] || []).length ? h("div", { className: "kp-empty-col" }, goal ? "Goal-only project" : "No cards") : null
            );
          })
        )
      );
    }

    function ProjectCard(props) {
      const task = props.task;
      const job = extractJobId(task);
      const summary = task.latest_summary || task.result || "";
      const signals = task._signals || parseSessionSignals(task);
      return h("article", { className: "kp-card kp-card-" + (task.status || "todo") + (signals.needsMe ? " kp-card-needs" : "") },
        h("div", { className: "kp-card-title" }, cleanTitle(task)),
        summary ? h("div", { className: "kp-card-summary" }, String(summary).slice(0, 220)) : null,
        signals.waiting || signals.needs ? h("div", { className: "kp-card-alert" }, signals.waiting ? "Waiting: " + signals.waiting : "Needs: " + signals.needs) : null,
        h("div", { className: "kp-card-meta" },
          h("code", null, task.id),
          task.tenant ? h("span", null, task.tenant) : null,
          job ? h("a", { href: "http://127.0.0.1:9777/open/" + encodeURIComponent(job), target: "_blank", rel: "noreferrer" }, "Open in Warp") : null,
          props.composeLinks && job ? h("a", { href: "http://127.0.0.1:9777/compose/" + encodeURIComponent(job), target: "_blank", rel: "noreferrer" }, "Send/Draft") : null
        )
      );
    }

    window.__HERMES_PLUGINS__.register("kanban-projects", ProjectKanbanPage);
  }

  boot();
})();
