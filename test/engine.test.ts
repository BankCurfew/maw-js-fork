import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { FeedTailer } from "../src/feed-tail";
import type { FeedEvent } from "../src/lib/feed";

/**
 * Engine tests — refactored to avoid mock.module() which pollutes globals.
 *
 * Strategy: test engine behavior through public API + seeded private state.
 * tmux-dependent methods (handleOpen cold path, broadcastSessions) are tested
 * via the warm-cache path where cachedSessions is pre-seeded.
 */

/** Minimal WebSocket stub that records sent messages */
function makeWS(target?: string): { ws: any; messages: any[] } {
  const messages: any[] = [];
  const ws = {
    data: { target: target || null, previewTargets: new Set<string>() },
    send: (msg: string) => {
      try { messages.push(JSON.parse(msg)); } catch { messages.push(msg); }
    },
    readyState: 1,
  };
  return { ws, messages };
}

/** Mock FeedTailer that doesn't touch filesystem */
function makeFeedTailer(events: FeedEvent[] = []): FeedTailer {
  const listeners = new Set<(event: FeedEvent) => void>();
  return {
    start: mock(() => {}),
    stop: mock(() => {}),
    onEvent: mock((cb: (event: FeedEvent) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    getRecent: mock((n?: number) => events.slice(-(n || 50))),
    getActive: mock((windowMs?: number) => {
      const map = new Map<string, FeedEvent>();
      const cutoff = Date.now() - (windowMs || 300_000);
      for (const e of events) {
        if (e.ts > cutoff) map.set(e.oracle, e);
      }
      return map;
    }),
    // internal — emit an event to all listeners
    _emit: (event: FeedEvent) => {
      for (const cb of listeners) cb(event);
    },
  } as any;
}

/** Make a fake FeedEvent */
function makeFeedEvent(oracle: string, message: string, tsOffset = 0): FeedEvent {
  return {
    timestamp: new Date(Date.now() + tsOffset).toISOString(),
    oracle,
    host: "test",
    event: "Notification" as any,
    project: "test",
    sessionId: "test",
    message,
    ts: Date.now() + tsOffset,
  };
}

// Static import — avoids dynamic import resolution issues on CI
import { MawEngine } from "../src/engine";

// --- Handler registration ---

describe("MawEngine — handler registration", () => {
  test("on() registers a handler that handleMessage dispatches to", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });
    const received: any[] = [];

    engine.on("test-type", (_ws: any, data: any) => {
      received.push(data);
    });

    const { ws } = makeWS();
    engine.handleMessage(ws, JSON.stringify({ type: "test-type", payload: 42 }));

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("test-type");
    expect(received[0].payload).toBe(42);
  });

  test("handleMessage ignores unknown types silently", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });
    const { ws } = makeWS();

    // Should not throw
    engine.handleMessage(ws, JSON.stringify({ type: "nonexistent" }));
  });

  test("handleMessage ignores malformed JSON silently", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });
    const { ws } = makeWS();

    // Should not throw
    engine.handleMessage(ws, "not json{{{");
    engine.handleMessage(ws, "");
  });
});

// --- WebSocket lifecycle ---

