import { ssh } from "./ssh";
import { loadConfig } from "./config";
import { routeTask, ORACLE_MAP } from "./autopilot";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { appendActivity } from "./task-log";

// --- Types ---

export interface BoardItem {
  id: string;
  index: number; // 1-based row number for UI
  title: string;
  status: string;
  oracle: string;
  priority: string;
  client: string;
  startDate: string;
  targetDate: string;
  content: {
    body: string;
    number: number;
    repository: string;
    title: string;
    type: string;
    url: string;
  };
}

export interface BoardField {
  id: string;
  name: string;
  type: string; // "single_select", "date", "text", "number", "iteration"
  options?: { id: string; name: string }[];
}

export interface ScanResult {
  repo: string;
  issues: { number: number; title: string; url: string; labels: string[] }[];
}

export interface ScanMineResult {
  oracle: string;
  oracleName: string;
  commits: { hash: string; message: string; date: string }[];
}

export interface TimelineItem {
  id: string;
  title: string;
  oracle: string;
  priority: string;
  status: string;
  startDate: string;
  targetDate: string;
  startOffset: number; // percentage from timeline start
  width: number; // percentage width
}

// --- Config ---

function getOwnerProject(): { owner: string; project: number } {
  const config = loadConfig() as any;
  const owner = config.pulseRepo || "YourOrg";
  const project = config.pulseProject || 1;
  return { owner, project };
}

// --- Cache ---

let boardCache: { items: BoardItem[]; ts: number } | null = null;
const BOARD_CACHE_TTL = 30_000; // 30s

let fieldsCache: { fields: BoardField[]; ts: number } | null = null;
const FIELDS_CACHE_TTL = 300_000; // 5min

// --- Cached project metadata (reuse pattern from autopilot) ---

let cachedProjectMeta: { projectId: string; fields: BoardField[] } | null = null;

async function getProjectMeta(): Promise<{ projectId: string; fields: BoardField[] }> {
  if (cachedProjectMeta) return cachedProjectMeta;
  const { owner, project } = getOwnerProject();
  const projectJson = await ssh(`gh project view ${project} --owner ${owner} --format json`);
  const proj = JSON.parse(projectJson);
  const fields = await fetchFields(true);
  cachedProjectMeta = { projectId: proj.id, fields };
  return cachedProjectMeta;
}

// --- Board data ---

export async function fetchBoardData(filter?: string): Promise<BoardItem[]> {
  const now = Date.now();
  if (boardCache && now - boardCache.ts < BOARD_CACHE_TTL && !filter) {
    return boardCache.items;
  }

  const { owner, project } = getOwnerProject();
  const json = await ssh(`gh project item-list ${project} --owner ${owner} --format json --limit 100`);
  const data = JSON.parse(json);
  const rawItems = data.items || [];

  const items: BoardItem[] = rawItems.map((item: any, i: number) => ({
    id: item.id,
    index: i + 1,
    title: item.title || item.content?.title || "",
    status: item.status || "",
    oracle: item.oracle || "",
    priority: item.priority || "",
    client: item.client || "",
    startDate: item.startDate || item["start date"] || "",
    targetDate: item.targetDate || item["target date"] || "",
    content: {
      body: item.content?.body || "",
      number: item.content?.number || 0,
      repository: item.content?.repository || "",
      title: item.content?.title || "",
      type: item.content?.type || "",
      url: item.content?.url || "",
    },
  }));

  // Apply filter if provided
  let filtered = items;
  if (filter) {
    const lower = filter.toLowerCase();
    filtered = items.filter(
      (item) =>
        item.title.toLowerCase().includes(lower) ||
        item.oracle.toLowerCase().includes(lower) ||
        item.status.toLowerCase().includes(lower) ||
        item.priority.toLowerCase().includes(lower) ||
        item.client.toLowerCase().includes(lower)
    );
  }

  if (!filter) {
    boardCache = { items, ts: now };
  }

  return filtered;
}

export function invalidateBoardCache() {
  boardCache = null;
}

// --- Fields ---

export async function fetchFields(force = false): Promise<BoardField[]> {
  const now = Date.now();
  if (!force && fieldsCache && now - fieldsCache.ts < FIELDS_CACHE_TTL) {
    return fieldsCache.fields;
  }

  const { owner, project } = getOwnerProject();
  const json = await ssh(`gh project field-list ${project} --owner ${owner} --format json`);
  const data = JSON.parse(json);
  const fields: BoardField[] = (data.fields || []).map((f: any) => ({
    id: f.id,
    name: f.name,
    type: f.type,
    options: f.options?.map((o: any) => ({ id: o.id, name: o.name })) || undefined,
  }));

  fieldsCache = { fields, ts: now };
  return fields;
}

// --- Set field by name ---

