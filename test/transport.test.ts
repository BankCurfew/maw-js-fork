import { describe, test, expect, mock, beforeEach } from "bun:test";
import { classifyError, TransportRouter } from "../src/transport";
import type { Transport, TransportTarget, TransportPresence, TransportMessage } from "../src/transport";
import type { FeedEvent } from "../src/lib/feed";

// --- classifyError ---

describe("classifyError", () => {
  // Timeout errors — retryable
  test("classifies ETIMEDOUT as timeout (retryable)", () => {
    const r = classifyError(new Error("connect ETIMEDOUT 10.0.0.1:3456"));
    expect(r.reason).toBe("timeout");
    expect(r.retryable).toBe(true);
  });

  test("classifies timeout string as timeout (retryable)", () => {
    const r = classifyError(new Error("Request timeout after 5000ms"));
    expect(r.reason).toBe("timeout");
    expect(r.retryable).toBe(true);
  });

  test("classifies ECONNRESET as timeout (retryable)", () => {
    const r = classifyError(new Error("read ECONNRESET"));
    expect(r.reason).toBe("timeout");
    expect(r.retryable).toBe(true);
  });

  // Unreachable errors — retryable
  test("classifies ECONNREFUSED as unreachable (retryable)", () => {
    const r = classifyError(new Error("connect ECONNREFUSED 127.0.0.1:3456"));
    expect(r.reason).toBe("unreachable");
    expect(r.retryable).toBe(true);
  });

  test("classifies ENETUNREACH as unreachable (retryable)", () => {
    const r = classifyError(new Error("connect ENETUNREACH"));
    expect(r.reason).toBe("unreachable");
    expect(r.retryable).toBe(true);
  });

  test("classifies 'unreachable' text as unreachable (retryable)", () => {
    const r = classifyError("host unreachable");
    expect(r.reason).toBe("unreachable");
    expect(r.retryable).toBe(true);
  });

  // Auth errors — not retryable
  test("classifies 401 as auth (not retryable)", () => {
    const r = classifyError(new Error("HTTP 401 Unauthorized"));
    expect(r.reason).toBe("auth");
    expect(r.retryable).toBe(false);
  });

  test("classifies 403 as auth (not retryable)", () => {
    const r = classifyError(new Error("HTTP 403 Forbidden"));
    expect(r.reason).toBe("auth");
    expect(r.retryable).toBe(false);
  });

  test("classifies 'unauthorized' as auth (not retryable)", () => {
    const r = classifyError("unauthorized access");
    expect(r.reason).toBe("auth");
    expect(r.retryable).toBe(false);
  });

  test("classifies 'forbidden' as auth (not retryable)", () => {
    const r = classifyError("forbidden");
    expect(r.reason).toBe("auth");
    expect(r.retryable).toBe(false);
  });

  // Rate limit — retryable
  test("classifies 429 as rate_limit (retryable)", () => {
    const r = classifyError(new Error("HTTP 429 Too Many Requests"));
    expect(r.reason).toBe("rate_limit");
    expect(r.retryable).toBe(true);
  });

  test("classifies 'rate limit' as rate_limit (retryable)", () => {
    const r = classifyError("rate limit exceeded");
    expect(r.reason).toBe("rate_limit");
    expect(r.retryable).toBe(true);
  });

  test("classifies 'too many' as rate_limit (retryable)", () => {
    const r = classifyError("too many requests from this IP");
    expect(r.reason).toBe("rate_limit");
    expect(r.retryable).toBe(true);
  });

  // Rejected — not retryable
  test("classifies 400 as rejected (not retryable)", () => {
    const r = classifyError(new Error("HTTP 400 Bad Request"));
    expect(r.reason).toBe("rejected");
    expect(r.retryable).toBe(false);
  });

  test("classifies 'rejected' as rejected (not retryable)", () => {
    const r = classifyError("message rejected by peer");
    expect(r.reason).toBe("rejected");
    expect(r.retryable).toBe(false);
  });

  test("classifies 'denied' as rejected (not retryable)", () => {
    const r = classifyError("access denied");
    expect(r.reason).toBe("rejected");
    expect(r.retryable).toBe(false);
  });

  // Parse error — not retryable
  test("classifies JSON parse error (not retryable)", () => {
    const r = classifyError(new SyntaxError("Unexpected token < in JSON"));
    expect(r.reason).toBe("parse_error");
    expect(r.retryable).toBe(false);
  });

  test("classifies 'parse' error (not retryable)", () => {
    const r = classifyError("failed to parse response");
    expect(r.reason).toBe("parse_error");
    expect(r.retryable).toBe(false);
  });

  // Unknown
  test("classifies null/undefined as unknown (not retryable)", () => {
    expect(classifyError(null)).toEqual({ reason: "unknown", retryable: false });
    expect(classifyError(undefined)).toEqual({ reason: "unknown", retryable: false });
    expect(classifyError("")).toEqual({ reason: "unknown", retryable: false });
  });

  test("classifies unrecognized error as unknown (not retryable)", () => {
    const r = classifyError(new Error("something completely unexpected"));
    expect(r.reason).toBe("unknown");
    expect(r.retryable).toBe(false);
  });

  // Edge: case insensitive
  test("is case-insensitive", () => {
    expect(classifyError("TIMEOUT").reason).toBe("timeout");
    expect(classifyError("ECONNREFUSED").reason).toBe("unreachable");
    expect(classifyError("UNAUTHORIZED").reason).toBe("auth");
  });

  // Priority: first match wins
  test("first regex match wins when multiple patterns present", () => {
    // "timeout" matches before "auth"
    const r = classifyError("timeout during auth request");
    expect(r.reason).toBe("timeout");
  });
});