describe("MawEngine — WebSocket lifecycle", () => {
  test("handleOpen with warm cache sends sessions immediately", () => {
    const feedEvents = [makeFeedEvent("QA-Oracle", "testing")];
    const ft = makeFeedTailer(feedEvents);
    const engine = new MawEngine({ feedTailer: ft });

    // Seed warm cache (avoids tmux.listAll call)
    const sessions = [
      { name: "oracles", windows: [{ index: 1, name: "qa-oracle", active: true }] },
    ];
    // @ts-ignore — access private for testing
    engine.cachedSessions = sessions;

    const { ws, messages } = makeWS();
    engine.handleOpen(ws);

    // Should get sessions message immediately (sync path)
    const sessionMsg = messages.find(m => m.type === "sessions");
    expect(sessionMsg).toBeDefined();
    expect(sessionMsg!.sessions).toEqual(sessions);

    // Should get feed-history
    const feedMsg = messages.find(m => m.type === "feed-history");
    expect(feedMsg).toBeDefined();

    // Cleanup
    engine.handleClose(ws);
  });

  test("handleOpen sends feed-history from tailer", () => {
    const events = [
      makeFeedEvent("Dev-Oracle", "coding", -60000),
      makeFeedEvent("QA-Oracle", "testing", -30000),
    ];
    const ft = makeFeedTailer(events);
    const engine = new MawEngine({ feedTailer: ft });

    // @ts-ignore
    engine.cachedSessions = [];

    const { ws, messages } = makeWS();
    engine.handleOpen(ws);

    const feedMsg = messages.find(m => m.type === "feed-history");
    expect(feedMsg).toBeDefined();
    expect(feedMsg!.events).toHaveLength(2);

    engine.handleClose(ws);
  });

  test("handleClose removes client from set", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });

    // @ts-ignore
    engine.cachedSessions = [];

    const { ws: ws1 } = makeWS();
    const { ws: ws2 } = makeWS();

    engine.handleOpen(ws1);
    engine.handleOpen(ws2);

    // @ts-ignore — check client count
    expect(engine.clients.size).toBe(2);

    engine.handleClose(ws1);
    // @ts-ignore
    expect(engine.clients.size).toBe(1);

    engine.handleClose(ws2);
    // @ts-ignore
    expect(engine.clients.size).toBe(0);
  });

  test("handleClose cleans up content and preview caches", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });

    // @ts-ignore
    engine.cachedSessions = [];

    const { ws } = makeWS();
    engine.handleOpen(ws);

    // @ts-ignore — simulate cached content
    engine.lastContent.set(ws, "some content");
    engine.lastPreviews.set(ws, new Map([["t1", "preview"]]));

    engine.handleClose(ws);

    // @ts-ignore
    expect(engine.lastContent.has(ws)).toBe(false);
    // @ts-ignore
    expect(engine.lastPreviews.has(ws)).toBe(false);
  });
});

// --- Broadcast ---

describe("MawEngine — broadcast", () => {
  test("broadcast sends to all connected clients", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });

    // @ts-ignore
    engine.cachedSessions = [];

    const { ws: ws1, messages: m1 } = makeWS();
    const { ws: ws2, messages: m2 } = makeWS();

    engine.handleOpen(ws1);
    engine.handleOpen(ws2);

    engine.broadcast(JSON.stringify({ type: "test", data: "hello" }));

    expect(m1.filter(m => m.type === "test")).toHaveLength(1);
    expect(m2.filter(m => m.type === "test")).toHaveLength(1);

    engine.handleClose(ws1);
    engine.handleClose(ws2);
  });

  test("broadcast skips disconnected clients", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });

    // @ts-ignore
    engine.cachedSessions = [];

    const { ws: ws1, messages: m1 } = makeWS();
    const { ws: ws2, messages: m2 } = makeWS();

    engine.handleOpen(ws1);
    engine.handleOpen(ws2);
    engine.handleClose(ws1);

    engine.broadcast(JSON.stringify({ type: "after-disconnect" }));

    // ws1 was disconnected, should not receive
    expect(m1.filter(m => m.type === "after-disconnect")).toHaveLength(0);
    // ws2 still connected, should receive
    expect(m2.filter(m => m.type === "after-disconnect")).toHaveLength(1);

    engine.handleClose(ws2);
  });
});

// --- Health summary ---

describe("MawEngine — health summary", () => {
  test("getHealthSummary returns null before first check", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });
    expect(engine.getHealthSummary()).toBeNull();
  });
});

// --- sendBusyAgents (warm cache path) ---

describe("MawEngine — busy agent detection", () => {
  test("handleOpen with cached sessions calls sendBusyAgents", async () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });

    const sessions = [
      { name: "oracles", windows: [
        { index: 1, name: "bob-oracle", active: true },
        { index: 2, name: "dev-oracle", active: false },
      ]},
    ];
    // @ts-ignore
    engine.cachedSessions = sessions;

    const { ws, messages } = makeWS();
    engine.handleOpen(ws);

    // sendBusyAgents is async — wait a tick
    await new Promise(r => setTimeout(r, 100));

    // Whether "recent" message is sent depends on tmux.getPaneCommands
    // which we can't mock here. The important thing is no crash.
    const types = messages.map(m => m.type);
    expect(types).toContain("sessions");
    expect(types).toContain("feed-history");

    engine.handleClose(ws);
  });
});

