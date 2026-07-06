import { readdirSync, readFileSync } from "fs";
import { join } from "path";

interface FleetEntry {
  name: string;
  windows: { name: string; repo?: string }[];
  sync_peers?: string[];
}

export interface FleetRegistry {
  ORACLE_SESSIONS: Record<string, string>;
  FEED_ORACLE_NAMES: Record<string, string>;
  FULL_NAMES: Record<string, string>;
  EXPECTED_ORACLES: Set<string>;
  REPO_MAP: Record<string, string>;
  ORACLE_ALIASES: Record<string, string>;
}

let cached: FleetRegistry | null = null;

function buildRegistry(): FleetRegistry {
  const fleetDir = join(import.meta.dir, "../fleet");
  const sessions: Record<string, string> = {};
  const names: Record<string, string> = {};
  const repos: Record<string, string> = {};
  const aliases: Record<string, string> = {};

  try {
    const files = readdirSync(fleetDir).filter(f => f.endsWith(".json") && !f.includes(".example."));
    for (const file of files) {
      try {
        const raw: FleetEntry = JSON.parse(readFileSync(join(fleetDir, file), "utf-8"));
        const shortName = file.replace(/\.json$/, "").replace(/^\d+-/, "");
        sessions[shortName] = raw.name;
        if (raw.windows?.[0]) {
          names[shortName] = raw.windows[0].name;
          if (raw.windows[0].repo) repos[shortName] = raw.windows[0].repo;
        }
      } catch {}
    }
  } catch {}

  return {
    ORACLE_SESSIONS: sessions,
    FEED_ORACLE_NAMES: names,
    FULL_NAMES: names,
    EXPECTED_ORACLES: new Set(Object.keys(sessions)),
    REPO_MAP: repos,
    ORACLE_ALIASES: aliases,
  };
}

export function getFleetRegistry(): FleetRegistry {
  if (!cached) cached = buildRegistry();
  return cached;
}

export function resetFleetRegistry() {
  cached = null;
}

export function getOracleSessions(): Record<string, string> {
  return getFleetRegistry().ORACLE_SESSIONS;
}

export function getFeedOracleNames(): Record<string, string> {
  return getFleetRegistry().FEED_ORACLE_NAMES;
}

export function getFullNames(): Record<string, string> {
  return getFleetRegistry().FULL_NAMES;
}

export function getExpectedOracles(): Set<string> {
  return getFleetRegistry().EXPECTED_ORACLES;
}

export function getRepoMap(): Record<string, string> {
  return getFleetRegistry().REPO_MAP;
}

export function getOracleAliases(): Record<string, string> {
  return getFleetRegistry().ORACLE_ALIASES;
}
