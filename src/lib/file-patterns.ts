/**
 * Shared FILE_RE / IMG_RE patterns and gate functions for CHIP file relay.
 * Single source of truth — import here, never copy to OracleSheet.tsx or comm.ts.
 */

import { realpathSync, statSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Matches local absolute paths to doc files (same as OracleSheet.tsx FILE_RE) */
export const FILE_RE = /(?:\/[\w.\-\/]+\.(?:html?|pdf|md|txt))/gi;

/** Matches local absolute paths and http URLs to image files (same as OracleSheet.tsx IMG_RE) */
export const IMG_RE = /(?:\/[\w.\-\/]+\.(?:png|jpe?g|webp|gif))|(?:https?:\/\/[^\s<&]+\.(?:png|jpe?g|webp|gif))/gi;

export const EXT_ALLOWLIST = new Set([
  "html", "htm", "pdf", "md", "txt",
  "png", "jpg", "jpeg", "webp", "gif",
]);

/** Maximum file size for relay (10 MB) */
export const MAX_RELAY_BYTES = 10 * 1024 * 1024;

/** Scan text for local chip paths (FILE_RE + IMG_RE, local only, no http) */
export function scanChipPaths(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(new RegExp(FILE_RE.source, "gi"))) found.add(m[0]);
  for (const m of text.matchAll(new RegExp(IMG_RE.source, "gi"))) {
    const p = m[0];
    if (p.startsWith("/")) found.add(p); // local only, skip http
  }
  return [...found];
}

/** Validate a sender-side path: must be in allowed roots, exist, ≤10MB. Returns realpath or null. */
export function gateSenderPath(filePath: string): string | null {
  let real: string;
  try {
    real = realpathSync(filePath);
  } catch {
    return null;
  }

  const ext = real.split(".").pop()?.toLowerCase() || "";
  if (!EXT_ALLOWLIST.has(ext)) return null;

  try {
    const st = statSync(real);
    if (!st.isFile() || st.size > MAX_RELAY_BYTES) return null;
  } catch {
    return null;
  }

  if (!isInAllowedRoot(real)) return null;
  return real;
}

function isInAllowedRoot(real: string): boolean {
  const home = homedir();
  const mawInbox = join(home, ".maw", "inbox");
  // ~/.maw/inbox/**
  if (real.startsWith(mawInbox + "/") || real === mawInbox) return true;
  // <any-repo>/output/**
  if (/\/output\//.test(real)) return true;
  // <any-repo>/ψ/writing/** (ψ may be a symlink — realpath already resolved)
  if (/\/writing\//.test(real) && /\/ψ\//.test(real)) return true;
  // <any-repo>/.playwright-cli/**
  if (/\/.playwright-cli\//.test(real)) return true;
  return false;
}
