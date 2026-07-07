import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { createHash } from "node:crypto";
import {
  FILE_RE,
  IMG_RE,
  EXT_ALLOWLIST,
  MAX_RELAY_BYTES,
  scanChipPaths,
  gateSenderPath,
} from "../src/lib/file-patterns";

// --- file-patterns unit tests ---

describe("EXT_ALLOWLIST", () => {
  test("contains expected document types", () => {
    expect(EXT_ALLOWLIST.has("html")).toBe(true);
    expect(EXT_ALLOWLIST.has("pdf")).toBe(true);
    expect(EXT_ALLOWLIST.has("md")).toBe(true);
    expect(EXT_ALLOWLIST.has("txt")).toBe(true);
  });

  test("contains image types", () => {
    expect(EXT_ALLOWLIST.has("png")).toBe(true);
    expect(EXT_ALLOWLIST.has("jpg")).toBe(true);
    expect(EXT_ALLOWLIST.has("webp")).toBe(true);
    expect(EXT_ALLOWLIST.has("gif")).toBe(true);
  });

  test("does not contain disallowed types", () => {
    expect(EXT_ALLOWLIST.has("exe")).toBe(false);
    expect(EXT_ALLOWLIST.has("sh")).toBe(false);
    expect(EXT_ALLOWLIST.has("js")).toBe(false);
  });
});

describe("scanChipPaths", () => {
  test("extracts local file path from text", () => {
    const text = "เสร็จแล้ว:\n/Users/home/.maw/inbox/report.html";
    const paths = scanChipPaths(text);
    expect(paths).toContain("/Users/home/.maw/inbox/report.html");
  });

  test("extracts multiple paths", () => {
    const text = "/Users/home/.maw/inbox/a.html\n/Users/home/.maw/inbox/b.pdf";
    const paths = scanChipPaths(text);
    expect(paths.length).toBe(2);
  });

  test("excludes http image URLs (remote only)", () => {
    const text = "see https://example.com/photo.png for details";
    const paths = scanChipPaths(text);
    expect(paths).not.toContain("https://example.com/photo.png");
  });

  test("includes local image paths", () => {
    const text = "/Users/home/.playwright-cli/screenshot.png";
    const paths = scanChipPaths(text);
    expect(paths).toContain("/Users/home/.playwright-cli/screenshot.png");
  });

  test("deduplicates repeated paths", () => {
    const path = "/Users/home/.maw/inbox/x.md";
    const paths = scanChipPaths(`${path}\n${path}`);
    expect(paths.length).toBe(1);
  });
});

describe("gateSenderPath", () => {
  const testDir = join(tmpdir(), "file-relay-test");
  const inboxDir = join(homedir(), ".maw", "inbox");
  const testFile = join(inboxDir, "relay-test-fixture.txt");

  beforeAll(() => {
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(testFile, "hello relay");
  });

  afterAll(() => {
    try { unlinkSync(testFile); } catch {}
  });

  test("accepts file in ~/.maw/inbox/", () => {
    const result = gateSenderPath(testFile);
    expect(result).not.toBeNull();
    expect(result).toBe(testFile);
  });

  test("rejects non-existent file", () => {
    expect(gateSenderPath("/does/not/exist.txt")).toBeNull();
  });

  test("rejects disallowed extension", () => {
    const badFile = join(inboxDir, "test.sh");
    writeFileSync(badFile, "#!/bin/sh");
    try {
      expect(gateSenderPath(badFile)).toBeNull();
    } finally {
      try { unlinkSync(badFile); } catch {}
    }
  });

  test("rejects file outside allowed roots", () => {
    const outsideFile = join(tmpdir(), "outside.txt");
    writeFileSync(outsideFile, "outside");
    try {
      expect(gateSenderPath(outsideFile)).toBeNull();
    } finally {
      try { unlinkSync(outsideFile); } catch {}
    }
  });
});

// --- Receiver round-trip: test /api/file-push locally ---

describe("/api/file-push round-trip", () => {
  const MAW_SERVER = process.env.MAW_SERVER || "http://localhost:3456";
  const inboxDir = join(homedir(), ".maw", "inbox");
  const relayRoot = join(homedir(), ".maw", "inbox", "relay");
  const testContent = Buffer.from("round-trip test content for file-relay");
  const sha256 = createHash("sha256").update(testContent).digest("hex");
  const bname = "relay-roundtrip-test.txt";

  // Body sig requires fedKey — skip if not configured
  test("pushes file and receives dest_path", async () => {
    // Check if server is running
    let alive = false;
    try {
      const r = await fetch(`${MAW_SERVER}/api/health-check`, { signal: AbortSignal.timeout(2000) });
      alive = r.ok;
    } catch {}

    if (!alive) {
      console.log("  [skip] maw server not running — skipping round-trip test");
      return;
    }

    // We need a fedKey to sign — check env
    const fedKey = process.env.MAW_FED_KEY;
    if (!fedKey) {
      console.log("  [skip] MAW_FED_KEY not set — skipping authenticated round-trip");
      return;
    }

    // Compute auth headers
    const ts = Date.now().toString();
    const path = "/api/file-push";
    const hmac = new Bun.CryptoHasher("sha256", fedKey);
    hmac.update(`POST:${path}:${ts}`);
    const sig = hmac.digest("hex");

    // Body HMAC
    const bodySigHash = new Bun.CryptoHasher("sha256", fedKey);
    const localNode = "forge";
    bodySigHash.update(`file-push:${localNode}:${bname}:${sha256}`);
    const bodySig = bodySigHash.digest("hex");

    const res = await fetch(`${MAW_SERVER}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Maw-Timestamp": ts,
        "X-Maw-Signature": sig,
      },
      body: JSON.stringify({
        from_node: localNode,
        orig_path: `/tmp/${bname}`,
        basename: bname,
        sha256,
        data: testContent.toString("base64"),
        sig: bodySig,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as { dest_path?: string };
    expect(json.dest_path).toBeTruthy();
    expect(json.dest_path!.startsWith(relayRoot)).toBe(true);
    expect(json.dest_path!).toContain(sha256.slice(0, 8));
    expect(json.dest_path!).toContain(bname);

    // Verify file on disk
    const written = readFileSync(json.dest_path!);
    expect(written.toString()).toBe(testContent.toString());

    // Cleanup
    try { unlinkSync(json.dest_path!); } catch {}
  });
});
