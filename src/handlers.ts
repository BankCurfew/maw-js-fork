import { buildCommand } from "./config";
import type { MawWS, Handler, MawEngine } from "./types";
import { isAgentPane } from "./lib/pane";
import { subscribeTranscript, unsubscribeAll } from "./engine/transcript-watcher";

// Lazy-import ssh to break circular dep: handlers→ssh←tmux→ssh
// ssh.ts ↔ tmux.ts form a cycle; static import causes "Export not found" on CI
let _ssh: typeof import("./ssh") | null = null;
async function lazySSH() {
  if (!_ssh) _ssh = await import("./ssh");
  return _ssh;
}
async function sendKeys(target: string, text: string, host?: string) { return (await lazySSH()).sendKeys(target, text, host); }
async function selectWindow(target: string, host?: string) { return (await lazySSH()).selectWindow(target, host); }
async function ssh(cmd: string, host?: string) { return (await lazySSH()).ssh(cmd, host); }
async function getPaneCommand(target: string, host?: string) { return (await lazySSH()).getPaneCommand(target, host); }
import {
  fetchBoardData,
  fetchFields,
  setFieldByName,
  addItem,
  scanUntracked,
  scanMine,
  autoAssign,
  getTimelineData,
} from "./board";
import { readTaskLog, getAllLogSummaries, appendActivity } from "./task-log";
import { loadProjects, addTaskToProject, removeTaskFromProject, createProject, updateProject, autoOrganize, getProjectBoardData } from "./projects";
import { LoopEngine } from "./loops";