// --- TransportRouter ---

/** Create a mock Transport for testing */
function makeMockTransport(
  name: string,
  opts: {
    connected?: boolean;
    canReach?: (t: TransportTarget) => boolean;
    sendResult?: boolean | Error;
  } = {},
): Transport & { sentMessages: { target: TransportTarget; message: string }[] } {
  const sentMessages: { target: TransportTarget; message: string }[] = [];
  const messageHandlers: ((msg: TransportMessage) => void)[] = [];
  const presenceHandlers: ((p: TransportPresence) => void)[] = [];
  const feedHandlers: ((e: FeedEvent) => void)[] = [];

  return {
    name,
    connected: opts.connected ?? true,
    sentMessages,

    connect: mock(async () => {}),
    disconnect: mock(async () => {}),

    send: mock(async (target: TransportTarget, message: string) => {
      if (opts.sendResult instanceof Error) throw opts.sendResult;
      sentMessages.push({ target, message });
      return opts.sendResult ?? true;
    }),

    publishPresence: mock(async () => {}),
    publishFeed: mock(async () => {}),

    canReach: mock((target: TransportTarget) => {
      return opts.canReach ? opts.canReach(target) : true;
    }),

    onMessage: (handler) => messageHandlers.push(handler),
    onPresence: (handler) => presenceHandlers.push(handler),
    onFeed: (handler) => feedHandlers.push(handler),
  };
}

