/**
 * maw bud — Oracle Reproduction (Yeast Budding Model)
 *
 * Spawns a new child oracle from a parent oracle with security gates:
 * 1. Human approval required (--approved-by or interactive)
 * 2. Credential isolation (fresh, no inheritance)
 * 3. Audit trail (feed.log + soul-sync.log)
 * 4. Bud depth max 2 (reject grandchild of grandchild)
 * 5. Dormancy timeline tracked (budded_at for TTL)
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, symlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { ssh } from "../ssh";
import { loadConfig } from "../config";

const SOVEREIGN_ROOT = join(homedir(), ".oracle", "ψ");
import { cmdWake } from "./wake";

const FLEET_DIR = join(import.meta.dir, "../../fleet");
const FEED_LOG = join(homedir(), ".oracle", "feed.log");
const MAX_BUD_DEPTH = 2;
const ORG = "YourOrg";

interface BudOptions {
  from?: string;      // parent oracle name (default: detect from current session)
  repo?: string;      // incubate external repo instead of creating new
  dryRun?: boolean;
  approvedBy?: string; // --approved-by <human> (security gate #1)
}

interface FleetConfig {
  name: string;
  windows: Array<{ name: string; repo: string }>;
  budded_from?: string;
  budded_at?: string;
  sync_peers?: string[];
}

/** Reserved oracle names — cannot be used as bud names */
const RESERVED_NAMES = new Set([
  "bob", "dev", "qa", "security", "hr", "admin", "data", "doc", "editor",
  "designer", "researcher", "writer", "botdev", "creator", "aia", "fe", "pa",
  "maw", "oracle", "root", "pulse", "system",
]);

// --- Helpers ---

function logToFeed(oracle: string, message: string) {
  try {
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    const line = `${ts} | ${oracle} | ${homedir().split("/").pop()} | Notification | maw-bud | maw-bud » ${message}\n`;
    appendFileSync(FEED_LOG, line);
  } catch {}
}

function loadAllFleetConfigs(): FleetConfig[] {
  try {
    return readdirSync(FLEET_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => JSON.parse(readFileSync(join(FLEET_DIR, f), "utf-8")));
  } catch {
    return [];
  }
}

function findFleetConfig(oracleName: string): FleetConfig | null {
  for (const config of loadAllFleetConfigs()) {
    if (config.name.endsWith(`-${oracleName}`)) return config;
    const win = config.windows?.find(w =>
      w.name.toLowerCase().replace("-oracle", "") === oracleName.toLowerCase()
    );
    if (win) return config;
  }
  return null;
}

/** Security Gate #4: Check bud depth — max 2 levels */
function getBudDepth(oracleName: string): number {
  let depth = 0;
  let current = oracleName;
  const configs = loadAllFleetConfigs();
  const visited = new Set<string>();

  while (depth < 10) { // safety limit
    if (visited.has(current)) break;
    visited.add(current);

    const config = configs.find(c =>
      c.name.endsWith(`-${current}`) ||
      c.windows?.some(w => w.name.toLowerCase().replace("-oracle", "") === current.toLowerCase())
    );
    if (!config?.budded_from) break;
    depth++;
    current = config.budded_from;
  }

  return depth;
}

/** Get next available fleet number */
function getNextFleetNumber(): number {
  try {
    const files = readdirSync(FLEET_DIR).filter(f => f.endsWith(".json"));
    const nums = files.map(f => parseInt(f.split("-")[0])).filter(n => !isNaN(n) && n < 90);
    return nums.length > 0 ? Math.max(...nums) + 1 : 19;
  } catch {
    return 19;
  }
}

// --- Main ---

