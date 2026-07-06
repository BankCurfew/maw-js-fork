/**
 * Soul-Sync — Knowledge transfer between Oracle peers
 *
 * Implements "hand-over" mode: when an oracle completes work (maw done),
 * its recent learnings are synced to all configured sync_peers.
 *
 * Data flow: oracle's ψ/memory/learnings/ → peer's ψ/memory/learnings/
 * Sensitivity filter: skip files matching patterns (e.g., customer data)
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { loadConfig } from "./config";

const FLEET_DIR = join(import.meta.dir, "../fleet");
const SYNC_LOG_PATH = join(homedir(), ".oracle", "soul-sync.log");

/** Sensitive content patterns — files matching these are NOT synced */
const SENSITIVITY_FILTERS = [
  /customer/i,
  /aia.*portfolio/i,
  /credential/i,
  /secret/i,
  /password/i,
  /\.env/i,
  /personal.*data/i,
  /client.*info/i,
];

export interface FleetConfig {
  name: string;
  windows: Array<{ name: string; repo: string }>;
  sync_peers?: string[];
  budded_from?: string;
}

export interface SyncResult {
  peer: string;
  synced: string[];
  skipped: string[];
  errors: string[];
}

function loadFleetConfig(sessionName: string): FleetConfig | null {
  try {
    for (const file of readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"))) {
      const config: FleetConfig = JSON.parse(readFileSync(join(FLEET_DIR, file), "utf-8"));
      if (config.name === sessionName) return config;
    }
  } catch {}
  return null;
}

/** Find fleet config by oracle name (e.g., "dev" → "02-dev") */
function findFleetByOracle(oracleName: string): FleetConfig | null {
  try {
    for (const file of readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"))) {
      const config: FleetConfig = JSON.parse(readFileSync(join(FLEET_DIR, file), "utf-8"));
      // Match by session name suffix (exact) or window name (exact, strip -Oracle)
      if (config.name.endsWith(`-${oracleName}`)) return config;
      const win = config.windows?.find(w =>
        w.name.toLowerCase().replace("-oracle", "") === oracleName.toLowerCase()
      );
      if (win) return config;
    }
  } catch {}
  return null;
}

/** Check if a filename matches any sensitivity filter */
function isSensitive(filename: string, content: string): boolean {
  for (const pattern of SENSITIVITY_FILTERS) {
    if (pattern.test(filename) || pattern.test(content)) return true;
  }
  return false;
}

/** Get the repo path for an oracle from its fleet config */
function getOracleRepoPath(config: FleetConfig): string | null {
  const ghqRoot = loadConfig().ghqRoot;
  const mainWindow = config.windows?.[0];
  if (!mainWindow?.repo) return null;
  return join(ghqRoot, mainWindow.repo);
}

/** Get recent learnings (last 7 days) from an oracle's ψ/memory/learnings/ */
function getRecentLearnings(repoPath: string, days: number = 7): Array<{ name: string; content: string }> {
  const learningsDir = join(repoPath, "ψ", "memory", "learnings");
  if (!existsSync(learningsDir)) return [];

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffStr = cutoffDate.toISOString().split("T")[0]; // YYYY-MM-DD

  const files = readdirSync(learningsDir).filter(f => f.endsWith(".md"));
  const recent: Array<{ name: string; content: string }> = [];

  for (const file of files) {
    // Extract date from filename: YYYY-MM-DD_description.md
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;
    if (dateMatch[1] >= cutoffStr) {
      const content = readFileSync(join(learningsDir, file), "utf-8");
      recent.push({ name: file, content });
    }
  }

  return recent;
}

/** Sync learnings to a single peer */
function syncToPeer(
  learnings: Array<{ name: string; content: string }>,
  peerConfig: FleetConfig,
  sourceOracle: string,
): SyncResult {
  const result: SyncResult = { peer: peerConfig.name, synced: [], skipped: [], errors: [] };

  const peerRepoPath = getOracleRepoPath(peerConfig);
  if (!peerRepoPath) {
    result.errors.push("Could not resolve peer repo path");
    return result;
  }

  const targetDir = join(peerRepoPath, "ψ", "memory", "learnings");

  // Ensure target directory exists
  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (e: any) {
    result.errors.push(`Cannot create target dir: ${e.message}`);
    return result;
  }

  for (const learning of learnings) {
    // Sensitivity check
    if (isSensitive(learning.name, learning.content)) {
      result.skipped.push(`${learning.name} (sensitive content)`);
      continue;
    }

    // Skip if already exists at target (idempotent)
    const targetPath = join(targetDir, learning.name);
    if (existsSync(targetPath)) {
      result.skipped.push(`${learning.name} (already exists)`);
      continue;
    }

    // Add source attribution
    const attributed = learning.content + `\n\n---\n*Synced from ${sourceOracle} via soul-sync (hand-over)*\n`;

    try {
      writeFileSync(targetPath, attributed);
      result.synced.push(learning.name);
    } catch (e: any) {
      result.errors.push(`${learning.name}: ${e.message}`);
    }
  }

  return result;
}

/** Append to soul-sync audit log */
function logSync(sourceOracle: string, results: SyncResult[]) {
  try {
    const logDir = join(homedir(), ".oracle");
    mkdirSync(logDir, { recursive: true });

    const entry = {
      ts: new Date().toISOString(),
      source: sourceOracle,
      results: results.map(r => ({
        peer: r.peer,
        synced: r.synced.length,
        skipped: r.skipped.length,
        errors: r.errors.length,
      })),
    };
    appendFileSync(SYNC_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {}
}

/**
 * Run soul-sync for an oracle session — called by maw done
 * Returns results for display, or null if no sync_peers configured.
 */
export async function soulSync(sessionName: string): Promise<SyncResult[] | null> {
  const config = loadFleetConfig(sessionName);
  if (!config) return null;

  const peers = config.sync_peers;
  if (!peers || peers.length === 0) return null;

  const sourceRepoPath = getOracleRepoPath(config);
  if (!sourceRepoPath) return null;

  const learnings = getRecentLearnings(sourceRepoPath);
  if (learnings.length === 0) return [];

  const sourceOracle = config.windows?.[0]?.name || sessionName;
  const results: SyncResult[] = [];

  for (const peerName of peers) {
    const peerConfig = findFleetByOracle(peerName);
    if (!peerConfig) {
      results.push({ peer: peerName, synced: [], skipped: [], errors: [`Peer "${peerName}" not found in fleet`] });
      continue;
    }
    results.push(syncToPeer(learnings, peerConfig, sourceOracle));
  }

  logSync(sourceOracle, results);
  return results;
}

/** Format sync results for terminal display */
export function formatSyncResults(results: SyncResult[]): string {
  if (results.length === 0) return "  \x1b[90m○\x1b[0m no learnings to sync";

  const lines: string[] = [];
  for (const r of results) {
    if (r.errors.length > 0) {
      lines.push(`  \x1b[33m⚠\x1b[0m ${r.peer}: ${r.errors.join(", ")}`);
    }
    if (r.synced.length > 0) {
      lines.push(`  \x1b[32m✓\x1b[0m ${r.peer}: synced ${r.synced.length} learning${r.synced.length > 1 ? "s" : ""}`);
    }
    if (r.synced.length === 0 && r.errors.length === 0) {
      lines.push(`  \x1b[90m○\x1b[0m ${r.peer}: nothing new to sync (${r.skipped.length} skipped)`);
    }
  }
  return lines.join("\n");
}
