import { sendKeys, getPaneCommand, capture } from "../ssh";
import { detectSession } from "./wake";
import { tmux } from "../tmux";

const ORACLE_REPOS: Record<string, string> = {
  dev: "YourOrg/Dev-Oracle",
  qa: "YourOrg/QA-Oracle",
  designer: "YourOrg/Designer-Oracle",
  researcher: "YourOrg/Researcher-Oracle",
  writer: "YourOrg/Writer-Oracle",
  hr: "YourOrg/HR-Oracle",
};

const THINK_PROMPTS: Record<string, string> = {
  dev: `Scan your recent work: git log -20, open issues, codebase state. As Dev-Oracle, propose ONE improvement or new initiative that would help BoB's Office. Think about: technical debt, missing features, performance, developer experience, architecture improvements. Create a GitHub issue in your repo with label "proposal" — title: clear action, body: what + why + estimated effort. Use: gh issue create --label proposal --title "..." --body "..."`,

  qa: `Scan your recent work: git log -20, open issues, test coverage. As QA-Oracle, propose ONE improvement. Think about: missing test coverage, quality gaps, process improvements, automation opportunities, testing infrastructure. Create a GitHub issue with label "proposal". Use: gh issue create --label proposal --title "..." --body "..."`,

  designer: `Scan your recent work: git log -20, open issues, design system state. As Designer-Oracle, propose ONE improvement. Think about: UX gaps, design system components needed, accessibility improvements, visual consistency, user research needs. Create a GitHub issue with label "proposal". Use: gh issue create --label proposal --title "..."  --body "..."`,

  researcher: `Scan your recent work: git log -20, open issues, research outputs. As Researcher-Oracle, propose ONE research initiative. Think about: competitor moves, technology trends, market gaps, benchmarking needs, knowledge gaps in the team. Create a GitHub issue with label "proposal". Use: gh issue create --label proposal --title "..." --body "..."`,

  writer: `Scan your recent work: git log -20, open issues, content state. As Writer-Oracle, propose ONE content initiative. Think about: documentation gaps, blog post ideas, style guide updates, content that would attract users, internal docs that need updating. Create a GitHub issue with label "proposal". Use: gh issue create --label proposal --title "..." --body "..."`,

  hr: `Scan your recent work: git log -20, open issues, team state. As HR-Oracle, propose ONE organizational improvement. Think about: team gaps, new oracle roles needed, onboarding improvements, skill development, cross-team collaboration, process inefficiencies. Create a GitHub issue with label "proposal". Use: gh issue create --label proposal --title "..." --body "..."`,
};

export interface ThinkOpts {
  oracles?: string[];
  dryRun?: boolean;
}

async function resolveTarget(oracle: string): Promise<{ target: string; status: string } | null> {
  const session = await detectSession(oracle);
  if (!session) return null;

  let windowName = `${oracle}-oracle`;
  try {
    const windows = await tmux.listWindows(session);
    const match = windows.find(w =>
      w.name.toLowerCase() === windowName.toLowerCase() ||
      w.name.toLowerCase() === `${oracle.charAt(0).toUpperCase() + oracle.slice(1)}-Oracle`.toLowerCase()
    );
    if (match) windowName = match.name;
  } catch {}

  const target = `${session}:${windowName}`;
  try {
    const cmd = await getPaneCommand(target);
    if (/claude|node/i.test(cmd)) return { target, status: "ready" };
  } catch {}

  return null;
}

export async function cmdThink(opts: ThinkOpts = {}) {
  const oracles = opts.oracles || Object.keys(ORACLE_REPOS);

  console.log(`\n  \x1b[36mBoB's Office — Think Time\x1b[0m`);
  console.log(`  Asking ${oracles.length} oracles to scan and propose ideas\n`);

  // Ensure proposal label exists in each repo
  for (const oracle of oracles) {
    const repo = ORACLE_REPOS[oracle];
    if (!repo) continue;
    try {
      const { ssh } = await import("../ssh");
      await ssh(`gh label create proposal --repo ${repo} --color 0e8a16 --description "Oracle initiative proposal" --force 2>/dev/null`);
    } catch {}
  }

  if (opts.dryRun) {
    for (const oracle of oracles) {
      console.log(`  \x1b[90m○\x1b[0m ${oracle} — would be asked to think`);
    }
    console.log(`\n  \x1b[90m(dry run — no messages sent)\x1b[0m\n`);
    return;
  }

  // Send think prompt to each oracle in parallel
  const results = await Promise.allSettled(
    oracles.map(async (oracle) => {
      const resolved = await resolveTarget(oracle);
      if (!resolved) {
        console.log(`  \x1b[31m✗\x1b[0m ${oracle} — no active session`);
        return;
      }

      const prompt = THINK_PROMPTS[oracle];
      if (!prompt) return;

      console.log(`  \x1b[36m>>>\x1b[0m ${oracle} — thinking...`);
      await sendKeys(resolved.target, prompt);
      console.log(`  \x1b[32m✓\x1b[0m ${oracle} — prompt sent`);
    })
  );

  console.log(`\n  \x1b[32mDone.\x1b[0m Oracles are scanning and creating proposal issues.`);
  console.log(`  Run \x1b[36mmaw review\x1b[0m to have BoB evaluate proposals.\n`);
}

