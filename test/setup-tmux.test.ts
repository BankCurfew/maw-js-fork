import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  setupTmux,
  TMUX_MARKER_START,
  TMUX_MARKER_END,
  TMUX_SCROLL_FIX_BLOCK,
} from "../src/commands/setup-tmux";

// Each test uses an isolated tmpdir as HOME.
let home: string;
let conf: string;

beforeEach(() => {
  home = join(tmpdir(), `maw-setup-tmux-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  conf = join(home, ".tmux.conf");
});

afterEach(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

describe("setupTmux", () => {
  test("creates ~/.tmux.conf with scroll-fix block when file is missing", () => {
    expect(existsSync(conf)).toBe(false);
    const r = setupTmux(home);
    expect(r.action).toBe("created");
    expect(r.path).toBe(conf);
    const written = readFileSync(conf, "utf-8");
    expect(written).toContain(TMUX_MARKER_START);
    expect(written).toContain(TMUX_MARKER_END);
    expect(written).toContain("set-option -g history-limit 100000");
    expect(written.endsWith("\n")).toBe(true);
  });

  test("appends block when file exists without markers", () => {
    const existing = "# user's existing config\nset -g status-bg black\n";
    writeFileSync(conf, existing);
    const r = setupTmux(home);
    expect(r.action).toBe("updated");
    const written = readFileSync(conf, "utf-8");
    // User's config is preserved verbatim at the top
    expect(written.startsWith(existing)).toBe(true);
    // Block is appended
    expect(written).toContain(TMUX_MARKER_START);
    expect(written).toContain(TMUX_MARKER_END);
  });

  test("idempotent: running twice produces identical file content", () => {
    writeFileSync(conf, "# user's config\nset -g status-bg black\n");
    setupTmux(home);
    const first = readFileSync(conf, "utf-8");
    const r2 = setupTmux(home);
    const second = readFileSync(conf, "utf-8");
    expect(second).toBe(first);
    // Second run: block already matches, so "unchanged"
    expect(r2.action).toBe("unchanged");
  });

  test("replaces existing managed block in place (does not duplicate)", () => {
    // Simulate an older/different managed block (e.g. without mouse line)
    const staleBlock = [
      TMUX_MARKER_START,
      "set-option -g history-limit 50000",
      TMUX_MARKER_END,
    ].join("\n");
    writeFileSync(conf, `# user top\n${staleBlock}\n# user bottom\n`);
    const r = setupTmux(home);
    expect(r.action).toBe("updated");
    const written = readFileSync(conf, "utf-8");

    // Exactly one start marker, one end marker
    const startMatches = written.match(new RegExp(escapeRegex(TMUX_MARKER_START), "g")) || [];
    const endMatches = written.match(new RegExp(escapeRegex(TMUX_MARKER_END), "g")) || [];
    expect(startMatches.length).toBe(1);
    expect(endMatches.length).toBe(1);

    // New block content present, stale content gone
    expect(written).toContain("set-option -g history-limit 100000");
    expect(written).not.toContain("set-option -g history-limit 50000");

    // User lines outside the block preserved
    expect(written).toContain("# user top");
    expect(written).toContain("# user bottom");
  });

  test("dry-run never writes the file", () => {
    const r = setupTmux(home, { dryRun: true });
    expect(r.action).toBe("dry-run");
    expect(existsSync(conf)).toBe(false);

    writeFileSync(conf, "# existing\n");
    const before = readFileSync(conf, "utf-8");
    const r2 = setupTmux(home, { dryRun: true });
    expect(r2.action).toBe("dry-run");
    expect(readFileSync(conf, "utf-8")).toBe(before);
  });

  test("fails fast when duplicate markers are present", () => {
    const dup =
      `${TMUX_MARKER_START}\nset-option -g history-limit 1\n${TMUX_MARKER_END}\n` +
      `${TMUX_MARKER_START}\nset-option -g history-limit 2\n${TMUX_MARKER_END}\n`;
    writeFileSync(conf, dup);
    expect(() => setupTmux(home)).toThrow(/duplicate.*markers/i);
  });

  test("fails fast when markers are unbalanced", () => {
    // start without end
    writeFileSync(conf, `${TMUX_MARKER_START}\nset-option -g history-limit 1\n`);
    expect(() => setupTmux(home)).toThrow(/unbalanced.*markers/i);
  });

  test("the installed block matches the canonical constant", () => {
    setupTmux(home);
    const written = readFileSync(conf, "utf-8");
    expect(written).toContain(TMUX_SCROLL_FIX_BLOCK);
  });

  test("respects HOME env var when homeDir arg is omitted", () => {
    const prev = process.env.HOME;
    try {
      process.env.HOME = home;
      const r = setupTmux();
      expect(r.path).toBe(conf);
      expect(r.action).toBe("created");
    } finally {
      if (prev !== undefined) process.env.HOME = prev;
    }
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