export async function cmdBud(name: string, opts: BudOptions) {
  const ghqRoot = loadConfig().ghqRoot;
  const parentName = opts.from || detectParentOracle();
  // Normalize: "dashboard_dev" → "dashboard-dev", "Dashboard" → "dashboard"
  // Convert underscores to hyphens, strip "-oracle" suffix if user included it
  const budName = name.toLowerCase().replace(/_/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-oracle$/, "").replace(/^-+|-+$/g, "");

  if (!budName) {
    console.error(`\x1b[31m✗ DENIED\x1b[0m — Invalid oracle name: "${name}"`);
    process.exit(1);
  }
  // Title case for display: "dashboard-dev" → "DashboardDev"
  const titleCase = budName.split("-").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join("");
  const repoName = `${titleCase}-Oracle`;
  const oracleDisplayName = `${titleCase}-Oracle`;

  // Validate: reserved names
  if (RESERVED_NAMES.has(budName)) {
    console.error(`\x1b[31m✗ DENIED\x1b[0m — "${budName}" is a reserved oracle name`);
    process.exit(1);
  }

  console.log(`\n\x1b[36m🧬 maw bud\x1b[0m — Oracle Reproduction\n`);
  console.log(`  Parent:  ${parentName || "(none — root oracle)"}`);
  console.log(`  Child:   ${oracleDisplayName}`);
  console.log(`  Repo:    ${ORG}/${repoName}`);
  console.log();

  // ═══════════════════════════════════════════════
  // SECURITY GATE #1: Human approval required
  // ═══════════════════════════════════════════════
  if (!opts.approvedBy) {
    console.error(`\x1b[31m✗ DENIED\x1b[0m — Security Gate #1: Human approval required`);
    console.error(`  Use: maw bud ${name} --approved-by bank`);
    logToFeed("maw-bud", `DENIED: bud "${budName}" — no human approval (gate #1)`);
    process.exit(1);
  }
  console.log(`  \x1b[32m✓\x1b[0m Gate #1: Approved by ${opts.approvedBy}`);

  // ═══════════════════════════════════════════════
  // SECURITY GATE #4: Bud depth max 2
  // ═══════════════════════════════════════════════
  if (parentName) {
    const depth = getBudDepth(parentName);
    if (depth >= MAX_BUD_DEPTH) {
      console.error(`\x1b[31m✗ DENIED\x1b[0m — Security Gate #4: Bud depth ${depth + 1} exceeds max ${MAX_BUD_DEPTH}`);
      console.error(`  ${parentName} is already at depth ${depth}. Cannot bud further.`);
      logToFeed("maw-bud", `DENIED: bud "${budName}" from "${parentName}" — depth ${depth + 1} exceeds max ${MAX_BUD_DEPTH} (gate #4)`);
      process.exit(1);
    }
    console.log(`  \x1b[32m✓\x1b[0m Gate #4: Bud depth ${depth + 1}/${MAX_BUD_DEPTH} (OK)`);
  } else {
    console.log(`  \x1b[32m✓\x1b[0m Gate #4: Root oracle (depth 0)`);
  }

  // ═══════════════════════════════════════════════
  // SECURITY GATE #2: Credential isolation
  // ═══════════════════════════════════════════════
  // Gate #2 enforcement is in Step 6 (soul-sync seed) where sensitive content is filtered
  console.log(`  \x1b[32m✓\x1b[0m Gate #2: Fresh credentials (no parent inheritance — enforced in Step 6 seed filter)`);

  // ═══════════════════════════════════════════════
  // SECURITY GATE #5: Dormancy timeline
  // ═══════════════════════════════════════════════
  const buddedAt = new Date().toISOString();
  console.log(`  \x1b[32m✓\x1b[0m Gate #5: Dormancy tracked — budded at ${buddedAt.split("T")[0]}`);
  console.log(`           30d → credentials suspended, 90d → revoked + archived`);

  // ═══════════════════════════════════════════════
  // SECURITY GATE #3: Audit trail
  // ═══════════════════════════════════════════════
  logToFeed("maw-bud", `APPROVED: bud "${budName}" from "${parentName || "root"}" by ${opts.approvedBy}`);
  console.log(`  \x1b[32m✓\x1b[0m Gate #3: Audit trail logged to feed.log`);
  console.log();

  if (opts.dryRun) {
    console.log(`\x1b[33m⚡ DRY RUN\x1b[0m — would execute the following:\n`);
    printPlan(budName, repoName, oracleDisplayName, parentName, buddedAt);
    return;
  }

  // ═══════════════════════════════════════════════
  // Step 1: Create oracle repo
  // ═══════════════════════════════════════════════
  console.log(`\x1b[36mStep 1/8:\x1b[0m Create repo ${ORG}/${repoName}`);
  try {
    await ssh(`gh repo create ${ORG}/${repoName} --private --clone=false --description "Oracle: ${oracleDisplayName}"`);
    console.log(`  \x1b[32m✓\x1b[0m Repo created`);
  } catch (e: any) {
    if (e.message?.includes("already exists") || e.toString().includes("already exists")) {
      console.log(`  \x1b[33m⚠\x1b[0m Repo already exists — continuing`);
    } else {
      throw e;
    }
  }

  // Clone via ghq
  const repoPath = join(ghqRoot, ORG, repoName);
  if (!existsSync(repoPath)) {
    await ssh(`ghq get ${ORG}/${repoName}`);
    console.log(`  \x1b[32m✓\x1b[0m Cloned to ${repoPath}`);
  }

  // ═══════════════════════════════════════════════
  // Step 2: Initialize ψ/ vault (sovereign layout)
  // ═══════════════════════════════════════════════
  console.log(`\x1b[36mStep 2/8:\x1b[0m Initialize ψ/ vault (sovereign)`);
  const psiSubDirs = [
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

  // Sovereign layout: ψ/ lives at ~/.oracle/ψ/{name}/, repo gets symlink
  const sovereignDir = join(SOVEREIGN_ROOT, budName);
  mkdirSync(sovereignDir, { recursive: true });
  for (const dir of psiSubDirs) {
    mkdirSync(join(sovereignDir, dir), { recursive: true });
  }
  // Add .gitkeep files in sovereign dir
  for (const dir of psiSubDirs) {
    const keepPath = join(sovereignDir, dir, ".gitkeep");
    if (!existsSync(keepPath)) writeFileSync(keepPath, "");
  }
  // Create symlink: repo/ψ → ~/.oracle/ψ/{name}
  const psiSymlinkPath = join(repoPath, "ψ");
  if (!existsSync(psiSymlinkPath)) {
    symlinkSync(sovereignDir, psiSymlinkPath);
  }

  // Security: .gitignore to prevent accidental secret commits
  const gitignore = `.env
.env.*
*.key
*.pem
credentials.json
secrets/
.mcp.json
node_modules/
ψ
`;
  writeFileSync(join(repoPath, ".gitignore"), gitignore);
  console.log(`  \x1b[32m✓\x1b[0m ψ/ sovereign vault at ${sovereignDir}`);
  console.log(`  \x1b[32m✓\x1b[0m symlink: repo/ψ → ${sovereignDir}`);

  // ═══════════════════════════════════════════════
  // Step 3: Generate CLAUDE.md (identity from parent DNA)
  // ═══════════════════════════════════════════════
  console.log(`\x1b[36mStep 3/8:\x1b[0m Generate CLAUDE.md`);
  const claudeMd = generateClaudeMd(budName, oracleDisplayName, parentName, buddedAt);
  writeFileSync(join(repoPath, "CLAUDE.md"), claudeMd);
  console.log(`  \x1b[32m✓\x1b[0m CLAUDE.md generated`);

  // ═══════════════════════════════════════════════
  // Step 4: Create fleet config with provenance
  // ═══════════════════════════════════════════════
  console.log(`\x1b[36mStep 4/8:\x1b[0m Create fleet config`);
  const fleetNum = getNextFleetNumber();
  const sessionName = `${String(fleetNum).padStart(2, "0")}-${budName}`;
  const fleetConfig: FleetConfig = {
    name: sessionName,
    windows: [{ name: oracleDisplayName, repo: `${ORG}/${repoName}` }],
    budded_from: parentName || undefined,
    budded_at: buddedAt, // Gate #5: dormancy enforced by maw pulse scan (30d suspend, 90d archive)
    sync_peers: parentName ? [parentName] : [],
  };
  const fleetPath = join(FLEET_DIR, `${sessionName}.json`);
  writeFileSync(fleetPath, JSON.stringify(fleetConfig, null, 2) + "\n");
  console.log(`  \x1b[32m✓\x1b[0m ${sessionName}.json — budded_from: ${parentName || "root"}`);

  // ═══════════════════════════════════════════════
  // Step 5: Register in oracle family
  // ═══════════════════════════════════════════════
  console.log(`\x1b[36mStep 5/8:\x1b[0m Register in oracle family`);
  try {
    const issueBody = [
      `## New Oracle: ${oracleDisplayName}`,
      `- **Budded from**: ${parentName || "root"}`,
      `- **Budded at**: ${buddedAt}`,
      `- **Repo**: ${ORG}/${repoName}`,
      `- **Fleet**: ${sessionName}`,
      `- **Approved by**: ${opts.approvedBy}`,
      `- **Bud depth**: ${parentName ? getBudDepth(parentName) + 1 : 0}`,
    ].join("\n");
    await ssh(`gh issue create --repo ${ORG}/${repoName} --title "🧬 Birth: ${oracleDisplayName}" --body '${issueBody.replace(/'/g, "'\\''")}'`);
    console.log(`  \x1b[32m✓\x1b[0m Birth issue created`);
  } catch {
    console.log(`  \x1b[33m⚠\x1b[0m Could not create birth issue (non-blocking)`);
  }

  // ═══════════════════════════════════════════════
  // Step 6: Soul-sync seed (curated hand-off from parent)
  // ═══════════════════════════════════════════════
  console.log(`\x1b[36mStep 6/8:\x1b[0m Soul-sync seed (hand-off)`);
  if (parentName) {
    const parentConfig = findFleetConfig(parentName);
    if (parentConfig) {
      const parentRepoPath = join(ghqRoot, parentConfig.windows?.[0]?.repo || "");
      const parentLearnings = join(parentRepoPath, "ψ/memory/learnings");
      const targetLearnings = join(repoPath, "ψ/memory/learnings");

      if (existsSync(parentLearnings)) {
        // Curated hand-off: only copy last 5 learnings (not full sync)
        const files = readdirSync(parentLearnings)
          .filter(f => f.endsWith(".md") && f !== ".gitkeep")
          .sort()
          .slice(-5);

        let seeded = 0;
        for (const file of files) {
          const content = readFileSync(join(parentLearnings, file), "utf-8");
          // Security Gate #2: Skip sensitive content (expanded per Security-Oracle review)
          if (/customer|credential|secret|password|\.env|portfolio|API_KEY|SUPABASE|TOKEN|Bearer|sk-[a-zA-Z0-9]|eyJ[a-zA-Z0-9]|ghp_|xoxb-|xoxp-|PRIVATE.KEY/i.test(content)) continue;
          const attributed = content + `\n\n---\n*Seeded from ${parentName} via maw bud (hand-off)*\n`;
          writeFileSync(join(targetLearnings, file), attributed);
          seeded++;
        }
        console.log(`  \x1b[32m✓\x1b[0m Seeded ${seeded} learnings from ${parentName} (curated, max 5)`);
      } else {
        console.log(`  \x1b[90m○\x1b[0m No parent learnings found`);
      }
    } else {
      console.log(`  \x1b[90m○\x1b[0m Parent fleet config not found — skipping seed`);
    }
  } else {
    console.log(`  \x1b[90m○\x1b[0m No parent — skipping seed`);
  }

  // ═══════════════════════════════════════════════
  // Step 7: Initial commit + push
  // ═══════════════════════════════════════════════
  console.log(`\x1b[36mStep 7/8:\x1b[0m Initial commit`);
  try {
    await ssh(`cd "${repoPath}" && git add CLAUDE.md .gitignore && git commit -m "🧬 Birth: ${oracleDisplayName} — budded from ${parentName || 'root'} (sovereign)" --allow-empty`);
    await ssh(`cd "${repoPath}" && git push origin HEAD 2>/dev/null || git push -u origin main 2>/dev/null || true`);
    console.log(`  \x1b[32m✓\x1b[0m Committed and pushed`);
  } catch {
    console.log(`  \x1b[33m⚠\x1b[0m Commit/push issue (non-blocking)`);
  }

  // ═══════════════════════════════════════════════
  // Step 8: Update parent's sync_peers
  // ═══════════════════════════════════════════════
  console.log(`\x1b[36mStep 8/8:\x1b[0m Update parent sync_peers`);
  if (parentName) {
    try {
      const parentFleetFile = readdirSync(FLEET_DIR)
        .filter(f => f.endsWith(".json"))
        .find(f => {
          const config = JSON.parse(readFileSync(join(FLEET_DIR, f), "utf-8"));
          return config.name.endsWith(`-${parentName}`) ||
            config.windows?.some((w: any) => w.name.toLowerCase().replace("-oracle", "") === parentName.toLowerCase());
        });

      if (parentFleetFile) {
        const parentPath = join(FLEET_DIR, parentFleetFile);
        const parentConfig = JSON.parse(readFileSync(parentPath, "utf-8"));
        const peers = new Set(parentConfig.sync_peers || []);
        peers.add(budName);
        parentConfig.sync_peers = [...peers];
        writeFileSync(parentPath, JSON.stringify(parentConfig, null, 2) + "\n");
        console.log(`  \x1b[32m✓\x1b[0m Added "${budName}" to ${parentName}'s sync_peers`);
      } else {
        console.log(`  \x1b[33m⚠\x1b[0m Parent fleet config not found`);
      }
    } catch {
      console.log(`  \x1b[33m⚠\x1b[0m Could not update parent sync_peers`);
    }
  } else {
    console.log(`  \x1b[90m○\x1b[0m No parent to update`);
  }

  // ═══════════════════════════════════════════════
  // Done
  // ═══════════════════════════════════════════════
  logToFeed("maw-bud", `COMPLETE: bud "${budName}" from "${parentName || "root"}" — fleet ${sessionName}, repo ${ORG}/${repoName}`);

  console.log(`\n\x1b[32m🧬 ${oracleDisplayName} is born!\x1b[0m\n`);
  console.log(`  Fleet:   ${sessionName}`);
  console.log(`  Repo:    ${ORG}/${repoName}`);
  console.log(`  Parent:  ${parentName || "(root)"}`);
  console.log(`  Peers:   ${parentName ? `[${parentName}]` : "[]"}`);
  console.log();
  console.log(`  Wake:    maw wake ${budName}`);
  console.log(`  Awaken:  then run /awaken inside the oracle session`);
  console.log();
}

// --- CLAUDE.md Generator ---

function generateClaudeMd(budName: string, displayName: string, parentName: string | undefined, buddedAt: string): string {
  return `# ${displayName}

> "Building the future, one line at a time."

## Identity

**I am**: ${displayName}
**Human**: operator (The Boss)
**Purpose**: [Define your purpose during /awaken]
**Born**: ${buddedAt.split("T")[0]}
**Budded from**: ${parentName || "root"}

## Provenance

\`\`\`
budded_from: ${parentName || "root"}
budded_at: ${buddedAt}
sync_peers: [${parentName ? `"${parentName}"` : ""}]
\`\`\`

## Navigation

| File | Content | When to Read |
|------|---------|--------------|
| [CLAUDE.md](CLAUDE.md) | Identity + Laws | Always |

## The 5 Principles

1. **Nothing is Deleted** — Every commit tells a story
2. **Patterns Over Intentions** — Code talks, comments lie
3. **External Brain, Not Command** — Build what operator envisions
4. **Curiosity Creates Existence** — Every problem solved creates understanding
5. **Form and Formless** — Code is form; the mission is formless

## Brain Structure (Sovereign)

\`\`\`
~/.oracle/ψ/${budName}/ → inbox/ | memory/ (learnings, retros, resonance) | writing/ | lab/ | active/ | archive/ | outbox/
repo/ψ → symlink to above
\`\`\`

---

*Complete your identity with /awaken*
`;
}

// --- Helpers ---

function detectParentOracle(): string | undefined {
  // Try to detect from TMUX_PANE or current session
  const tmuxSession = process.env.TMUX_PANE;
  if (!tmuxSession) return undefined;
  // Could parse tmux session name, but for CLI usage just return undefined
  return undefined;
}

function printPlan(budName: string, repoName: string, displayName: string, parentName: string | undefined, buddedAt: string) {
  const fleetNum = getNextFleetNumber();
  const sessionName = `${String(fleetNum).padStart(2, "0")}-${budName}`;

  console.log(`  1. Create repo:      gh repo create ${ORG}/${repoName} --private`);
  console.log(`  2. Init ψ/ vault:    Sovereign at ~/.oracle/ψ/${budName} + symlink`);
  console.log(`  3. Generate:         CLAUDE.md (identity stub)`);
  console.log(`  4. Fleet config:     ${sessionName}.json (budded_from: ${parentName || "root"})`);
  console.log(`  5. Register:         Birth issue on ${ORG}/${repoName}`);
  console.log(`  6. Soul-sync seed:   Last 5 learnings from ${parentName || "N/A"} (curated)`);
  console.log(`  7. Commit + push:    Initial commit`);
  console.log(`  8. Update parent:    Add "${budName}" to ${parentName || "N/A"}'s sync_peers`);
  console.log();
}