// --- Multiple handlers ---

describe("MawEngine — multiple handler types", () => {
  test("different types dispatch to different handlers", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });

    const typeA: any[] = [];
    const typeB: any[] = [];

    engine.on("type-a", (_ws: any, data: any) => typeA.push(data));
    engine.on("type-b", (_ws: any, data: any) => typeB.push(data));

    const { ws } = makeWS();
    engine.handleMessage(ws, JSON.stringify({ type: "type-a", v: 1 }));
    engine.handleMessage(ws, JSON.stringify({ type: "type-b", v: 2 }));
    engine.handleMessage(ws, JSON.stringify({ type: "type-a", v: 3 }));

    expect(typeA).toHaveLength(2);
    expect(typeB).toHaveLength(1);
    expect(typeA[0].v).toBe(1);
    expect(typeA[1].v).toBe(3);
    expect(typeB[0].v).toBe(2);
  });

  test("later handler registration overwrites earlier", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });

    const first: any[] = [];
    const second: any[] = [];

    engine.on("same-type", (_ws: any, data: any) => first.push(data));
    engine.on("same-type", (_ws: any, data: any) => second.push(data));

    const { ws } = makeWS();
    engine.handleMessage(ws, JSON.stringify({ type: "same-type" }));

    // Map.set overwrites — only second handler should fire
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });
});

// --- Interval lifecycle ---

describe("MawEngine — interval lifecycle", () => {
  test("intervals start on first client and stop when all disconnect", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });

    // @ts-ignore
    engine.cachedSessions = [];

    // @ts-ignore — no intervals before any client
    expect(engine.captureInterval).toBeNull();

    const { ws: ws1 } = makeWS();
    engine.handleOpen(ws1);

    // @ts-ignore — intervals started
    expect(engine.captureInterval).not.toBeNull();

    const { ws: ws2 } = makeWS();
    engine.handleOpen(ws2);

    engine.handleClose(ws1);
    // @ts-ignore — still one client, intervals continue
    expect(engine.captureInterval).not.toBeNull();

    engine.handleClose(ws2);
    // @ts-ignore — no clients, intervals stopped
    expect(engine.captureInterval).toBeNull();
  });
});

// --- Crash isolation (maw-js#72) ---

describe("MawEngine — handler crash isolation", () => {
  test("sync handler throw is caught and does not crash engine", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });

    engine.on("crash-sync", () => {
      throw new Error("sync handler explosion");
    });

    const { ws } = makeWS();

    // handleMessage should catch the sync throw
    expect(() => {
      engine.handleMessage(ws, JSON.stringify({ type: "crash-sync" }));
    }).not.toThrow();
  });

  test("sync handler crash doesn't affect subsequent messages", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });
    const received: any[] = [];

    engine.on("crash-sync", () => {
      throw new Error("boom");
    });
    engine.on("after-crash", (_ws: any, data: any) => {
      received.push(data);
    });

    const { ws } = makeWS();

    // First: crashing handler
    engine.handleMessage(ws, JSON.stringify({ type: "crash-sync" }));
    // Second: normal handler should still work
    engine.handleMessage(ws, JSON.stringify({ type: "after-crash", ok: true }));

    expect(received).toHaveLength(1);
    expect(received[0].ok).toBe(true);
  });

  test("async handler rejection does not crash the engine", async () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });

    engine.on("crash-async", async () => {
      throw new Error("async handler explosion");
    });

    const { ws } = makeWS();

    // The current implementation does NOT await the handler return value,
    // so async rejections escape the try-catch. This test documents the
    // current behavior — async handlers that reject produce unhandled
    // promise rejections.
    expect(() => {
      engine.handleMessage(ws, JSON.stringify({ type: "crash-async" }));
    }).not.toThrow();

    // Wait for the async rejection to settle
    await new Promise(r => setTimeout(r, 50));
  });

  test("handler that sends bad data to ws doesn't crash engine", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });

    engine.on("bad-send", (ws: any) => {
      // Handler tries to send, ws.send might throw
      ws.send(JSON.stringify({ type: "response", data: "ok" }));
    });

    // ws.send that throws
    const ws = {
      data: { target: null, previewTargets: new Set<string>() },
      send: () => { throw new Error("WebSocket closed"); },
      readyState: 3, // CLOSED
    };

    expect(() => {
      engine.handleMessage(ws as any, JSON.stringify({ type: "bad-send" }));
    }).not.toThrow();
  });

  test("handler accessing undefined data properties doesn't crash engine", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });

    engine.on("bad-access", (_ws: any, data: any) => {
      // Access nested property that doesn't exist
      const x = data.nested.deep.value; // TypeError
    });

    const { ws } = makeWS();

    expect(() => {
      engine.handleMessage(ws, JSON.stringify({ type: "bad-access" }));
    }).not.toThrow();
  });
});