/** Run an async action with standard ok/error response */
async function runAction(ws: MawWS, action: string, target: string, fn: () => Promise<void>) {
  try {
    await fn();
    ws.send(JSON.stringify({ type: "action-ok", action, target }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
}

// --- Handlers ---

const subscribe: Handler = async (ws, data, engine) => {
  ws.data.target = data.target;
  engine.pushCapture(ws);
  // T026: start real-time transcript watch for this oracle
  try {
    const { oracleToProjectDir } = await import("./transcript");
    const oracleName = (data.target || "").replace(/^\d+-/, "").replace(/:.*$/, "").replace(/-oracle$/i, "");
    const projectDir = oracleToProjectDir(oracleName);
    if (projectDir) subscribeTranscript(oracleName, projectDir, ws);
  } catch {}
};

const subscribePreviews: Handler = (ws, data, engine) => {
  ws.data.previewTargets = new Set(data.targets || []);
  engine.pushPreviews(ws);
};

const select: Handler = (_ws, data) => {
  selectWindow(data.target).catch(() => {});
};

const send: Handler = async (ws, data, engine) => {
  const target: string = data.target;
  const text: string = data.text;

  // Cross-node routing: only if prefix matches a KNOWN federation peer
  // e.g. "dreams:nobi" → cross-node, but "01-bob:0" → local tmux
  if (target.includes(":")) {
    const [prefix] = target.split(":");
    try {
      const { getNamedPeers, crossNodeSend } = await import("./lib/peers");
      const peerNames = getNamedPeers().map(p => p.name);
      if (peerNames.includes(prefix)) {
        const result = await crossNodeSend(target, text);
        ws.send(JSON.stringify(result.ok
          ? { type: "sent", ok: true, target, text, forwarded: true }
          : { type: "error", error: result.error || "cross-node send failed" }
        ));
        return; // cross-node handled, skip local sendKeys
      }
    } catch { /* peers module unavailable, fall through to local */ }
  }

  // Check if target is a remote peer session (e.g. "01-nobi:0" from aggregated sessions)
  // This handles the case where dashboard shows remote sessions with local-style targets
  try {
    const { findPeerForTarget, sendKeysToPeer } = await import("./peers");
    const { listSessions } = await import("./ssh");
    const local = await listSessions();
    const peerUrl = await findPeerForTarget(target, local);
    if (peerUrl) {
      const ok = await sendKeysToPeer(peerUrl, target, text);
      ws.send(JSON.stringify(ok
        ? { type: "sent", ok: true, target, text, forwarded: true, source: peerUrl }
        : { type: "error", error: `peer send failed: ${peerUrl}` }
      ));
      return;
    }
  } catch { /* peer lookup failed, fall through to local */ }

  // Local tmux target — unchanged from original
  if (!data.force) {
    try {
      const cmd = await Promise.race([
        getPaneCommand(target),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
      if (!isAgentPane(cmd)) {
        ws.send(JSON.stringify({ type: "error", error: `no active agent in ${target} (idle shell: ${cmd})` }));
        return;
      }
    } catch { /* pane check failed or timed out, proceed anyway */ }
  }
  sendKeys(target, text)
    .then(() => {
      ws.send(JSON.stringify({ type: "sent", ok: true, target, text }));
      setTimeout(() => engine.pushCapture(ws), 300);
    })
    .catch(e => ws.send(JSON.stringify({ type: "error", error: e.message })));
};

const sleep: Handler = (ws, data) => {
  runAction(ws, "sleep", data.target, () => sendKeys(data.target, "\x03"));
};

const stop: Handler = (ws, data) => {
  runAction(ws, "stop", data.target, async () => { await ssh(`tmux kill-window -t '${data.target}'`); });
};

const wake: Handler = (ws, data) => {
  // Use client command if provided, otherwise resolve from config
  const cmd = data.command || buildCommand(data.target?.split(":").pop() || "");
  runAction(ws, "wake", data.target, () => sendKeys(data.target, cmd + "\r"));
};

const restart: Handler = (ws, data) => {
  const cmd = data.command || buildCommand(data.target?.split(":").pop() || "");
  runAction(ws, "restart", data.target, async () => {
    await sendKeys(data.target, "\x03"); // Ctrl+C
    await new Promise(r => setTimeout(r, 2000));
    await sendKeys(data.target, "\x03"); // Ctrl+C again (in case first was caught)
    await new Promise(r => setTimeout(r, 500));
    await sendKeys(data.target, cmd + "\r");
  });
};

// --- Board handlers ---

const board: Handler = async (ws, data) => {
  try {
    const [items, fields] = await Promise.all([
      fetchBoardData(data.filter),
      fetchFields(),
    ]);
    ws.send(JSON.stringify({ type: "board-data", items, fields }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

const boardSet: Handler = async (ws, data, engine) => {
  try {
    // Auto-log status changes
    if (data.field?.toLowerCase() === "status") {
      try {
        const items = await fetchBoardData();
        const item = items.find((i) => i.id === data.itemId);
        if (item) {
          appendActivity({
            taskId: data.itemId,
            type: "status_change",
            oracle: "dashboard",
            content: `Status changed: ${item.status || "none"} → ${data.value}`,
            meta: { oldStatus: item.status, newStatus: data.value },
          });
        }
      } catch { /* auto-log is best-effort */ }
    }
    await setFieldByName(data.itemId, data.field, data.value);
    const [items, fields] = await Promise.all([
      fetchBoardData(),
      fetchFields(),
    ]);
    ws.send(JSON.stringify({ type: "board-data", items, fields }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

const boardAdd: Handler = async (ws, data) => {
  try {
    await addItem(data.title, { oracle: data.oracle, repo: data.repo });
    const [items, fields] = await Promise.all([
      fetchBoardData(),
      fetchFields(),
    ]);
    ws.send(JSON.stringify({ type: "board-data", items, fields }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

const boardAutoAssign: Handler = async (ws) => {
  try {
    const result = await autoAssign();
    ws.send(JSON.stringify({ type: "board-auto-assign-results", ...result }));
    // Refresh board after assignment
    const [items, fields] = await Promise.all([
      fetchBoardData(),
      fetchFields(),
    ]);
    ws.send(JSON.stringify({ type: "board-data", items, fields }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

const boardScan: Handler = async (ws) => {
  try {
    const results = await scanUntracked();
    ws.send(JSON.stringify({ type: "board-scan-results", results }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

const boardScanMine: Handler = async (ws) => {
  try {
    const results = await scanMine();
    ws.send(JSON.stringify({ type: "board-scan-mine-results", results }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

const boardTimeline: Handler = async (ws, data) => {
  try {
    const timeline = await getTimelineData(data.filter);
    ws.send(JSON.stringify({ type: "board-timeline-data", timeline }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

const pulseBoard: Handler = async (ws) => {
  try {
    const items = await fetchBoardData();
    const active = items
      .filter((i) => i.status.toLowerCase().replace(/\s/g, "") === "inprogress")
      .map((i) => ({ number: i.content.number, title: i.title, oracle: i.oracle }));
    const projects = items
      .filter((i) => i.status.toLowerCase() === "todo" || i.status.toLowerCase() === "backlog")
      .map((i) => ({ number: i.content.number, title: i.title, oracle: i.oracle }));
    const tools = items
      .filter((i) => i.status.toLowerCase() === "done")
      .map((i) => ({ number: i.content.number, title: i.title, oracle: i.oracle }));
    const total = items.filter((i) => i.status.toLowerCase() !== "done").length;
    ws.send(JSON.stringify({
      type: "pulse-board-data",
      active,
      projects,
      tools,
      total,
      threads: [],
    }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

// --- Task log handlers ---

const taskLog: Handler = async (ws, data) => {
  try {
    let activities = readTaskLog(data.taskId);
    // If no logs found by board item ID, try matching by issue number
    if (activities.length === 0 && data.taskId.startsWith("PVTI_")) {
      try {
        const items = await fetchBoardData();
        const item = items.find((i) => i.id === data.taskId);
        if (item?.content.number) {
          // Try issue number
          const byNum = readTaskLog(String(item.content.number));
          // Try RepoName_number pattern
          const repo = item.content.repository?.split("/").pop() || "";
          const byRepo = repo ? readTaskLog(`${repo}_${item.content.number}`) : [];
          activities = [...byNum, ...byRepo, ...activities].sort((a, b) => a.ts.localeCompare(b.ts));
        }
      } catch {}
    }
    ws.send(JSON.stringify({ type: "task-log-data", taskId: data.taskId, activities }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

const taskLogSummaries: Handler = async (ws) => {
  try {
    const raw = getAllLogSummaries();
    // Enrich: map issue-number-keyed logs to board item IDs
    // so frontend can match "#2" logs to PVTI_ board items
    let boardItems: { id: string; content: { number: number } }[] = [];
    try { boardItems = await fetchBoardData(); } catch {}
    const issueToItemId = new Map<string, string>();
    for (const item of boardItems) {
      if (item.content.number > 0) {
        issueToItemId.set(String(item.content.number), item.id);
      }
    }
    // Build merged summaries: keep original keys + add board-item-id aliases
    const summaries: Record<string, typeof raw[string]> = { ...raw };
    for (const [taskId, summary] of Object.entries(raw)) {
      // If taskId is a number (issue #), also index under the board item ID
      const boardId = issueToItemId.get(taskId);
      if (boardId && !summaries[boardId]) {
        summaries[boardId] = { ...summary, taskId: boardId };
      }
      // If taskId contains repo name pattern like "Dev-Oracle_1", try matching
      const repoMatch = taskId.match(/^(.+?)_(\d+)$/);
      if (repoMatch) {
        const num = repoMatch[2];
        const bid = issueToItemId.get(num);
        if (bid && !summaries[bid]) {
          summaries[bid] = { ...summary, taskId: bid };
        }
      }
    }
    // Merge: if a board item has logs under BOTH its PVTI_ id and issue number, combine counts
    for (const item of boardItems) {
      const pvtiKey = item.id;
      const numKey = String(item.content.number);
      const pvtiSummary = raw[pvtiKey];
      const numSummary = raw[numKey];
      if (pvtiSummary && numSummary) {
        // Merge into PVTI key
        summaries[pvtiKey] = {
          taskId: pvtiKey,
          count: pvtiSummary.count + numSummary.count,
          lastActivity: pvtiSummary.lastActivity > numSummary.lastActivity ? pvtiSummary.lastActivity : numSummary.lastActivity,
          lastOracle: pvtiSummary.lastActivity > numSummary.lastActivity ? pvtiSummary.lastOracle : numSummary.lastOracle,
          hasBlockers: pvtiSummary.hasBlockers || numSummary.hasBlockers,
          contributors: [...new Set([...pvtiSummary.contributors, ...numSummary.contributors])],
        };
      }
    }
    ws.send(JSON.stringify({ type: "task-log-summaries-data", summaries }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

const taskLogAdd: Handler = async (ws, data, engine) => {
  try {
    const activity = appendActivity({
      taskId: data.taskId,
      type: data.activityType || "note",
      oracle: data.oracle || "dashboard",
      content: data.content,
      meta: data.meta,
    });
    // Send back to requester
    ws.send(JSON.stringify({ type: "task-log-new", activity }));
    // Broadcast to all other clients
    engine.broadcast(JSON.stringify({ type: "task-log-new", activity }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

// --- Project handlers ---

const projectBoard: Handler = async (ws, data) => {
  try {
    const items = await fetchBoardData(data.filter);
    const result = getProjectBoardData(items);
    const fields = await fetchFields();
    ws.send(JSON.stringify({ type: "project-board-data", ...result, fields }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

const projectList: Handler = async (ws) => {
  try {
    const data = loadProjects();
    ws.send(JSON.stringify({ type: "project-list-data", projects: data.projects }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

const projectAddTask: Handler = async (ws, data, engine) => {
  try {
    addTaskToProject(data.projectId, data.taskId, data.parentTaskId);
    ws.send(JSON.stringify({ type: "project-updated", projectId: data.projectId }));
    // Broadcast refresh
    const items = await fetchBoardData();
    const result = getProjectBoardData(items);
    const fields = await fetchFields();
    engine.broadcast(JSON.stringify({ type: "project-board-data", ...result, fields }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

const projectRemoveTask: Handler = async (ws, data, engine) => {
  try {
    removeTaskFromProject(data.projectId, data.taskId);
    ws.send(JSON.stringify({ type: "project-updated", projectId: data.projectId }));
    const items = await fetchBoardData();
    const result = getProjectBoardData(items);
    const fields = await fetchFields();
    engine.broadcast(JSON.stringify({ type: "project-board-data", ...result, fields }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

const projectCreate: Handler = async (ws, data, engine) => {
  try {
    const project = createProject(data.id, data.name, data.description || "");
    ws.send(JSON.stringify({ type: "project-created", project }));
    const items = await fetchBoardData();
    const result = getProjectBoardData(items);
    const fields = await fetchFields();
    engine.broadcast(JSON.stringify({ type: "project-board-data", ...result, fields }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

const projectAutoOrganize: Handler = async (ws, _data, engine) => {
  try {
    const items = await fetchBoardData();
    const result = autoOrganize(items);
    ws.send(JSON.stringify({ type: "project-auto-organize-result", ...result }));
    const updatedItems = await fetchBoardData();
    const boardData = getProjectBoardData(updatedItems);
    const fields = await fetchFields();
    engine.broadcast(JSON.stringify({ type: "project-board-data", ...boardData, fields }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

// --- Loop handlers ---
const loopEngineInstance = new LoopEngine();

const loopStatus: Handler = async (ws) => {
  try {
    const status = loopEngineInstance.getStatus();
    const enabled = loopEngineInstance.isEnabled();
    ws.send(JSON.stringify({ type: "loop-status", enabled, loops: status }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

const loopHistory: Handler = async (ws, data) => {
  try {
    const history = loopEngineInstance.getHistory(data.loopId, data.limit || 50);
    ws.send(JSON.stringify({ type: "loop-history", history }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

const loopTrigger: Handler = async (ws, data) => {
  try {
    const result = await loopEngineInstance.triggerLoop(data.loopId);
    ws.send(JSON.stringify({ type: "loop-trigger-result", ...result }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: "error", error: e.message }));
  }
};

/** Register all built-in WebSocket handlers on the engine */
export function registerBuiltinHandlers(engine: MawEngine) {
  engine.on("subscribe", subscribe);
  engine.on("subscribe-previews", subscribePreviews);
  engine.on("select", select);
  engine.on("send", send);
  engine.on("sleep", sleep);
  engine.on("stop", stop);
  engine.on("wake", wake);
  engine.on("restart", restart);

  // Board
  engine.on("board", board);
  engine.on("board-set", boardSet);
  engine.on("board-add", boardAdd);
  engine.on("board-auto-assign", boardAutoAssign);
  engine.on("board-scan", boardScan);
  engine.on("board-scan-mine", boardScanMine);
  engine.on("board-timeline", boardTimeline);
  engine.on("pulse-board", pulseBoard);

  // Task log
  engine.on("task-log", taskLog);
  engine.on("task-log-summaries", taskLogSummaries);
  engine.on("task-log-add", taskLogAdd);

  // Projects
  engine.on("project-board", projectBoard);
  engine.on("project-list", projectList);
  engine.on("project-add-task", projectAddTask);
  engine.on("project-remove-task", projectRemoveTask);
  engine.on("project-create", projectCreate);
  engine.on("project-auto-organize", projectAutoOrganize);

  // Loops
  engine.on("loop-status", loopStatus);
  engine.on("loop-history", loopHistory);
  engine.on("loop-trigger", loopTrigger);
}
