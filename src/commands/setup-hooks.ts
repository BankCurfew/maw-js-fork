import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, chmodSync } from "fs";
import { basename, dirname, join } from "path";
import { homedir } from "os";

// ─────────────────────────────────────────────────────────────
// maw setup hooks — auto-generate .claude/settings.json
//
// Echo discovered (2026-04-16) that Claude Code hooks require
// DOUBLE NESTING in settings.json. Flat format is silently
// ignored — no error, no warning. This cost 4 hours on curfew.
//
// Wrong (silently ignored):
//   "hooks": { "PreToolUse": [{ "type": "command", "command": "..." }] }
//
// Correct (executes):
//   "hooks": { "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "..." }] }] }
// ─────────────────────────────────────────────────────────────

type HookCmd = { type: "command"; command: string; timeout?: number };
type HookMatcher = { matcher: string; hooks: HookCmd[] };
type HookSchema = {
  PreToolUse?: HookMatcher[];
  PostToolUse?: HookMatcher[];
  Notification?: HookMatcher[];
  Stop?: HookMatcher[];
  UserPromptSubmit?: HookMatcher[];
  SubagentStop?: HookMatcher[];
};

interface SettingsJson {
  hooks?: HookSchema | Record<string, any>;
  [key: string]: any;
}

/** Standard oracle hooks (mirrors the pattern used across YourOrg/*-Oracle repos). */
export function standardOracleHooks(oracleName: string): HookSchema {
  const env = `ORACLE_NAME=${oracleName}`;
  return {
    PreToolUse: [
      {
        matcher: ".*",
        hooks: [{ type: "command", command: `${env} python3 ~/.oracle/feed-hook.py` }],
      },
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: `${env} bash ~/.oracle/hooks/safety-guardian.sh` }],
      },
      {
        matcher: "mcp__playwright",
        hooks: [{ type: "command", command: `${env} bash ~/.oracle/hooks/playwright-limiter.sh` }],
      },
    ],
    PostToolUse: [
      {
        matcher: ".*",
        hooks: [{ type: "command", command: `${env} python3 ~/.oracle/feed-hook.py` }],
      },
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: `${env} bash ~/.oracle/hooks/talk-to-enforcer.sh` }],
      },
      {
        matcher: "mcp__playwright",
        hooks: [{ type: "command", command: `${env} bash ~/.oracle/hooks/playwright-release.sh` }],
      },
      {
        matcher: ".*",
        hooks: [{ type: "command", command: `${env} bash ~/.oracle/hooks/context-guardian.sh` }],
      },
    ],
    Notification: [
      {
        matcher: ".*",
        hooks: [{ type: "command", command: `${env} python3 ~/.oracle/feed-hook.py` }],
      },
    ],
    Stop: [
      {
        matcher: ".*",
        hooks: [
          { type: "command", command: `${env} python3 ~/.oracle/feed-hook.py` },
          { type: "command", command: `${env} bash ~/.oracle/hooks/cc-bob-enforcer.sh` },
        ],
      },
    ],
  };
}

/**
 * Detect whether a hooks block uses the silently-ignored flat format.
 *
 * Flat (wrong): entry has `type` or `command` directly on the object.
 * Nested (correct): entry has `matcher` + an inner `hooks` array.
 */
export function isFlatFormat(hooks: any): boolean {
  if (!hooks || typeof hooks !== "object") return false;
  for (const event of Object.keys(hooks)) {
    const arr = hooks[event];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;
      const hasFlat = "type" in entry || "command" in entry;
      const hasNested = "matcher" in entry && Array.isArray(entry.hooks);
      if (hasFlat && !hasNested) return true;
    }
  }
  return false;
}

/** Migrate a flat hooks block to the correct double-nested schema. */
export function migrateFlatToNested(hooks: any): HookSchema {
  const out: HookSchema = {};
  for (const event of Object.keys(hooks)) {
    const arr = hooks[event];
    if (!Array.isArray(arr)) continue;
    const nested: HookMatcher[] = [];
    for (const entry of arr) {
      if (!entry || typeof entry !== "object") continue;
      if ("matcher" in entry && Array.isArray(entry.hooks)) {
        // Already nested — keep as-is.
        nested.push(entry as HookMatcher);
      } else if ("type" in entry || "command" in entry) {
        // Flat — wrap with matcher:"*"
        nested.push({
          matcher: "*",
          hooks: [
            {
              type: entry.type || "command",
              command: entry.command,
              ...(entry.timeout ? { timeout: entry.timeout } : {}),
            },
          ],
        });
      }
    }
    if (nested.length) (out as any)[event] = nested;
  }
  return out;
}

/** Infer oracle name from directory (e.g. /path/to/QA-Oracle → QA-Oracle). */
function inferOracleName(targetDir: string): string {
  const base = basename(targetDir).replace(/\.wt-.*$/, "");
  // Preserve *-Oracle casing if already present
  if (/-oracle$/i.test(base)) return base;
  // Otherwise capitalize and append -Oracle
  return base.charAt(0).toUpperCase() + base.slice(1) + "-Oracle";
}

export interface SetupHooksOptions {
  oracle?: string;
  force?: boolean; // overwrite non-flat settings too
  dryRun?: boolean;
}

export interface SetupHooksResult {
  path: string;
  action: "created" | "migrated" | "skipped" | "dry-run";
  oracleName: string;
  detectedFlat: boolean;
  installedHooks?: number;
}

