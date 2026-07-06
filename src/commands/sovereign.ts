/**
 * maw sovereign — Oracle-as-Sovereign (ψ/ separation)
 *
 * Moves ψ/ out of oracle repos into ~/.oracle/ψ/{oracle-name}/
 * and creates symlinks back so existing scripts don't break.
 *
 * Implements YourOrg/maw-js#8.
 *
 * Commands:
 *   maw sovereign status              Show migration status for all oracles
 *   maw sovereign migrate <oracle>    Migrate one oracle to sovereign layout
 *   maw sovereign migrate --all       Migrate all oracles
 *   maw sovereign rollback <oracle>   Restore original layout
 *   maw sovereign verify              Health check all symlinks
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, lstatSync, symlinkSync, unlinkSync, renameSync, writeFileSync, copyFileSync, rmSync, statSync } from "fs";
import { join, resolve, basename } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { loadConfig } from "../config";

// --- Constants ---

const SOVEREIGN_ROOT = join(homedir(), ".oracle", "ψ");
const GHQ_ORG = "YourOrg";

/** Standard ψ/ directory structure */
const PSI_DIRS = [
  "inbox/handoff",
  "memory/learnings",
  "memory/retrospectives",
  "memory/resonance",
  "writing",
  "lab",
  "active",
  "archive",
  "outbox",
];

/** Dirs excluded from git backup (large, re-creatable) */
const BACKUP_EXCLUDE_DIRS = ["learn"];

// --- Types ---

export interface OracleSovereignStatus {
  oracle: string;
  repoPath: string;
  sovereignPath: string;
  status: "sovereign" | "legacy" | "partial" | "missing" | "broken-symlink";
  psiSize?: string;
  details?: string;
}

export interface MigrationResult {
  oracle: string;
  success: boolean;
  steps: string[];
  errors: string[];
  backupPath?: string;
}

const NAME_ALIASES: Record<string, string> = {
  doc: "doccon",
};

// --- Helpers ---

/** Resolve oracle name from repo dir name: "Dev-Oracle" → "dev", "DocCon-Oracle" → "doccon" */
function repoToOracleName(repoDir: string): string {
  return repoDir.replace(/-[Oo]racle$/, "").toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/** Resolve user input to internal oracle name (applying aliases) */
function resolveOracleName(input: string): string {
  const name = input.toLowerCase().replace(/-oracle$/i, "");
  return NAME_ALIASES[name] || name;
}

/** Get directory size in human-readable format */
function getDirSize(dirPath: string): string {
  try {
    const out = execSync(`du -sh "${dirPath}" 2>/dev/null | cut -f1`, { encoding: "utf-8", timeout: 10000 });
    return out.trim() || "?";
  } catch {
    return "?";
  }
}

/** Check if a path is a symlink */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Get symlink target */
function readSymlink(path: string): string | null {
  try {
    const { readlinkSync } = require("fs");
    return readlinkSync(path);
  } catch {
    return null;
  }
}

/** Find all oracle repos in ghqRoot */
function findOracleRepos(): Array<{ name: string; repoPath: string; repoDir: string }> {
  const ghqRoot = loadConfig().ghqRoot;
  const orgDir = join(ghqRoot, GHQ_ORG);
  if (!existsSync(orgDir)) return [];

  return readdirSync(orgDir)
    .filter(d => /(-[Oo]racle|arra-oracle)$/.test(d))
    .filter(d => {
      try { return statSync(join(orgDir, d)).isDirectory(); } catch { return false; }
    })
    .map(d => ({
      name: repoToOracleName(d),
      repoPath: join(orgDir, d),
      repoDir: d,
    }));
}

/** Ensure sovereign root and oracle dir exist with restrictive permissions */
function ensureSovereignDir(oracleName: string): string {
  // Create root with 700 (owner-only) permissions
  if (!existsSync(SOVEREIGN_ROOT)) {
    mkdirSync(SOVEREIGN_ROOT, { recursive: true });
  }
  // Enforce 700 regardless of umask
  try { execSync(`chmod 700 "${SOVEREIGN_ROOT}"`, { timeout: 5000 }); } catch {}
  // .gitignore in sovereign root — prevent accidental git tracking
  const gitignorePath = join(SOVEREIGN_ROOT, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "# Sovereign oracle memory — never commit\n*\n");
  }
  const dir = join(SOVEREIGN_ROOT, oracleName);
  mkdirSync(dir, { recursive: true });
  try { execSync(`chmod 700 "${dir}"`, { timeout: 5000 }); } catch {}
  return dir;
}

