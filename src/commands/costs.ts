import { loadConfig } from "../config";

export async function cmdCosts() {
  const config = loadConfig();
  const base = `http://${config.host}:${config.port}`;

  let data: any;
  try {
    const res = await fetch(`${base}/api/costs`);
    data = await res.json();
  } catch {
    console.error("\x1b[31merror\x1b[0m: cannot reach maw server — is `maw serve` running?");
    process.exit(1);
  }

  if (data.error) {
    console.error(`\x1b[31merror\x1b[0m: ${data.error}`);
    process.exit(1);
  }

  const { agents, total } = data;
  if (!agents.length) {
    console.log("\x1b[90mno session data found\x1b[0m");
    return;
  }

  console.log(`\n\x1b[36mCOST TRACKING\x1b[0m  (${total.agents} agents, ${total.sessions} sessions)\n`);

  // Table header
  const hdr = [
    "Agent".padEnd(30),
    "Tokens".padStart(14),
    "Est. Cost".padStart(12),
    "Sessions".padStart(10),
    "Turns".padStart(8),
    "Last Active".padStart(13),
  ].join("  ");
  console.log(`  \x1b[90m${hdr}\x1b[0m`);
  console.log(`  \x1b[90m${"─".repeat(hdr.length)}\x1b[0m`);

  for (const a of agents) {
    const name = a.name.length > 28 ? a.name.slice(0, 27) + "…" : a.name;
    const tokens = fmtNum(a.totalTokens).padStart(14);
    const cost = `$${a.estimatedCost.toFixed(2)}`.padStart(12);
    const sessions = String(a.sessions).padStart(10);
    const turns = String(a.turns).padStart(8);
    const lastActive = a.lastActive ? a.lastActive.slice(0, 10) : "—";

    const costColor = a.estimatedCost > 10 ? "\x1b[31m" : a.estimatedCost > 1 ? "\x1b[33m" : "\x1b[32m";
    console.log(`  ${name.padEnd(30)}  ${tokens}  ${costColor}${cost}\x1b[0m  ${sessions}  ${turns}  ${lastActive.padStart(13)}`);
  }

  console.log(`  \x1b[90m${"─".repeat(hdr.length)}\x1b[0m`);
  const totalCostColor = total.cost > 50 ? "\x1b[31m" : total.cost > 10 ? "\x1b[33m" : "\x1b[32m";
  console.log(`  ${"TOTAL".padEnd(30)}  ${fmtNum(total.tokens).padStart(14)}  ${totalCostColor}${"$" + total.cost.toFixed(2)}`.padStart(12) + `\x1b[0m  ${String(total.sessions).padStart(10)}`);
  console.log();
}

function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}
