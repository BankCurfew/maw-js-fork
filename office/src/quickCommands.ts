/**
 * Shared quick command definitions for all terminal views.
 * Priority order per operator's workflow: y > n > Esc > Enter > ↑ > ↓ > Ctrl+C > /recap > Wake > Sleep > ⇧Tab > Tab > /help > Restart
 */

export interface QuickCommand {
  label: string;
  text: string;
  color: string;
  /** If true, only show when agent control (send ws message) is available */
  needsControl?: boolean;
  /** If true, requires confirm() before executing */
  confirm?: boolean;
  /** Action type for ws commands (wake/sleep/restart) — if set, text is ignored */
  action?: "wake" | "sleep" | "restart";
}

/** Core terminal commands — shown in all views */
export const CORE_COMMANDS: QuickCommand[] = [
  { label: "y", text: "y\r", color: "#22C55E" },
  { label: "n", text: "n\r", color: "#ef5350" },
  { label: "Esc", text: "\x1b", color: "#64748B" },
  { label: "Enter", text: "\r", color: "#64748B" },
  { label: "↑", text: "\x1b[A", color: "#64748B" },
  { label: "↓", text: "\x1b[B", color: "#64748B" },
  { label: "Ctrl+C", text: "\x03", color: "#ef5350" },
];

/** Extended commands — shown in views with more space */
export const EXTENDED_COMMANDS: QuickCommand[] = [
  { label: "/save", text: "/save\r", color: "#22C55E" },
  { label: "/clear", text: "/clear\r", color: "#64748B" },
  { label: "/recap", text: "/recap\r", color: "#fbbf24" },
];

/** Agent control commands — only shown when send() is available */
export const CONTROL_COMMANDS: QuickCommand[] = [
  { label: "Wake", text: "", color: "#4caf50", needsControl: true, action: "wake" },
  { label: "Sleep", text: "", color: "#888", needsControl: true, action: "sleep" },
  { label: "Restart", text: "", color: "#ff9800", needsControl: true, action: "restart", confirm: true },
];

/** Full set for iPad/mobile views — core + extended + control */
export const FULL_COMMANDS: QuickCommand[] = [...CORE_COMMANDS, ...EXTENDED_COMMANDS, ...CONTROL_COMMANDS];

/** Terminal-only set — core + tab (no agent control, no slash commands) */
export const TERMINAL_COMMANDS: QuickCommand[] = [...CORE_COMMANDS, { label: "⇧Tab", text: "\x1b[Z", color: "#a78bfa" }, { label: "Tab", text: "\t", color: "#a78bfa" }];