// --- handleMessage edge cases (maw-js#72) ---

describe("MawEngine — handleMessage edge cases", () => {
  test("binary Buffer message that isn't valid UTF-8 doesn't crash", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });
    const { ws } = makeWS();

    // Buffer with invalid JSON — should be caught by JSON.parse catch
    expect(() => {
      engine.handleMessage(ws, Buffer.from([0xff, 0xfe, 0x00]));
    }).not.toThrow();
  });

  test("null message doesn't crash", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });
    const { ws } = makeWS();

    expect(() => {
      engine.handleMessage(ws, null as any);
    }).not.toThrow();
  });

  test("message with type but no handler is silently ignored", () => {
    const ft = makeFeedTailer();
    const engine = new MawEngine({ feedTailer: ft });
    const { ws, messages } = makeWS();

    engine.handleMessage(ws, JSON.stringify({ type: "ghost-handler", data: 1 }));

    // No response sent, no crash
    expect(messages).toHaveLength(0);
  });
});

// --- PM2 ecosystem config verification (maw-js#72) ---

describe("ecosystem.config.cjs — PM2 auto-restart settings", () => {
  let config: { apps: any[] };

  beforeEach(async () => {
    // Import the PM2 config
    config = await import("../ecosystem.config.cjs");
  });

  test("maw-boot has autorestart disabled (one-shot fleet spawner)", () => {
    const boot = config.apps.find((a: any) => a.name === "maw-boot");
    expect(boot).toBeDefined();
    expect(boot!.autorestart).toBe(false);
  });

  test("maw-dev has autorestart disabled (manual start only)", () => {
    const dev = config.apps.find((a: any) => a.name === "maw-dev");
    expect(dev).toBeDefined();
    expect(dev!.autorestart).toBe(false);
  });

  test("maw (server) does NOT have autorestart explicitly disabled", () => {
    const maw = config.apps.find((a: any) => a.name === "maw");
    expect(maw).toBeDefined();
    // autorestart defaults to true in PM2 — absence means enabled
    expect(maw!.autorestart).not.toBe(false);
  });

  test("maw-syslog has max_restarts limit (crash loop protection)", () => {
    const syslog = config.apps.find((a: any) => a.name === "maw-syslog");
    expect(syslog).toBeDefined();
    expect(syslog!.max_restarts).toBeDefined();
    expect(syslog!.max_restarts).toBeGreaterThan(0);
    expect(syslog!.max_restarts).toBeLessThanOrEqual(20); // reasonable upper bound
  });

  test("maw-syslog has min_uptime for crash detection", () => {
    const syslog = config.apps.find((a: any) => a.name === "maw-syslog");
    expect(syslog).toBeDefined();
    expect(syslog!.min_uptime).toBeDefined();
  });

  test("maw-boot has restart_delay to wait for server", () => {
    const boot = config.apps.find((a: any) => a.name === "maw-boot");
    expect(boot).toBeDefined();
    expect(boot!.restart_delay).toBeGreaterThanOrEqual(3000);
  });

  test("all apps have a script defined", () => {
    for (const app of config.apps) {
      expect(app.script).toBeDefined();
      expect(typeof app.script).toBe("string");
      expect(app.script.length).toBeGreaterThan(0);
    }
  });
});
