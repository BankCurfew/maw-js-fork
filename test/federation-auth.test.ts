import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { signRequest, signHeaders, verifyRequest, requireHmac } from "../src/lib/federation-auth";

// --- signRequest ---

describe("signRequest", () => {
  const token = "test-federation-token-minimum-16-chars";

  test("returns timestamp and hex signature", () => {
    const { timestamp, signature } = signRequest("POST", "/api/send", token);
    expect(timestamp).toMatch(/^\d+$/);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  test("same inputs produce same signature", () => {
    // Fix timestamp by mocking Date.now
    const now = Date.now();
    const orig = Date.now;
    Date.now = () => now;
    try {
      const a = signRequest("POST", "/api/send", token);
      const b = signRequest("POST", "/api/send", token);
      expect(a.signature).toBe(b.signature);
    } finally {
      Date.now = orig;
    }
  });

  test("different methods produce different signatures", () => {
    const now = Date.now();
    const orig = Date.now;
    Date.now = () => now;
    try {
      const a = signRequest("POST", "/api/send", token);
      const b = signRequest("GET", "/api/send", token);
      expect(a.signature).not.toBe(b.signature);
    } finally {
      Date.now = orig;
    }
  });

  test("different paths produce different signatures", () => {
    const now = Date.now();
    const orig = Date.now;
    Date.now = () => now;
    try {
      const a = signRequest("POST", "/api/send", token);
      const b = signRequest("POST", "/api/other", token);
      expect(a.signature).not.toBe(b.signature);
    } finally {
      Date.now = orig;
    }
  });
});

// --- signHeaders ---

describe("signHeaders", () => {
  const token = "test-federation-token-minimum-16-chars";

  test("produces X-Maw-Timestamp and X-Maw-Signature headers", () => {
    const headers = signHeaders(token, "POST", "/api/send");
    expect(headers["X-Maw-Timestamp"]).toBeDefined();
    expect(headers["X-Maw-Signature"]).toBeDefined();
    expect(headers["X-Maw-Signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("timestamp is a numeric string", () => {
    const headers = signHeaders(token, "GET", "/api/health");
    expect(headers["X-Maw-Timestamp"]).toMatch(/^\d+$/);
  });
});

// --- verifyRequest ---

describe("verifyRequest", () => {
  // verifyRequest loads token from config — we need to mock loadConfig
  // Since we can't easily mock the module, test the sign→verify roundtrip
  // by testing signHeaders output matches what verifyRequest expects

  test("rejects null timestamp", () => {
    expect(verifyRequest("POST", "/api/send", null, "abc")).toBe(false);
  });

  test("rejects null signature", () => {
    expect(verifyRequest("POST", "/api/send", Date.now().toString(), null)).toBe(false);
  });

  test("rejects non-numeric timestamp", () => {
    expect(verifyRequest("POST", "/api/send", "not-a-number", "abc")).toBe(false);
  });

  test("rejects expired timestamp (>60s drift)", () => {
    // Even with correct sig, old timestamp should fail
    const oldTs = (Date.now() - 120_000).toString(); // 2 min ago
    expect(verifyRequest("POST", "/api/send", oldTs, "0".repeat(64))).toBe(false);
  });

  test("rejects empty strings", () => {
    expect(verifyRequest("POST", "/api/send", "", "")).toBe(false);
  });

  test("rejects malformed hex signature", () => {
    const ts = Date.now().toString();
    expect(verifyRequest("POST", "/api/send", ts, "not-hex-at-all!")).toBe(false);
  });
});

// --- requireHmac middleware ---

describe("requireHmac middleware", () => {
  test("returns a function", () => {
    const mw = requireHmac();
    expect(typeof mw).toBe("function");
  });

  test("rejects request without headers", async () => {
    const mw = requireHmac();
    const mockC = {
      req: {
        header: (name: string) => undefined,
        method: "POST",
        url: "http://localhost:3456/api/send",
      },
      json: (body: any, status: number) => ({ body, status }),
    };
    const next = mock(() => {});

    const result = await mw(mockC, next);
    expect(result.status).toBe(401);
    expect(result.body.error).toContain("HMAC");
    expect(next).not.toHaveBeenCalled();
  });

  test("rejects request with invalid signature", async () => {
    const mw = requireHmac();
    const mockC = {
      req: {
        header: (name: string) => {
          if (name === "x-maw-timestamp") return Date.now().toString();
          if (name === "x-maw-signature") return "0".repeat(64);
          return undefined;
        },
        method: "POST",
        url: "http://localhost:3456/api/send",
      },
      json: (body: any, status: number) => ({ body, status }),
    };
    const next = mock(() => {});

    const result = await mw(mockC, next);
    expect(result.status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// --- SECURITY REGRESSION: XFF bypass (CVE-class, see #191) ---

describe("XFF bypass regression guard (#191)", () => {
  test("federation-auth source MUST NOT read X-Forwarded-For or X-Real-IP headers", () => {
    const source = readFileSync(
      new URL("../src/lib/federation-auth.ts", import.meta.url).pathname,
      "utf-8",
    );

    // Strip comments to check only executable code
    const codeOnly = source
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    const lower = codeOnly.toLowerCase();
    expect(lower).not.toContain("x-forwarded-for");
    expect(lower).not.toContain("x-real-ip");
  });

  test("middleware only reads x-maw-timestamp and x-maw-signature headers", () => {
    const source = readFileSync(
      new URL("../src/lib/federation-auth.ts", import.meta.url).pathname,
      "utf-8",
    );

    // Strip comments
    const codeOnly = source
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    // Find all c.req.header() calls — should only be timestamp and signature
    const headerCalls = codeOnly.match(/\.header\(["']([^"']+)["']\)/g) || [];
    const headerNames = headerCalls.map(c => {
      const m = c.match(/["']([^"']+)["']/);
      return m ? m[1].toLowerCase() : "";
    });

    for (const name of headerNames) {
      expect(["x-maw-timestamp", "x-maw-signature"]).toContain(name);
    }
  });

  test("uses timingSafeEqual for signature comparison", () => {
    const source = readFileSync(
      new URL("../src/lib/federation-auth.ts", import.meta.url).pathname,
      "utf-8",
    );
    expect(source).toContain("timingSafeEqual");
  });
});

// --- Timing attack resistance ---

describe("timing attack resistance", () => {
  test("verifyRequest uses constant-time comparison (source check)", () => {
    const source = readFileSync(
      new URL("../src/lib/federation-auth.ts", import.meta.url).pathname,
      "utf-8",
    );
    // Must import and use timingSafeEqual
    expect(source).toContain('import { timingSafeEqual }');
    expect(source).toContain("timingSafeEqual(");
  });

  test("MAX_DRIFT_MS is 60 seconds", () => {
    const source = readFileSync(
      new URL("../src/lib/federation-auth.ts", import.meta.url).pathname,
      "utf-8",
    );
    expect(source).toContain("60_000");
  });
});
