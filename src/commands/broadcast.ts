import { tmux } from "../tmux";
import { sendKeys, getPaneCommand } from "../ssh";
import { writeFeedNotification } from "../autopilot";

function inferSender(): string {
  try {
    const cwd = process.cwd();
    const m = cwd.match(/([^/]+)-[Oo]racle/);
    return m ? m[1] : "unknown";
  } catch { return "unknown"; }
}

/**
 * maw broadcast <message> — send to ALL awake Claude windows.
 * Single cc to BoB (not per-oracle). Skips sender's own window.
 */
export async function cmdBroadcast(message: string) {
  if (!message) {
    console.error("usage: maw broadcast <message>");
    process.exit(1);
  }

  const sender = inferSender();
  const prefixed = `[BROADCAST from ${sender}] ${message}`;

  const sessions = await tmux.listAll();
  let sent = 0;
  let skipped = 0;
  const reached: string[] = [];

  for (const s of sessions) {
    if (s.name === "99-overview" || s.name === "scratch" || s.name.endsWith("-view")) continue;

    for (const w of s.windows) {
      // Skip sender's own window
      if (w.name.toLowerCase().includes(sender.toLowerCase())) { skipped++; continue; }

      const target = `${s.name}:${w.index}`;
      try {
        const cmd = await tmux.run("display-message", "-t", target, "-p", "#{pane_current_command}");
        if (!/claude|node/i.test(cmd.trim())) { skipped++; continue; }
        await tmux.sendText(target, prefixed);
        reached.push(w.name);
        sent++;
      } catch { skipped++; }
    }
  }

  // Single cc to BoB — not one per oracle
  writeFeedNotification(sender, `[broadcast] sent to ${sent} oracles: ${message.slice(0, 100)}`);
  console.log(`\n\x1b[32m✓\x1b[0m Broadcast to ${sent} oracles (${skipped} skipped)`);
  if (reached.length > 0) {
    console.log(`  Reached: ${reached.slice(0, 10).join(", ")}${reached.length > 10 ? ` +${reached.length - 10} more` : ""}`);
  }
}
