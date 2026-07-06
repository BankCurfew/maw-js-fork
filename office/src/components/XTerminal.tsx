import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { wsUrl } from "../lib/api";
import type { AgentState } from "../lib/types";

interface XTerminalProps {
  target: string;
  onClose: () => void;
  onNavigate: (dir: -1 | 1) => void;
  siblings: AgentState[];
  onSelectSibling: (agent: AgentState) => void;
}

// Catppuccin Mocha palette (matches AC array in ansi.ts)
const THEME = {
  background: "#0a0a0f",
  foreground: "#cdd6f4",
  cursor: "#22d3ee",
  cursorAccent: "#0a0a0f",
  selectionBackground: "#585b7066",
  black: "#0a0a0f",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#cba6f7",
  cyan: "#94e2d5",
  white: "#cdd6f4",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#cba6f7",
  brightCyan: "#94e2d5",
  brightWhite: "#ffffff",
};

export function XTerminal({ target, onClose, onNavigate, siblings, onSelectSibling }: XTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep callbacks in refs so terminal effect doesn't re-run on every render
  const onCloseRef = useRef(onClose);
  const onNavigateRef = useRef(onNavigate);
  const siblingsRef = useRef(siblings);
  const onSelectSiblingRef = useRef(onSelectSibling);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { onNavigateRef.current = onNavigate; }, [onNavigate]);
  useEffect(() => { siblingsRef.current = siblings; }, [siblings]);
  useEffect(() => { onSelectSiblingRef.current = onSelectSibling; }, [onSelectSibling]);

  // Lock body scroll while terminal is open
  useEffect(() => {
    const origOverflow = document.body.style.overflow;
    const origPosition = document.body.style.position;
    const origTop = document.body.style.top;
    const origWidth = document.body.style.width;
    const scrollY = window.scrollY;

    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";

    return () => {
      document.body.style.overflow = origOverflow;
      document.body.style.position = origPosition;
      document.body.style.top = origTop;
      document.body.style.width = origWidth;
      window.scrollTo(0, scrollY);
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Responsive font size — smaller on mobile
    const isMobile = window.innerWidth < 640;
    const fontSize = isMobile ? 16 : 13;

    const term = new Terminal({
      theme: THEME,
      fontFamily: "Monaco, 'Cascadia Code', 'Fira Code', monospace",
      fontSize,
      lineHeight: isMobile ? 1.2 : 1.35,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 5000,
      convertEol: true,
      allowProposedApi: true,
    });

    // Disable mouse reporting to PTY — keep selections local in xterm.js
    // This prevents tmux mouse mode from capturing clicks/drags
    term.options.windowsMode = false;
    // After open, send escape sequence to disable mouse tracking in the remote tmux
    setTimeout(() => {
      // Disable all mouse modes: normal, button, any-event, SGR
      term.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");
    }, 500);

    const fit = new FitAddon();
    const webLinks = new WebLinksAddon((_event, uri) => {
      window.open(uri, "_blank", "noopener");
    });
    term.loadAddon(fit);
    term.loadAddon(webLinks);
    term.open(container);
    termInstanceRef.current = term;

    // Delay fit until container has real dimensions
    const fitTimer = setTimeout(() => {
      try { fit.fit(); } catch {}
      term.focus();
    }, 100);

    // Connect to PTY WebSocket
    const ws = new WebSocket(wsUrl("/ws/pty"));
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      // Re-fit now that WS is ready (container should have dimensions)
      try { fit.fit(); } catch {}
      ws.send(JSON.stringify({
        type: "attach",
        target,
        cols: term.cols,
        rows: term.rows,
      }));
    };

    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "detached") {
            term.write("\r\n\x1b[33m[session detached]\x1b[0m\r\n");
          }
        } catch {}
      } else {
        // Binary PTY data → render in xterm.js
        term.write(new Uint8Array(e.data));
      }
    };

    ws.onclose = () => {
      term.write("\r\n\x1b[31m[connection closed]\x1b[0m\r\n");
    };

    // Keystrokes → binary to PTY stdin
    const encoder = new TextEncoder();
    const dataSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encoder.encode(data));
      }
    });

    const binSub = term.onBinary((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        const bytes = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i);
        ws.send(bytes);
      }
    });

    // Modal navigation shortcuts (intercept before xterm processes them)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.key === "Escape" && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        onCloseRef.current();
        return false;
      }
      if (e.altKey && e.key === "ArrowLeft") { onNavigateRef.current(-1); return false; }
      if (e.altKey && e.key === "ArrowRight") { onNavigateRef.current(1); return false; }
      if (e.altKey && e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key) - 1;
        if (idx < siblingsRef.current.length) onSelectSiblingRef.current(siblingsRef.current[idx]);
        return false;
      }
      return true;
    });

    // Auto-resize with debounce
    let resizeTimer2: ReturnType<typeof setTimeout>;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer2);
      resizeTimer2 = setTimeout(() => {
        try {
          fit.fit();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          }
        } catch {}
      }, 200);
    });
    resizeObserver.observe(container);

    return () => {
      clearTimeout(fitTimer);
      clearTimeout(resizeTimer2);
      resizeObserver.disconnect();
      dataSub.dispose();
      binSub.dispose();
      ws.close();
      term.dispose();
    };
  }, [target]);

  const [textMode, setTextMode] = useState(false);
  const [textContent, setTextContent] = useState("");
  const termInstanceRef = useRef<Terminal | null>(null);

  // Toggle between xterm and selectable text view
  const toggleTextMode = useCallback(() => {
    if (!textMode && termInstanceRef.current) {
      // Extract buffer content
      const term = termInstanceRef.current;
      const lines: string[] = [];
      const buf = term.buffer.active;
      for (let i = Math.max(0, buf.length - 200); i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      setTextContent(lines.join("\n"));
    }
    setTextMode(!textMode);
  }, [textMode]);

  // Copy all text to clipboard
  const copyAll = useCallback(async () => {
    if (termInstanceRef.current) {
      const term = termInstanceRef.current;
      const lines: string[] = [];
      const buf = term.buffer.active;
      for (let i = Math.max(0, buf.length - 200); i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      const text = lines.join("\n");
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Fallback
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
    }
  }, []);

  if (textMode) {
    return (
      <div style={{ width: "100%", height: "100%", overflow: "auto", background: "#0a0a0f", padding: "8px" }}>
        <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
          <button
            onClick={toggleTextMode}
            style={{ padding: "4px 12px", background: "#1a1a2e", color: "#94e2d5", border: "1px solid #94e2d533", borderRadius: "4px", fontSize: "11px", fontFamily: "monospace", cursor: "pointer" }}
          >
            ← terminal
          </button>
          <button
            onClick={async () => {
              try { await navigator.clipboard.writeText(textContent); } catch {
                const ta = document.createElement("textarea"); ta.value = textContent; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
              }
            }}
            style={{ padding: "4px 12px", background: "#1a1a2e", color: "#a6e3a1", border: "1px solid #a6e3a133", borderRadius: "4px", fontSize: "11px", fontFamily: "monospace", cursor: "pointer" }}
          >
            copy all
          </button>
        </div>
        <pre style={{ color: "#cdd6f4", fontSize: "12px", fontFamily: "Monaco, 'Cascadia Code', monospace", lineHeight: 1.35, whiteSpace: "pre-wrap", wordBreak: "break-word", userSelect: "text", WebkitUserSelect: "text" }}>
          {textContent}
        </pre>
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <div
        ref={(el) => {
          (containerRef as any).current = el;
        }}
        data-terminal="true"
        style={{ width: "100%", height: "100%", overflow: "hidden", touchAction: "manipulation", maxWidth: "100vw" }}
      />
      {/* Floating select/copy buttons */}
      <div style={{ position: "absolute", bottom: "8px", right: "8px", display: "flex", gap: "4px", zIndex: 10 }}>
        <button
          onClick={toggleTextMode}
          style={{ padding: "6px 10px", background: "rgba(148,226,213,0.15)", color: "#94e2d5", border: "1px solid rgba(148,226,213,0.3)", borderRadius: "6px", fontSize: "11px", fontFamily: "monospace", cursor: "pointer", backdropFilter: "blur(8px)" }}
        >
          select
        </button>
        <button
          onClick={copyAll}
          style={{ padding: "6px 10px", background: "rgba(166,227,161,0.15)", color: "#a6e3a1", border: "1px solid rgba(166,227,161,0.3)", borderRadius: "6px", fontSize: "11px", fontFamily: "monospace", cursor: "pointer", backdropFilter: "blur(8px)" }}
        >
          copy
        </button>
      </div>
    </div>
  );
}