/** Create backup before migration (excludes large re-creatable dirs like learn/) */
function createBackup(sourcePath: string, oracleName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); // "2026-04-07T14-30-00"
  const backupDir = join(homedir(), ".oracle", "ψ-backup-migration");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `${oracleName}-${ts}`);
  mkdirSync(backupPath, { recursive: true });

  // Use rsync excluding large dirs (learn/ can be 400MB+)
  const excludes = BACKUP_EXCLUDE_DIRS.map(d => `--exclude='${d}/'`).join(" ");
  execSync(`rsync -a ${excludes} "${sourcePath}/" "${backupPath}/"`, { timeout: 300000 }); // 5 min
  return backupPath;
}

/** Copy directory recursively (preserving structure), excluding large re-creatable dirs */
function copyDirRecursive(src: string, dest: string) {
  const excludes = BACKUP_EXCLUDE_DIRS.map(d => `--exclude='${d}/'`).join(" ");
  execSync(`rsync -a ${excludes} "${src}/" "${dest}/"`, { timeout: 300000 }); // 5 min timeout
}

// --- Status ---

export function getSovereignStatus(): OracleSovereignStatus[] {
  const repos = findOracleRepos();
  const results: OracleSovereignStatus[] = [];

  for (const { name, repoPath, repoDir } of repos) {
    const psiPath = join(repoPath, "ψ");
    const sovereignPath = join(SOVEREIGN_ROOT, name);
    const status: OracleSovereignStatus = {
      oracle: name,
      repoPath,
      sovereignPath,
    } as OracleSovereignStatus;

    if (isSymlink(psiPath)) {
      const target = readSymlink(psiPath);
      if (target && existsSync(resolve(repoPath, target))) {
        status.status = "sovereign";
        status.psiSize = getDirSize(sovereignPath);
        status.details = `symlink → ${target}`;
      } else {
        status.status = "broken-symlink";
        status.details = `broken → ${target}`;
      }
    } else if (existsSync(psiPath)) {
      status.status = "legacy";
      status.psiSize = getDirSize(psiPath);
      status.details = "ψ/ is real directory inside repo";
    } else {
      if (existsSync(sovereignPath)) {
        status.status = "partial";
        status.details = "sovereign dir exists but no symlink in repo";
      } else {
        status.status = "missing";
        status.details = "no ψ/ found";
      }
    }

    results.push(status);
  }

  return results;
}

// --- Migrate ---

