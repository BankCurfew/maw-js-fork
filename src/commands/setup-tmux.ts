import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ─────────────────────────────────────────────────────────────
// maw setup tmux — idempotent scroll-fix installer for ~/.tmux.conf
//
// Bakes a canonical managed block (delimited by markers) into the user's
// tmux config so mouse-wheel scrollback survives tmux output (fixes the
// "auto-scroll to bottom eats my backscroll" UX bug).
//
// The block is installed between two sentinel lines:
//   # === maw:tmux-scroll-fix (managed — do not edit between markers) ===
//   ...
//   # === /maw:tmux-scroll-fix ===
//
// Re-running is safe: markers found → replace block in place. If the user
// has duplicated the markers by hand, we bail with a clear error rather
// than trying to heal — the user needs to clean up first.
// ─────────────────────────────────────────────────────────────

export const TMUX_MARKER_START =
  "# === maw:tmux-scroll-fix (managed — do not edit between markers) ===";
export const TMUX_MARKER_END = "# === /maw:tmux-scroll-fix ===";

/** Canonical scroll-fix block (between-markers content, markers included). */
export const TMUX_SCROLL_FIX_BLOCK = [
  TMUX_MARKER_START,
  "set-option -g history-limit 100000",
  "set-option -g mouse on",
  "set-window-option -g alternate-screen off",
  "set-window-option -g mode-keys vi",
  'bind -T root WheelUpPane   if-shell -F -t = "#{mouse_any_flag}" "send-keys -M" "if-shell -F -t = \'#{pane_in_mode}\' \'send-keys -M\' \'copy-mode -e ; send-keys -M\'"',
  'bind -T root WheelDownPane if-shell -F -t = "#{mouse_any_flag}" "send-keys -M" "send-keys -M"',
  "bind-key -T copy-mode-vi q send-keys -X cancel",
  "bind-key -T copy-mode-vi Escape send-keys -X cancel",
  'bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "xclip -selection clipboard 2>/dev/null || cat > /tmp/.tmux-clipboard"',
  'bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "xclip -selection clipboard 2>/dev/null || cat > /tmp/.tmux-clipboard"',
  TMUX_MARKER_END,
].join("\n");

export interface SetupTmuxOptions {
  force?: boolean; // currently unused — kept for parity with setup-hooks
  dryRun?: boolean;
}

export interface SetupTmuxResult {
  path: string;
  action: "created" | "updated" | "unchanged" | "dry-run";
}

/**
 * Core library entry. Pure (apart from the I/O it needs to do).
 *
 * @param homeDir override the home directory (tests pass a tmpdir)
 */
export function setupTmux(
  homeDir?: string,
  opts: SetupTmuxOptions = {},
): SetupTmuxResult {
  const home = homeDir || process.env.HOME;
  if (!home) throw new Error("HOME env var not set — cannot locate ~/.tmux.conf");
  const confPath = join(home, ".tmux.conf");

  // Case 1: file doesn't exist — write block standalone
  if (!existsSync(confPath)) {
    if (opts.dryRun) return { path: confPath, action: "dry-run" };
    writeFileSync(confPath, TMUX_SCROLL_FIX_BLOCK + "\n");
    return { path: confPath, action: "created" };
  }

  // Case 2: file exists — inspect for markers
  const current = readFileSync(confPath, "utf-8");

  const startCount = countOccurrences(current, TMUX_MARKER_START);
  const endCount = countOccurrences(current, TMUX_MARKER_END);

  if (startCount > 1 || endCount > 1) {
    throw new Error(
      `duplicate maw:tmux-scroll-fix markers found in ${confPath} ` +
        `(start=${startCount}, end=${endCount}) — please remove extras by hand before re-running`,
    );
  }
  if (startCount !== endCount) {
    throw new Error(
      `unbalanced maw:tmux-scroll-fix markers in ${confPath} ` +
        `(start=${startCount}, end=${endCount}) — please fix manually`,
    );
  }

  let next: string;
  if (startCount === 0) {
    // No existing block — append (separate with blank line if file has content)
    const sep = current.length === 0 || current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    next = current + sep + TMUX_SCROLL_FIX_BLOCK + "\n";
  } else {
    // Replace everything between the markers (inclusive)
    const startIdx = current.indexOf(TMUX_MARKER_START);
    const endIdx = current.indexOf(TMUX_MARKER_END) + TMUX_MARKER_END.length;
    next = current.slice(0, startIdx) + TMUX_SCROLL_FIX_BLOCK + current.slice(endIdx);
  }

  if (next === current) {
    return { path: confPath, action: "unchanged" };
  }
  if (opts.dryRun) {
    return { path: confPath, action: "dry-run" };
  }
  writeFileSync(confPath, next);
  return { path: confPath, action: startCount === 0 ? "updated" : "updated" };
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

/** Best-effort `tmux source-file ~/.tmux.conf` — silent on any failure. */
async function reloadTmux(confPath: string): Promise<boolean> {
  try {
    // Bun-native spawn; falls back to nothing if tmux is missing or no server.
    const proc = Bun.spawn(["tmux", "source-file", confPath], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// CLI entry: `maw setup tmux [--dry-run] [--force]`
// ─────────────────────────────────────────────────────────────
export async function cmdSetupTmux(argv: string[]): Promise<void> {
  const opts: SetupTmuxOptions = {};
  for (const a of argv) {
    if (a === "--force") opts.force = true;
    else if (a === "--dry-run") opts.dryRun = true;
  }

  const r = setupTmux(undefined, opts);
  const dim = "\x1b[2m",
    reset = "\x1b[0m",
    green = "\x1b[32m",
    cyan = "\x1b[36m";

  console.log("");
  console.log(`  ${cyan}maw setup tmux${reset}`);
  console.log(`  ${dim}target:${reset} ${r.path}`);
  switch (r.action) {
    case "created":
      console.log(`  ${green}✓ created${reset} ~/.tmux.conf with scroll-fix block`);
      break;
    case "updated":
      console.log(`  ${green}✓ updated${reset} scroll-fix block in ~/.tmux.conf`);
      break;
    case "unchanged":
      console.log(`  ${dim}unchanged${reset} — scroll-fix block already current`);
      break;
    case "dry-run":
      console.log(`  ${dim}dry-run${reset} — no changes written`);
      break;
  }

  if (r.action === "created" || r.action === "updated") {
    const reloaded = await reloadTmux(r.path);
    if (reloaded) {
      console.log(`  ${green}✓${reset} ${dim}reloaded running tmux server${reset}`);
    } else {
      console.log(
        `  ${dim}(tmux source-file skipped — no running server or tmux not installed)${reset}`,
      );
    }
  }
  console.log("");
}
