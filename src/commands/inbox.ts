import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "../config";

function resolveInboxDir(): string {
  const config = loadConfig();
  if (config.psiPath) return join(config.psiPath, "inbox");
  const local = join(process.cwd(), "ψ", "inbox");
  if (existsSync(local)) return local;
  return join(process.cwd(), "psi", "inbox");
}

interface InboxItem { type: string; name: string; path: string; mtime: Date; date: string; }

function scanItems(dir: string): InboxItem[] {
  if (!existsSync(dir)) return [];
  const items: InboxItem[] = [];
  function scan(d: string, type: string) {
    try {
      for (const f of readdirSync(d)) {
        if (!f.endsWith(".md")) continue;
        const p = join(d, f);
        const st = statSync(p);
        items.push({
          type, path: p, mtime: st.mtime,
          name: f.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_/, ""),
          date: st.mtime.toISOString().slice(0, 10) + " " + st.mtime.toTimeString().slice(0, 5),
        });
      }
    } catch { /* expected: subdirectory may not be readable */ }
  }
  scan(dir, "message");
  try {
    for (const sub of readdirSync(dir)) {
      const sp = join(dir, sub);
      if (statSync(sp).isDirectory()) scan(sp, sub);
    }
  } catch { /* expected: directory may not exist */ }
  return items.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export async function cmdInboxLs() {
  const items = scanItems(resolveInboxDir());
  if (!items.length) { console.log("\x1b[90mno inbox items\x1b[0m"); return; }
  const top = items.slice(0, 10);
  console.log(`\n\x1b[36mINBOX\x1b[0m (${items.length} total, showing ${top.length}):\n`);
  top.forEach((item, i) => {
    const c = item.type === "handoff" ? "\x1b[35m" : item.type === "ideas" ? "\x1b[33m" : "\x1b[90m";
    console.log(`  ${i + 1}. ${c}[${item.type}]\x1b[0m ${item.date}  ${item.name}`);
  });
  console.log();
}

export async function cmdInboxRead(target?: string) {
  const items = scanItems(resolveInboxDir());
  if (!items.length) { console.log("\x1b[90mno inbox items\x1b[0m"); return; }
  const n = target ? parseInt(target) : NaN;
  const item = !target ? items[0]
    : !isNaN(n) ? items[n - 1]
    : items.find(i => i.name.toLowerCase().includes(target.toLowerCase()));
  if (!item) { console.error(`\x1b[31merror\x1b[0m: not found: ${target}`); return; }
  console.log(`\n\x1b[36m${item.name}\x1b[0m  \x1b[90m[${item.type}] ${item.date}\x1b[0m\n`);
  console.log(readFileSync(item.path, "utf-8"));
}

export async function cmdInboxWrite(note: string) {
  const dir = resolveInboxDir();
  if (!existsSync(dir)) { console.error(`\x1b[31merror\x1b[0m: inbox not found: ${dir}`); return; }
  const slug = note.split(/\s+/).slice(0, 5).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const now = new Date();
  const ts = now.toISOString().slice(0, 10) + "_" + now.toTimeString().slice(0, 5).replace(":", "-");
  const filename = `${ts}_${slug}.md`;
  writeFileSync(join(dir, filename), `# Note\n\n${note}\n\n_${now.toISOString()}_\n`);
  console.log(`\x1b[32m✓\x1b[0m wrote \x1b[33m${filename}\x1b[0m`);
}