export function migrateOracle(oracleName: string, opts: { dryRun?: boolean; force?: boolean } = {}): MigrationResult {
  const result: MigrationResult = { oracle: oracleName, success: false, steps: [], errors: [] };
  const repos = findOracleRepos();
  const repo = repos.find(r => r.name === oracleName);

  if (!repo) {
    result.errors.push(`Oracle "${oracleName}" not found in ${join(loadConfig().ghqRoot, GHQ_ORG)}`);
    return result;
  }

  const psiPath = join(repo.repoPath, "ψ");
  const sovereignPath = join(SOVEREIGN_ROOT, oracleName);

  // Pre-flight: check for active tmux sessions
  try {
    const sessions = execSync(`tmux list-sessions -F '#{session_name}' 2>/dev/null`, { encoding: "utf-8", timeout: 5000 });
    const active = sessions.trim().split("\n").some(s => s.toLowerCase().includes(oracleName));
    if (active) {
      if (!opts.force) {
        result.errors.push(`Active tmux session detected for ${oracleName} — stop with 'maw sleep ${oracleName}' before migrating, or use --force`);
        return result;
      }
      result.steps.push(`⚠️ Active session detected — proceeding with --force`);
    }
  } catch {} // no tmux = safe

  // Pre-flight checks
  if (isSymlink(psiPath)) {
    const target = readSymlink(psiPath);
    if (target && existsSync(resolve(repo.repoPath, target))) {
      result.steps.push(`Already sovereign (symlink → ${target})`);
      result.success = true;
      return result;
    } else {
      result.errors.push(`Broken symlink at ${psiPath} → ${target}. Use --force or rollback first.`);
      if (!opts.force) return result;
      result.steps.push("Removing broken symlink (--force)");
      if (!opts.dryRun) unlinkSync(psiPath);
    }
  }

  if (!existsSync(psiPath)) {
    if (existsSync(sovereignPath)) {
      // Just needs symlink
      result.steps.push(`Sovereign dir exists at ${sovereignPath} — creating symlink`);
      if (!opts.dryRun) {
        symlinkSync(sovereignPath, psiPath);
      }
      result.success = true;
      return result;
    }
    // No ψ/ at all — create fresh sovereign
    result.steps.push(`No existing ψ/ — creating fresh sovereign structure`);
    if (!opts.dryRun) {
      ensureSovereignDir(oracleName);
      for (const dir of PSI_DIRS) {
        mkdirSync(join(sovereignPath, dir), { recursive: true });
      }
      symlinkSync(sovereignPath, psiPath);
    }
    result.success = true;
    return result;
  }

  // Real ψ/ directory exists — full migration

  // Step 1: Backup
  result.steps.push(`Backing up ${psiPath}`);
  if (!opts.dryRun) {
    try {
      result.backupPath = createBackup(psiPath, oracleName);
      result.steps.push(`Backup created at ${result.backupPath}`);
    } catch (e: any) {
      result.errors.push(`Backup failed: ${e.message}`);
      return result;
    }
  }

  // Step 2: Ensure sovereign directory
  result.steps.push(`Creating sovereign dir: ${sovereignPath}`);
  if (!opts.dryRun) {
    ensureSovereignDir(oracleName);
    for (const dir of PSI_DIRS) {
      mkdirSync(join(sovereignPath, dir), { recursive: true });
    }
  }

  // Step 3: Copy ψ/ contents to sovereign location
  result.steps.push(`Copying ψ/ contents to sovereign location`);
  if (!opts.dryRun) {
    try {
      copyDirRecursive(psiPath, sovereignPath);
    } catch (e: any) {
      result.errors.push(`Copy failed: ${e.message}. Backup at ${result.backupPath}`);
      return result;
    }
  }

  // Step 4: Verify copy (check file count matches)
  if (!opts.dryRun) {
    try {
      const excludeFind = BACKUP_EXCLUDE_DIRS.map(d => `-not -path '*/${d}/*'`).join(" ");
      const srcCount = execSync(`find "${psiPath}" -type f ${excludeFind} 2>/dev/null | wc -l`, { encoding: "utf-8", timeout: 30000 }).trim();
      const dstCount = execSync(`find "${sovereignPath}" -type f ${excludeFind} 2>/dev/null | wc -l`, { encoding: "utf-8", timeout: 30000 }).trim();
      if (srcCount !== dstCount) {
        result.errors.push(`File count mismatch: source=${srcCount}, dest=${dstCount}. Aborting — backup at ${result.backupPath}`);
        return result;
      }
      result.steps.push(`Verified: ${srcCount} files copied`);
    } catch (e: any) {
      result.errors.push(`Verification failed: ${e.message}. Backup at ${result.backupPath}`);
      return result;
    }
  }

  // Step 5: Remove original ψ/ and create symlink (atomic swap)
  result.steps.push(`Atomic swap: original ψ/ → symlink`);
  if (!opts.dryRun) {
    try {
      // Create symlink at temp location, then atomic rename over original
      const tmpLink = psiPath + ".sovereign-tmp";
      // Clean up any leftover tmp from previous failed attempt
      try { unlinkSync(tmpLink); } catch {}
      symlinkSync(sovereignPath, tmpLink);
      // Remove original dir, then rename tmp symlink into place
      rmSync(psiPath, { recursive: true, force: true });
      renameSync(tmpLink, psiPath); // atomic on same filesystem
    } catch (e: any) {
      // Clean up tmp if it exists
      try { unlinkSync(psiPath + ".sovereign-tmp"); } catch {}
      result.errors.push(`Symlink creation failed: ${e.message}. Restore from backup: cp -a ${result.backupPath} ${psiPath}`);
      return result;
    }
  }

  // Step 6: Verify symlink works
  if (!opts.dryRun) {
    if (isSymlink(psiPath) && existsSync(psiPath)) {
      result.steps.push(`Symlink verified: ${psiPath} → ${sovereignPath}`);
    } else {
      result.errors.push(`Symlink verification failed! Restore: cp -a ${result.backupPath} ${psiPath}`);
      return result;
    }
  }

  result.success = true;
  return result;
}