/** Core library entry — used by CLI and by fleet-init / wake. */
export function setupHooks(targetDir: string, opts: SetupHooksOptions = {}): SetupHooksResult {
  if (!existsSync(targetDir)) {
    throw new Error(`target directory not found: ${targetDir}`);
  }
  const oracleName = opts.oracle || inferOracleName(targetDir);
  const claudeDir = join(targetDir, ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  const nextHooks = standardOracleHooks(oracleName);

  let existing: SettingsJson = {};
  let detectedFlat = false;

  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      // Corrupt JSON — treat as empty so we can rewrite
      existing = {};
    }
    detectedFlat = isFlatFormat(existing.hooks);
  }

  // Decide action
  let action: SetupHooksResult["action"];
  if (!existsSync(settingsPath)) {
    action = "created";
  } else if (detectedFlat) {
    action = "migrated";
  } else if (opts.force) {
    action = "created";
  } else {
    action = "skipped";
  }

  if (action === "skipped") {
    return { path: settingsPath, action, oracleName, detectedFlat };
  }

  // Build final settings
  const mergedHooks: HookSchema =
    action === "migrated"
      ? // Preserve any already-nested entries from existing, then overlay standard
        mergeHookSchemas(migrateFlatToNested(existing.hooks || {}), nextHooks)
      : nextHooks;

  const next: SettingsJson = {
    ...existing,
    hooks: mergedHooks,
  };

  if (opts.dryRun) {
    return { path: settingsPath, action: "dry-run", oracleName, detectedFlat };
  }

  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(next, null, 2) + "\n");

  // Install hook scripts from repo's hooks/ directory to ~/.oracle/hooks/
  const installedHooks = installHookScripts(targetDir);

  return { path: settingsPath, action, oracleName, detectedFlat, installedHooks };
}

/** Copy .sh hook scripts from repo hooks/ dir to ~/.oracle/hooks/ */
function installHookScripts(repoDir: string): number {
  // Find the maw-js repo root (hooks/ lives there)
  const mawJsRoot = findMawJsRoot(repoDir);
  if (!mawJsRoot) return 0;

  const srcDir = join(mawJsRoot, "hooks");
  if (!existsSync(srcDir)) return 0;

  const destDir = join(homedir(), ".oracle", "hooks");
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

  const files = readdirSync(srcDir).filter(f => f.endsWith(".sh"));
  let count = 0;
  for (const file of files) {
    const src = join(srcDir, file);
    const dest = join(destDir, file);
    copyFileSync(src, dest);
    chmodSync(dest, 0o755);
    count++;
  }
  return count;
}

/** Walk up from targetDir to find maw-js repo root (has hooks/ dir) */
function findMawJsRoot(startDir: string): string | null {
  // Check common locations
  const candidates = [
    join(homedir(), "repos", "github.com", "YourOrg", "maw-js"),
    join(homedir(), "Code", "github.com", "YourOrg", "maw-js"),
    join(homedir(), "Code", "github.com", "YourOrg", "maw-js"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "hooks"))) return c;
  }
  return null;
}

/** Overlay b's entries on top of a, deduping by matcher+command pair per event. */
function mergeHookSchemas(a: HookSchema, b: HookSchema): HookSchema {
  const out: HookSchema = {};
  const events = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const ev of events) {
    const aList = ((a as any)[ev] || []) as HookMatcher[];
    const bList = ((b as any)[ev] || []) as HookMatcher[];
    const merged: HookMatcher[] = [...aList];
    const seen = new Set(
      aList.flatMap(m => (m.hooks || []).map(h => `${m.matcher}::${h.command}`)),
    );
    for (const bm of bList) {
      const kept: HookCmd[] = [];
      for (const h of bm.hooks || []) {
        const key = `${bm.matcher}::${h.command}`;
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(h);
      }
      if (kept.length) merged.push({ matcher: bm.matcher, hooks: kept });
    }
    (out as any)[ev] = merged;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// CLI entry: `maw setup hooks [path] [--oracle NAME] [--force] [--dry-run]`
// ─────────────────────────────────────────────────────────────
export async function cmdSetupHooks(argv: string[]): Promise<void> {
  let targetDir: string | undefined;
  const opts: SetupHooksOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--oracle" && argv[i + 1]) { opts.oracle = argv[++i]; continue; }
    if (a === "--force") { opts.force = true; continue; }
    if (a === "--dry-run") { opts.dryRun = true; continue; }
    if (!a.startsWith("-") && !targetDir) { targetDir = a; continue; }
  }
  targetDir = targetDir || process.cwd();

  const r = setupHooks(targetDir, opts);
  const dim = "\x1b[2m", reset = "\x1b[0m", green = "\x1b[32m", yellow = "\x1b[33m", cyan = "\x1b[36m";

  console.log("");
  console.log(`  ${cyan}maw setup hooks${reset}`);
  console.log(`  ${dim}target:${reset} ${r.path}`);
  console.log(`  ${dim}oracle:${reset} ${r.oracleName}`);
  if (r.detectedFlat) {
    console.log(`  ${yellow}⚠ flat-format hooks detected — will migrate to double-nested schema${reset}`);
  }
  switch (r.action) {
    case "created":
      console.log(`  ${green}✓ created${reset} settings.json with standard oracle hooks`);
      break;
    case "migrated":
      console.log(`  ${green}✓ migrated${reset} flat hooks → double-nested schema`);
      break;
    case "skipped":
      console.log(`  ${dim}skipped${reset} — settings.json already uses nested schema (pass --force to overwrite)`);
      break;
    case "dry-run":
      console.log(`  ${dim}dry-run${reset} — no changes written`);
      break;
  }
  if (r.installedHooks && r.installedHooks > 0) {
    console.log(`  ${green}✓ installed${reset} ${r.installedHooks} hook scripts → ~/.oracle/hooks/`);
  }
  console.log("");
}