export async function setFieldByName(
  itemId: string,
  fieldName: string,
  value: string
): Promise<void> {
  const meta = await getProjectMeta();
  const field = meta.fields.find(
    (f) => f.name.toLowerCase() === fieldName.toLowerCase()
  );
  if (!field) throw new Error(`Field "${fieldName}" not found`);

  const isSingleSelect = field.type.includes("SingleSelect") || field.type === "single_select";
  const isDate = field.name.toLowerCase().includes("date");

  if (isSingleSelect && field.options) {
    const option = field.options.find(
      (o) => o.name.toLowerCase() === value.toLowerCase()
    );
    if (!option) throw new Error(`Option "${value}" not found for field "${fieldName}"`);
    await ssh(
      `gh project item-edit --project-id '${meta.projectId}' --id '${itemId}' --field-id '${field.id}' --single-select-option-id '${option.id}'`
    );
  } else if (isDate) {
    await ssh(
      `gh project item-edit --project-id '${meta.projectId}' --id '${itemId}' --field-id '${field.id}' --date '${value}'`
    );
  } else if (field.type === "number") {
    await ssh(
      `gh project item-edit --project-id '${meta.projectId}' --id '${itemId}' --field-id '${field.id}' --number ${value}`
    );
  } else {
    // text/iteration
    await ssh(
      `gh project item-edit --project-id '${meta.projectId}' --id '${itemId}' --field-id '${field.id}' --text '${value.replace(/'/g, "'\\''")}'`
    );
  }

  invalidateBoardCache();
}

// --- Add item ---

export async function addItem(
  title: string,
  opts?: { oracle?: string; repo?: string }
): Promise<{ itemId: string; issueUrl?: string }> {
  const { owner, project } = getOwnerProject();
  const oracle = opts?.oracle || routeTask(title);
  const oracleName = ORACLE_MAP[oracle.toLowerCase()] || oracle;
  const repo = opts?.repo || `${owner}/${oracleName}`;

  // Create issue
  const escapedTitle = title.replace(/'/g, "'\\''");
  const body = `Task added from BoB's Office Board.\n\nAssigned to: ${oracleName}`;
  const escapedBody = body.replace(/'/g, "'\\''");

  const issueUrl = (
    await ssh(
      `gh issue create --repo '${repo}' --title '${escapedTitle}' --body '${escapedBody}'`
    )
  ).trim();

  // Add to project
  let itemId = "";
  try {
    itemId = (
      await ssh(`gh project item-add ${project} --owner ${owner} --url '${issueUrl}'`)
    ).trim();
  } catch {
    /* board add optional */
  }

  // Set oracle field if item was added
  if (itemId && oracle) {
    try {
      await setFieldByName(itemId, "Oracle", oracle);
    } catch {
      /* optional */
    }
  }

  // Auto-log task creation
  if (itemId) {
    try {
      appendActivity({
        taskId: itemId,
        type: "note",
        oracle: "bob",
        content: `Task created: "${title}", assigned to ${oracleName}`,
      });
    } catch { /* auto-log is best-effort */ }
  }

  invalidateBoardCache();
  return { itemId, issueUrl };
}

// --- Clear date ---

export async function clearDate(
  itemId: string,
  which: "start" | "target"
): Promise<void> {
  const meta = await getProjectMeta();
  const fieldName = which === "start" ? "Start Date" : "Target Date";
  // Also try without space
  const field =
    meta.fields.find((f) => f.name.toLowerCase() === fieldName.toLowerCase()) ||
    meta.fields.find(
      (f) =>
        f.name.toLowerCase() === which.toLowerCase() + " date" ||
        f.name.toLowerCase() === which.toLowerCase() + "date"
    );
  if (!field) throw new Error(`Date field "${fieldName}" not found`);

  // Clear by setting to empty via GraphQL
  await ssh(
    `gh api graphql -f query='mutation { updateProjectV2ItemFieldValue(input: { projectId: "${meta.projectId}", itemId: "${itemId}", fieldId: "${field.id}", value: { date: null } }) { projectV2Item { id } } }'`
  );

  invalidateBoardCache();
}

// --- Scan untracked ---

export async function scanUntracked(): Promise<ScanResult[]> {
  const { owner } = getOwnerProject();
  const boardItems = await fetchBoardData();
  const boardTitles = new Set(boardItems.map((i) => i.title.toLowerCase()));

  const results: ScanResult[] = [];

  // Check each oracle repo for open issues not on the board
  for (const [key, repoName] of Object.entries(ORACLE_MAP)) {
    const repo = `${owner}/${repoName}`;
    try {
      const issuesJson = await ssh(
        `gh issue list --repo '${repo}' --state open --json number,title,url,labels --limit 30`
      );
      const issues = JSON.parse(issuesJson) as {
        number: number;
        title: string;
        url: string;
        labels: { name: string }[];
      }[];
      const untracked = issues
        .filter((i) => !boardTitles.has(i.title.toLowerCase()))
        .map((i) => ({
          number: i.number,
          title: i.title,
          url: i.url,
          labels: i.labels.map((l) => l.name),
        }));

      if (untracked.length > 0) {
        results.push({ repo, issues: untracked });
      }
    } catch {
      /* repo might not exist */
    }
  }

  return results;
}

// --- Scan mine (today's commits) ---

const SCAN_MINE_CACHE_DIR = join(
  process.env.HOME || "/home/curfew",
  ".maw",
  "cache"
);

export async function scanMine(): Promise<ScanMineResult[]> {
  const today = new Date().toISOString().slice(0, 10);
  const cachePath = join(SCAN_MINE_CACHE_DIR, `scan-mine-${today}.json`);

  // Check daily cache (only cache if older than 5 min)
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
      if (Date.now() - cached.ts < 300_000) return cached.results;
    } catch {
      /* ignore corrupt cache */
    }
  }

  const ghqRoot = loadConfig().ghqRoot;
  const results: ScanMineResult[] = [];

  for (const [key, repoName] of Object.entries(ORACLE_MAP)) {
    const repoPath = `${ghqRoot}/YourOrg/${repoName}`;
    try {
      const log = await ssh(
        `git -C '${repoPath}' log --oneline --since='${today} 00:00:00' --format='%h|%s|%ai'`
      );
      const commits = log
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, ...rest] = line.split("|");
          const message = rest.slice(0, -1).join("|");
          const date = rest[rest.length - 1] || "";
          return { hash, message, date };
        });
      if (commits.length > 0) {
        results.push({ oracle: key, oracleName: repoName, commits });
      }
    } catch {
      /* repo might not exist */
    }
  }

  // Cache results
  try {
    if (!existsSync(SCAN_MINE_CACHE_DIR)) {
      mkdirSync(SCAN_MINE_CACHE_DIR, { recursive: true });
    }
    writeFileSync(
      cachePath,
      JSON.stringify({ ts: Date.now(), results }),
      "utf-8"
    );
  } catch {
    /* cache write optional */
  }

  return results;
}