// --- Rollback ---

export function rollbackOracle(oracleName: string, opts: { dryRun?: boolean } = {}): MigrationResult {
  const result: MigrationResult = { oracle: oracleName, success: false, steps: [], errors: [] };
  const repos = findOracleRepos();
  const repo = repos.find(r => r.name === oracleName);

  if (!repo) {
    result.errors.push(`Oracle "${oracleName}" not found`);
    return result;
  }

  const psiPath = join(repo.repoPath, "ψ");
  const sovereignPath = join(SOVEREIGN_ROOT, oracleName);

  // Check if actually sovereign
  if (!isSymlink(psiPath)) {
    if (existsSync(psiPath)) {
      result.steps.push("Already legacy layout (ψ/ is real directory)");
      result.success = true;
      return result;
    }
    result.errors.push("No ψ/ exists at all — nothing to rollback");
    return result;
  }

  // Step 1: Check sovereign data exists
  if (!existsSync(sovereignPath)) {
    // Check migration backups
    const backupDir = join(homedir(), ".oracle", "ψ-backup-migration");
    const backups = existsSync(backupDir) ? readdirSync(backupDir).filter(d => d.startsWith(oracleName)) : [];

    if (backups.length > 0) {
      const latestBackup = join(backupDir, backups.sort().pop()!);
      result.steps.push(`Sovereign dir missing — restoring from backup: ${latestBackup}`);
      if (!opts.dryRun) {
        unlinkSync(psiPath);
        execSync(`cp -a "${latestBackup}" "${psiPath}"`, { timeout: 60000 });
      }
      result.success = true;
      return result;
    }

    result.errors.push(`No sovereign data at ${sovereignPath} and no backups found`);
    return result;
  }

  // Step 2: Remove symlink
  result.steps.push(`Removing symlink at ${psiPath}`);
  if (!opts.dryRun) {
    unlinkSync(psiPath);
  }

  // Step 3: Copy sovereign data back to repo
  result.steps.push(`Copying sovereign data back to ${psiPath}`);
  if (!opts.dryRun) {
    mkdirSync(psiPath, { recursive: true });
    copyDirRecursive(sovereignPath, psiPath);
  }

  // Step 4: Verify
  if (!opts.dryRun) {
    const srcCount = execSync(`find "${sovereignPath}" -type f 2>/dev/null | wc -l`, { encoding: "utf-8", timeout: 30000 }).trim();
    const dstCount = execSync(`find "${psiPath}" -type f 2>/dev/null | wc -l`, { encoding: "utf-8", timeout: 30000 }).trim();
    if (srcCount !== dstCount) {
      result.errors.push(`File count mismatch after rollback: sovereign=${srcCount}, repo=${dstCount}`);
      return result;
    }
    result.steps.push(`Verified: ${srcCount} files restored`);
  }

  // Note: sovereign data NOT deleted — kept as backup
  result.steps.push(`Sovereign data preserved at ${sovereignPath} (manual cleanup if desired)`);
  result.success = true;
  return result;
}

// --- Verify ---