// --- Review: BoB scans all proposal issues and forwards good ones to inbox ---

export async function cmdReview() {
  const { ssh } = await import("../ssh");

  console.log(`\n  \x1b[36mBoB's Office — Proposal Review\x1b[0m`);
  console.log(`  Scanning all oracle repos for proposals...\n`);

  const proposals: { oracle: string; repo: string; number: number; title: string; body: string; url: string }[] = [];

  for (const [oracle, repo] of Object.entries(ORACLE_REPOS)) {
    try {
      const json = await ssh(`gh issue list --repo ${repo} --label proposal --state open --json number,title,body,url --limit 10`);
      const issues = JSON.parse(json);
      for (const issue of issues) {
        proposals.push({
          oracle,
          repo,
          number: issue.number,
          title: issue.title,
          body: (issue.body || "").slice(0, 500),
          url: issue.url,
        });
        console.log(`  \x1b[33m●\x1b[0m ${oracle} #${issue.number}: ${issue.title}`);
      }
    } catch {
      // No proposals or repo error
    }
  }

  if (proposals.length === 0) {
    console.log(`  \x1b[90mNo open proposals found.\x1b[0m`);
    console.log(`  Run \x1b[36mmaw think\x1b[0m first to ask oracles for ideas.\n`);
    return;
  }

  console.log(`\n  Found \x1b[33m${proposals.length}\x1b[0m proposals.`);

  // Step 1: Write ALL proposals to feed.log immediately → inbox shows them with Approve/Reject
  writeProposalsToFeed(proposals);

  // Step 2: Also send to BoB so he can evaluate and add his opinion
  const bobResolved = await resolveTarget("bob");
  if (!bobResolved) {
    console.log(`  \x1b[33m!\x1b[0m BoB not available — proposals sent to inbox for operator to review directly.\n`);
    return;
  }

  const summary = proposals.map(p =>
    `[${p.oracle}] #${p.number}: ${p.title}\n${p.body.slice(0, 200)}...\n${p.url}`
  ).join("\n\n");

  const bobPrompt = [
    `${proposals.length} proposals from the team are now in operator's inbox for approval.`,
    `Review them and give your recommendation. For each: APPROVE or SKIP with reason.`,
    `If operator approves any, use maw hey to dispatch: maw hey <oracle> "Execute your proposal: <title>"`,
    ``,
    `Proposals:`,
    summary,
  ].join("\n");

  console.log(`  \x1b[36m>>>\x1b[0m BoB reviewing in background...`);
  await sendKeys(bobResolved.target, bobPrompt);
  console.log(`  \x1b[32m✓\x1b[0m Proposals in inbox + BoB reviewing.\n`);
}

function writeProposalsToFeed(proposals: { oracle: string; title: string; url: string; body: string }[]) {
  try {
    const { appendFileSync } = require("node:fs");
    const { join } = require("node:path");
    const FEED_LOG = join(process.env.HOME || "/home/curfew", ".oracle", "feed.log");
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;

    for (const p of proposals) {
      const data = JSON.stringify({ oracle: p.oracle, title: p.title, url: p.url, body: p.body.slice(0, 300) });
      const line = `${ts} | BoB-Oracle | VuttiServer | Notification | BoB-Oracle | autopilot \u00bb [proposal] ${data}\n`;
      appendFileSync(FEED_LOG, line);
    }
    console.log(`  \x1b[32m✓\x1b[0m ${proposals.length} proposals sent to inbox.\n`);
  } catch {}
}