// --- Auto-assign ---

export async function autoAssign(
  dryRun = false
): Promise<{ assigned: { itemId: string; title: string; oracle: string }[]; skipped: string[] }> {
  const items = await fetchBoardData();
  const assigned: { itemId: string; title: string; oracle: string }[] = [];
  const skipped: string[] = [];

  for (const item of items) {
    if (item.oracle) continue; // already assigned
    const oracle = routeTask(item.title);
    if (!oracle) {
      skipped.push(item.title);
      continue;
    }

    if (!dryRun) {
      try {
        await setFieldByName(item.id, "Oracle", oracle);
        assigned.push({ itemId: item.id, title: item.title, oracle });
      } catch {
        skipped.push(item.title);
      }
    } else {
      assigned.push({ itemId: item.id, title: item.title, oracle });
    }
  }

  if (!dryRun) invalidateBoardCache();
  return { assigned, skipped };
}

// --- Timeline data ---

export async function getTimelineData(
  filter?: string
): Promise<TimelineItem[]> {
  const items = await fetchBoardData(filter);
  const withDates = items.filter((i) => i.startDate || i.targetDate);

  if (withDates.length === 0) return [];

  // Find timeline bounds
  const allDates = withDates.flatMap((i) =>
    [i.startDate, i.targetDate].filter(Boolean)
  );
  const minDate = new Date(
    Math.min(...allDates.map((d) => new Date(d).getTime()))
  );
  const maxDate = new Date(
    Math.max(...allDates.map((d) => new Date(d).getTime()))
  );
  const totalSpan = Math.max(maxDate.getTime() - minDate.getTime(), 86400000); // at least 1 day

  return withDates.map((item) => {
    const start = item.startDate
      ? new Date(item.startDate)
      : new Date(item.targetDate);
    const end = item.targetDate
      ? new Date(item.targetDate)
      : new Date(item.startDate);
    const startOffset =
      ((start.getTime() - minDate.getTime()) / totalSpan) * 100;
    const width = Math.max(
      ((end.getTime() - start.getTime()) / totalSpan) * 100,
      2
    ); // min 2% width

    return {
      id: item.id,
      title: item.title,
      oracle: item.oracle,
      priority: item.priority,
      status: item.status,
      startDate: item.startDate,
      targetDate: item.targetDate,
      startOffset,
      width,
    };
  });
}

// --- Field add ---

export async function addField(
  name: string,
  type: "text" | "number" | "date" | "single_select"
): Promise<void> {
  const meta = await getProjectMeta();
  await ssh(
    `gh api graphql -f query='mutation { addProjectV2Field(input: { projectId: "${meta.projectId}", dataType: ${type.toUpperCase()}, name: "${name.replace(/"/g, '\\"')}" }) { projectV2Field { id } } }'`
  );
  // Invalidate fields cache
  fieldsCache = null;
  cachedProjectMeta = null;
}