export function verifySovereignHealth(): Array<{ oracle: string; ok: boolean; issue?: string }> {
  const results: Array<{ oracle: string; ok: boolean; issue?: string }> = [];
  const repos = findOracleRepos();

  for (const { name, repoPath } of repos) {
    const psiPath = join(repoPath, "ψ");
    const sovereignPath = join(SOVEREIGN_ROOT, name);

    if (isSymlink(psiPath)) {
      const target = readSymlink(psiPath);
      if (!target || !existsSync(resolve(repoPath, target))) {
        results.push({ oracle: name, ok: false, issue: `Broken symlink → ${target}` });
      } else if (!existsSync(join(sovereignPath, "memory"))) {
        results.push({ oracle: name, ok: false, issue: "Sovereign dir missing memory/" });
      } else {
        results.push({ oracle: name, ok: true });
      }
    } else if (existsSync(psiPath)) {
      results.push({ oracle: name, ok: true, issue: "Legacy layout (not migrated)" });
    } else {
      results.push({ oracle: name, ok: false, issue: "No ψ/ found" });
    }
  }

  // Check backup freshness
  const backupRepo = join(homedir(), ".oracle", "ψ-backup");
  if (existsSync(backupRepo)) {
    try {
      const lastCommit = execSync(`git -C "${backupRepo}" log -1 --format='%ct' 2>/dev/null`, { encoding: "utf-8", timeout: 5000 }).trim();
      const ageHours = (Date.now() / 1000 - parseInt(lastCommit)) / 3600;
      if (ageHours > 24) {
        results.push({ oracle: "_backup", ok: false, issue: `ψ-backup stale: ${Math.round(ageHours)}h old` });
      }
    } catch {}
  }

  return results;
}

// --- CLI Display ---

function formatStatus(statuses: OracleSovereignStatus[]): string {
  const lines: string[] = [];
  lines.push(`\x1b[36m🏛️  Oracle Sovereign Status\x1b[0m`);
  lines.push("━".repeat(60));

  const sovereign = statuses.filter(s => s.status === "sovereign");
  const legacy = statuses.filter(s => s.status === "legacy");
  const broken = statuses.filter(s => s.status === "broken-symlink");
  const partial = statuses.filter(s => s.status === "partial");
  const missing = statuses.filter(s => s.status === "missing");

  lines.push(`  \x1b[32m${sovereign.length} sovereign\x1b[0m | \x1b[33m${legacy.length} legacy\x1b[0m | \x1b[31m${broken.length} broken\x1b[0m | \x1b[90m${partial.length} partial, ${missing.length} missing\x1b[0m\n`);

  for (const s of statuses) {
    const icon = s.status === "sovereign" ? "\x1b[32m✓\x1b[0m" :
                 s.status === "legacy" ? "\x1b[33m○\x1b[0m" :
                 s.status === "broken-symlink" ? "\x1b[31m✗\x1b[0m" :
                 s.status === "partial" ? "\x1b[33m◐\x1b[0m" :
                 "\x1b[90m·\x1b[0m";
    const size = s.psiSize ? ` (${s.psiSize})` : "";
    lines.push(`  ${icon} ${s.oracle.padEnd(16)} ${s.status.padEnd(16)}${size}`);
    if (s.details && (s.status === "broken-symlink" || s.status === "partial")) {
      lines.push(`    \x1b[90m${s.details}\x1b[0m`);
    }
  }

  lines.push("\n" + "━".repeat(60));
  lines.push(`\x1b[90mSovereign root: ${SOVEREIGN_ROOT}\x1b[0m`);

  if (legacy.length > 0) {
    lines.push(`\n\x1b[33mTo migrate:\x1b[0m maw sovereign migrate <oracle>`);
    lines.push(`\x1b[33mMigrate all:\x1b[0m maw sovereign migrate --all`);
  }

  return lines.join("\n");
}

function formatMigrationResult(result: MigrationResult): string {
  const lines: string[] = [];
  const icon = result.success ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  lines.push(`${icon} ${result.oracle}`);

  for (const step of result.steps) {
    lines.push(`  \x1b[32m✓\x1b[0m ${step}`);
  }
  for (const err of result.errors) {
    lines.push(`  \x1b[31m✗\x1b[0m ${err}`);
  }
  if (result.backupPath) {
    lines.push(`  \x1b[90mBackup: ${result.backupPath}\x1b[0m`);
  }

  return lines.join("\n");
}

