import { cmdSend } from "./comm";
import { ssh } from "../ssh";
import { writeFeedNotification } from "../autopilot";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

/**
 * maw dispatch <oracle> <message> --ticket #N [--project slug]
 * One command, full 5-step dispatch compliance:
 *   1. cc Pulse with dispatch info
 *   2. maw hey <oracle> with message
 *   3. /talk-to <oracle> via thread (audit trail)
 *   4. maw task log #N "Assigned: <oracle>"
 *   5. cc BoB with summary
 */
export async function cmdDispatch(oracle: string, message: string, opts: { ticket?: string; project?: string }) {
  if (!oracle || !message) {
    console.error("usage: maw dispatch <oracle> <message> --ticket #N [--project slug]");
    console.error("  Runs the full 5-step dispatch: pulse + hey + thread + task log + cc bob");
    process.exit(1);
  }

  const ticket = opts.ticket?.replace("#", "") || "";
  const project = opts.project || "office";

  if (!ticket) {
    console.error("\x1b[31m✗\x1b[0m --ticket #N required. Create one first:");
    console.error("  gh issue create --repo YourOrg/<repo> --title \"...\"");
    process.exit(1);
  }

  const sender = inferSender();
  const prefix = `[${project}] #${ticket}`;

  console.log(`\x1b[36m⚡\x1b[0m Dispatching to ${oracle} — ${prefix}`);
  console.log();

  // Step 1: cc Pulse
  try {
    await cmdSend("pulse", `TASK: ${prefix} — assigned: ${oracle} — ${message.slice(0, 80)}`);
    console.log("  \x1b[32m✓\x1b[0m Step 1: cc Pulse");
  } catch (e: any) {
    console.log(`  \x1b[33m●\x1b[0m Step 1: cc Pulse failed (${e.message})`);
  }

  // Step 2: maw hey <oracle>
  try {
    await cmdSend(oracle, `${prefix} — ${message}`);
    console.log(`  \x1b[32m✓\x1b[0m Step 2: maw hey ${oracle}`);
  } catch (e: any) {
    console.log(`  \x1b[33m●\x1b[0m Step 2: maw hey failed (${e.message})`);
  }

  // Step 3: Thread audit trail (via maw talk-to)
  try {
    const { cmdTalkTo } = await import("./talk-to");
    await cmdTalkTo(oracle, `${prefix} — ${message}`, false);
    console.log(`  \x1b[32m✓\x1b[0m Step 3: /talk-to ${oracle} (thread)`);
  } catch (e: any) {
    console.log(`  \x1b[33m●\x1b[0m Step 3: thread failed (${e.message})`);
  }

  // Step 4: maw task log
  try {
    await ssh(`maw task log '#${ticket}' "Assigned: ${oracle} — ${message.slice(0, 60)}"`);
    console.log(`  \x1b[32m✓\x1b[0m Step 4: maw task log #${ticket}`);
  } catch (e: any) {
    console.log(`  \x1b[33m●\x1b[0m Step 4: task log failed (${e.message})`);
  }

  // Step 5: cc BoB
  try {
    await cmdSend("bob", `cc: ${prefix} — dispatched to ${oracle}: ${message.slice(0, 80)}`);
    console.log(`  \x1b[32m✓\x1b[0m Step 5: cc BoB`);
  } catch (e: any) {
    console.log(`  \x1b[33m●\x1b[0m Step 5: cc BoB failed (${e.message})`);
  }

  // Feed log
  writeFeedNotification(sender, `[dispatch] ${prefix} → ${oracle}: ${message.slice(0, 100)}`);

  console.log(`\n\x1b[32m✅\x1b[0m Dispatch complete — ${oracle} has ${prefix}`);
}

function inferSender(): string {
  try {
    const m = process.cwd().match(/([^/]+)-[Oo]racle/);
    return m ? m[1] : "BoB";
  } catch { return "BoB"; }
}