describe("TransportRouter", () => {
  const localTarget: TransportTarget = { oracle: "dev", tmuxTarget: "oracles:2" };
  const remoteTarget: TransportTarget = { oracle: "neo", host: "mba.wg" };

  test("register adds transport and wires handlers", () => {
    const router = new TransportRouter();
    const t = makeMockTransport("test");
    router.register(t);

    expect(router.status()).toEqual([{ name: "test", connected: true }]);
  });

  test("status shows all registered transports", () => {
    const router = new TransportRouter();
    router.register(makeMockTransport("tmux", { connected: true }));
    router.register(makeMockTransport("mqtt", { connected: false }));
    router.register(makeMockTransport("http", { connected: true }));

    const s = router.status();
    expect(s).toHaveLength(3);
    expect(s[0]).toEqual({ name: "tmux", connected: true });
    expect(s[1]).toEqual({ name: "mqtt", connected: false });
    expect(s[2]).toEqual({ name: "http", connected: true });
  });

  // --- send routing ---

  test("send routes through first transport that can reach target", async () => {
    const router = new TransportRouter();
    const tmux = makeMockTransport("tmux", { canReach: (t) => !t.host });
    const http = makeMockTransport("http", { canReach: () => true });

    router.register(tmux);
    router.register(http);

    // Local target → tmux (first match)
    const r1 = await router.send(localTarget, "hello", "bob");
    expect(r1.ok).toBe(true);
    expect(r1.via).toBe("tmux");
    expect(tmux.sentMessages).toHaveLength(1);

    // Remote target → tmux can't reach, falls through to http
    const r2 = await router.send(remoteTarget, "hello", "bob");
    expect(r2.ok).toBe(true);
    expect(r2.via).toBe("http");
    expect(http.sentMessages).toHaveLength(1);
  });

  test("send skips disconnected transports", async () => {
    const router = new TransportRouter();
    const offline = makeMockTransport("mqtt", { connected: false });
    const online = makeMockTransport("http", { connected: true });

    router.register(offline);
    router.register(online);

    const r = await router.send(localTarget, "hello", "bob");
    expect(r.ok).toBe(true);
    expect(r.via).toBe("http");
    expect(offline.sentMessages).toHaveLength(0);
  });

  test("send fails over to next transport on retryable error", async () => {
    const router = new TransportRouter();
    const failing = makeMockTransport("tmux", {
      sendResult: new Error("connect ETIMEDOUT"),
    });
    const backup = makeMockTransport("http");

    router.register(failing);
    router.register(backup);

    const r = await router.send(localTarget, "hello", "bob");
    expect(r.ok).toBe(true);
    expect(r.via).toBe("http");
  });

  test("send stops on non-retryable error", async () => {
    const router = new TransportRouter();
    const authFail = makeMockTransport("http", {
      sendResult: new Error("HTTP 401 Unauthorized"),
    });
    const backup = makeMockTransport("mqtt");

    router.register(authFail);
    router.register(backup);

    const r = await router.send(localTarget, "hello", "bob");
    expect(r.ok).toBe(false);
    expect(r.via).toBe("http");
    expect(r.reason).toBe("auth");
    expect(r.retryable).toBe(false);
    // Backup should NOT have been tried
    expect(backup.sentMessages).toHaveLength(0);
  });

  test("send returns unreachable when no transport can deliver", async () => {
    const router = new TransportRouter();
    const t = makeMockTransport("tmux", { canReach: () => false });
    router.register(t);

    const r = await router.send(remoteTarget, "hello", "bob");
    expect(r.ok).toBe(false);
    expect(r.via).toBe("none");
    expect(r.reason).toBe("unreachable");
  });

  test("send returns unreachable with no transports registered", async () => {
    const router = new TransportRouter();
    const r = await router.send(localTarget, "hello", "bob");
    expect(r.ok).toBe(false);
    expect(r.via).toBe("none");
  });

  test("send fails over when transport returns false", async () => {
    const router = new TransportRouter();
    const soft = makeMockTransport("tmux", { sendResult: false });
    const backup = makeMockTransport("http", { sendResult: true });

    router.register(soft);
    router.register(backup);

    const r = await router.send(localTarget, "hello", "bob");
    expect(r.ok).toBe(true);
    expect(r.via).toBe("http");
  });

  // --- connectAll / disconnectAll ---

  test("connectAll calls connect on all transports", async () => {
    const router = new TransportRouter();
    const t1 = makeMockTransport("a");
    const t2 = makeMockTransport("b");
    router.register(t1);
    router.register(t2);

    await router.connectAll();
    expect(t1.connect).toHaveBeenCalled();
    expect(t2.connect).toHaveBeenCalled();
  });

  test("disconnectAll calls disconnect on all transports", async () => {
    const router = new TransportRouter();
    const t1 = makeMockTransport("a");
    const t2 = makeMockTransport("b");
    router.register(t1);
    router.register(t2);

    await router.disconnectAll();
    expect(t1.disconnect).toHaveBeenCalled();
    expect(t2.disconnect).toHaveBeenCalled();
  });

  // --- publishPresence / publishFeed ---

  test("publishPresence broadcasts to all connected transports", async () => {
    const router = new TransportRouter();
    const t1 = makeMockTransport("a", { connected: true });
    const t2 = makeMockTransport("b", { connected: false });
    const t3 = makeMockTransport("c", { connected: true });
    router.register(t1);
    router.register(t2);
    router.register(t3);

    const presence: TransportPresence = {
      oracle: "dev", host: "white", status: "busy", timestamp: Date.now(),
    };
    await router.publishPresence(presence);

    expect(t1.publishPresence).toHaveBeenCalled();
    expect(t2.publishPresence).not.toHaveBeenCalled();
    expect(t3.publishPresence).toHaveBeenCalled();
  });

  test("publishFeed broadcasts to all connected transports", async () => {
    const router = new TransportRouter();
    const t1 = makeMockTransport("a", { connected: true });
    const t2 = makeMockTransport("b", { connected: true });
    router.register(t1);
    router.register(t2);

    const event = {
      timestamp: new Date().toISOString(),
      oracle: "Dev-Oracle", host: "white",
      event: "Notification" as any, project: "test",
      sessionId: "s1", message: "hello", ts: Date.now(),
    };
    await router.publishFeed(event);

    expect(t1.publishFeed).toHaveBeenCalled();
    expect(t2.publishFeed).toHaveBeenCalled();
  });

  // --- Event handler aggregation ---

  test("onMessage receives messages from all registered transports", () => {
    const router = new TransportRouter();
    const received: TransportMessage[] = [];
    router.onMessage((msg) => received.push(msg));

    // Register triggers handler wiring
    const messageHandlers: ((msg: TransportMessage) => void)[] = [];
    const t: Transport = {
      name: "test",
      connected: true,
      connect: async () => {},
      disconnect: async () => {},
      send: async () => true,
      publishPresence: async () => {},
      publishFeed: async () => {},
      canReach: () => true,
      onMessage: (h) => messageHandlers.push(h),
      onPresence: () => {},
      onFeed: () => {},
    };
    router.register(t);

    // Simulate incoming message
    const msg: TransportMessage = {
      from: "bob", to: "dev", body: "hello",
      timestamp: Date.now(), transport: "tmux",
    };
    for (const h of messageHandlers) h(msg);

    expect(received).toHaveLength(1);
    expect(received[0].from).toBe("bob");
  });
});