function formatVerifyResults(results: Array<{ oracle: string; ok: boolean; issue?: string }>): string {
  const lines: string[] = [];
  lines.push(`\x1b[36m🔍 Sovereign Health Check\x1b[0m`);
  lines.push("━".repeat(50));

  const ok = results.filter(r => r.ok && !r.issue);
  const warn = results.filter(r => r.ok && r.issue);
  const fail = results.filter(r => !r.ok);

  for (const r of results) {
    if (r.oracle === "_backup") {
      const icon = r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      lines.push(`  ${icon} backup  ${r.issue || "OK"}`);
      continue;
    }
    const icon = !r.ok ? "\x1b[31m✗\x1b[0m" : r.issue ? "\x1b[33m○\x1b[0m" : "\x1b[32m✓\x1b[0m";
    lines.push(`  ${icon} ${r.oracle.padEnd(16)} ${r.issue || "OK"}`);
  }

  lines.push("━".repeat(50));
  lines.push(`  \x1b[32m${ok.length} healthy\x1b[0m | \x1b[33m${warn.length} legacy\x1b[0m | \x1b[31m${fail.length} issues\x1b[0m`);
  return lines.join("\n");
}

// --- CLI Entry ---

export async function cmdSovereign(args: string[]) {
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === "status" || sub === "ls") {
    const statuses = getSovereignStatus();
    console.log(formatStatus(statuses));

  } else if (sub === "migrate") {
    const target = args[1];
    const dryRun = args.includes("--dry-run");
    const force = args.includes("--force");

    if (!target) {
      console.error("usage: maw sovereign migrate <oracle> [--dry-run] [--force]");
      console.error("       maw sovereign migrate --all [--dry-run]");
      process.exit(1);
    }

    if (target === "--all") {
      console.log(`\x1b[36m🏛️  Sovereign Migration — All Oracles\x1b[0m${dryRun ? " (DRY RUN)" : ""}\n`);
      const repos = findOracleRepos();
      let migrated = 0, skipped = 0, failed = 0;

      for (const { name } of repos) {
        const result = migrateOracle(name, { dryRun, force });
        console.log(formatMigrationResult(result));
        if (result.success) {
          if (result.steps.some(s => s.startsWith("Already"))) skipped++;
          else migrated++;
        } else {
          failed++;
        }
      }

      console.log(`\n${"━".repeat(50)}`);
      console.log(`  \x1b[32m${migrated} migrated\x1b[0m | \x1b[90m${skipped} already sovereign\x1b[0m | \x1b[31m${failed} failed\x1b[0m`);
    } else {
      const oracleName = resolveOracleName(target);
      console.log(`\x1b[36m🏛️  Sovereign Migration — ${oracleName}\x1b[0m${dryRun ? " (DRY RUN)" : ""}\n`);
      const result = migrateOracle(oracleName, { dryRun, force });
      console.log(formatMigrationResult(result));
    }

  } else if (sub === "rollback") {
    const target = args[1];
    const dryRun = args.includes("--dry-run");

    if (!target) {
      console.error("usage: maw sovereign rollback <oracle> [--dry-run]");
      process.exit(1);
    }

    const oracleName = resolveOracleName(target);
    console.log(`\x1b[36m🏛️  Sovereign Rollback — ${oracleName}\x1b[0m${dryRun ? " (DRY RUN)" : ""}\n`);
    const result = rollbackOracle(oracleName, { dryRun });
    console.log(formatMigrationResult(result));

  } else if (sub === "verify" || sub === "health") {
    const results = verifySovereignHealth();
    console.log(formatVerifyResults(results));

  } else {
    console.error(`usage: maw sovereign <status|migrate|rollback|verify>`);
    console.error(`       maw sovereign status              Show migration status`);
    console.error(`       maw sovereign migrate <oracle>    Migrate oracle to sovereign`);
    console.error(`       maw sovereign migrate --all       Migrate all oracles`);
    console.error(`       maw sovereign rollback <oracle>   Restore original layout`);
    console.error(`       maw sovereign verify              Health check symlinks`);
    process.exit(1);
  }
}
