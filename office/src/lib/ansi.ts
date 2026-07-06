// Soft modern terminal palette (inspired by Catppuccin Mocha)
const AC = [
  "#0a0a0f","#f38ba8","#a6e3a1","#f9e2af","#89b4fa","#cba6f7","#94e2d5","#cdd6f4",
  "#585b70","#f38ba8","#a6e3a1","#f9e2af","#89b4fa","#cba6f7","#94e2d5","#ffffff",
];

function a256(n: number): string {
  if (n < 16) return AC[n];
  if (n < 232) {
    n -= 16;
    return `rgb(${Math.floor(n / 36) * 51},${(Math.floor(n / 6) % 6) * 51},${(n % 6) * 51})`;
  }
  const v = (n - 232) * 10 + 8;
  return `rgb(${v},${v},${v})`;
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function ansiToHtml(text: string): string {
  let h = "", fg: string | null = null, bg: string | null = null;
  let b = 0, d = 0, i = 0, u = 0, s = 0, open = 0;

  for (const p of text.split(/(\x1b\[[0-9;]*m)/)) {
    const m = p.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) { h += esc(p); continue; }
    if (open) { h += "</span>"; open = 0; }
    const codes = m[1] ? m[1].split(";").map(Number) : [0];
    for (let j = 0; j < codes.length; j++) {
      const c = codes[j];
      if (!c) { fg = bg = null; b = d = i = u = s = 0; }
      else if (c === 1) b = 1; else if (c === 2) d = 1; else if (c === 3) i = 1;
      else if (c === 4) u = 1; else if (c === 9) s = 1;
      else if (c === 22) b = d = 0; else if (c === 23) i = 0;
      else if (c === 24) u = 0; else if (c === 29) s = 0;
      else if (c >= 30 && c <= 37) fg = AC[c - 30];
      else if (c === 38 && codes[j + 1] === 5) { fg = a256(codes[j + 2]); j += 2; }
      else if (c === 38 && codes[j + 1] === 2) { fg = `rgb(${codes[j + 2]},${codes[j + 3]},${codes[j + 4]})`; j += 4; }
      else if (c === 39) fg = null;
      else if (c >= 40 && c <= 47) bg = AC[c - 40];
      else if (c === 48 && codes[j + 1] === 5) { bg = a256(codes[j + 2]); j += 2; }
      else if (c === 48 && codes[j + 1] === 2) { bg = `rgb(${codes[j + 2]},${codes[j + 3]},${codes[j + 4]})`; j += 4; }
      else if (c === 49) bg = null;
      else if (c >= 90 && c <= 97) fg = AC[c - 82];
      else if (c >= 100 && c <= 107) bg = AC[c - 92];
    }
    const st: string[] = [];
    if (fg) st.push("color:" + fg);
    if (bg) st.push("background:" + bg);
    if (b) st.push("font-weight:bold");
    if (d) st.push("opacity:0.6");
    if (i) st.push("font-style:italic");
    if (u || s) st.push("text-decoration:" + (u ? "underline" : "") + (u && s ? " " : "") + (s ? "line-through" : ""));
    if (st.length) { h += `<span style="${st.join(";")}">`; open = 1; }
  }
  if (open) h += "</span>";
  return h;
}

/** Convert URLs in already-escaped HTML into clickable links (Ctrl+Click or plain click). */
export function linkifyHtml(html: string): string {
  return html.replace(
    /(https?:\/\/[^\s<>&"']+)/g,
    '<a href="$1" target="_blank" rel="noopener" style="color:#89b4fa;text-decoration:underline;cursor:pointer" onclick="event.stopPropagation()">$1</a>',
  );
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Filter startup noise from capture, keep everything else */
export function processCapture(raw: string): string {
  const shortened = raw.replace(/[─━═—\-_▁▔]{6,}/g, "─".repeat(60));
  const lines = shortened.split("\n");
  const filtered = lines.filter(line => {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (!plain) return true;
    if (/command -v direnv/.test(plain)) return false;
    if (/direnv allow|direnv export/.test(plain)) return false;
    if (/unset CLAUDECODE/.test(plain)) return false;
    if (/claude --dangerously-skip-permissions/.test(plain)) return false;
    if (/claude --resume\s+[0-9a-f-]{8,}/.test(plain)) return false;
    if (/^Resume this session with:?/.test(plain)) return false;
    // Wrapped continuation fragments from long startup commands
    if (/^nset CLAUDECODE|^ons --model|^de-opus|^v export zsh/.test(plain)) return false;
    if (/^\$?\s*cd\s+(~|\/).*\/(repos|github\.com)\//.test(plain)) return false;
    // Claude Code chrome (NOT 📡 status bar — that's kept below, last only)
    if (/bypass permissions on/.test(plain)) return false;
    if (/⏵⏵/.test(plain)) return false;
    if (/shift\+tab to cycle/.test(plain)) return false;
    if (/for agents$/.test(plain)) return false;
    // Processing/spinner lines
    if (/^[✻●✽⎿]\s*(Processing|Crunched|Baked|Sautéed|Galloping|Cogitated|Osmosing|Brewed|Cooked|Worked|Simmered|Marinated)/i.test(plain)) return false;
    if (/Processing[.,]\s*\(\d+/.test(plain)) return false;
    return true;
  });
  // Keep only the LAST 📡 status bar — strip stale ones stuck in scrollback
  let lastStatusIdx = -1;
  for (let j = filtered.length - 1; j >= 0; j--) {
    if (filtered[j].replace(/\x1b\[[0-9;]*m/g, "").includes("📡")) { lastStatusIdx = j; break; }
  }
  const final = filtered.filter((line, idx) => {
    if (idx === lastStatusIdx) return true;
    return !line.replace(/\x1b\[[0-9;]*m/g, "").includes("📡");
  });
  while (final.length > 0) {
    const stripped = final[final.length - 1].replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (stripped === "") final.pop();
    else break;
  }
  return final.join("\n");
}
