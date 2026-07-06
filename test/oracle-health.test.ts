import { describe, test, expect } from "bun:test";
import {
  oracleToSession,
  alertId,
  getTier,
  isTrackableSender,
  looksLikeResponse,
  ORACLE_SESSIONS,
  EXPECTED_ORACLES,
  TIER_THRESHOLDS,
  RESTART_COOLDOWN_MS,
} from "../src/oracle-health";

// --- oracleToSession ---

describe("oracleToSession", () => {
  test("maps known oracles to numbered sessions", () => {
    expect(oracleToSession("bob")).toBe("01-bob");
    expect(oracleToSession("dev")).toBe("02-dev");
    expect(oracleToSession("qa")).toBe("03-qa");
    expect(oracleToSession("pulse")).toBe("23-pulse");
  });

  test("returns input unchanged for unknown oracles", () => {
    expect(oracleToSession("unknown-agent")).toBe("unknown-agent");
    expect(oracleToSession("")).toBe("");
  });

  test("all ORACLE_SESSIONS values have number prefix", () => {
    for (const [name, session] of Object.entries(ORACLE_SESSIONS)) {
      expect(session).toMatch(/^\d{2}-/);
      expect(session).toContain(name);
    }
  });
});

// --- EXPECTED_ORACLES ---

describe("EXPECTED_ORACLES", () => {
  test("contains all keys from ORACLE_SESSIONS", () => {
    for (const key of Object.keys(ORACLE_SESSIONS)) {
      expect(EXPECTED_ORACLES.has(key)).toBe(true);
    }
  });

  test("has correct size", () => {
    expect(EXPECTED_ORACLES.size).toBe(Object.keys(ORACLE_SESSIONS).length);
  });

  test("includes core oracles", () => {
    expect(EXPECTED_ORACLES.has("bob")).toBe(true);
    expect(EXPECTED_ORACLES.has("dev")).toBe(true);
    expect(EXPECTED_ORACLES.has("qa")).toBe(true);
    expect(EXPECTED_ORACLES.has("designer")).toBe(true);
    expect(EXPECTED_ORACLES.has("security")).toBe(true);
  });
});

// --- alertId ---

describe("alertId", () => {
  test("generates id with type and oracle", () => {
    expect(alertId("dead-session", "dev")).toBe("dead-session:dev:");
  });

  test("includes from when provided", () => {
    expect(alertId("no-response", "qa", "bob")).toBe("no-response:qa:bob");
  });

  test("handles empty from", () => {
    expect(alertId("auto-restart", "designer", "")).toBe("auto-restart:designer:");
  });
});

// --- getTier ---

describe("getTier", () => {
  test("returns 0 for < 15 min", () => {
    expect(getTier(0)).toBe(0);
    expect(getTier(5)).toBe(0);
    expect(getTier(14.9)).toBe(0);
  });

  test("returns 1 for 15-29 min", () => {
    expect(getTier(15)).toBe(1);
    expect(getTier(20)).toBe(1);
    expect(getTier(29)).toBe(1);
  });

  test("returns 2 for 30-119 min", () => {
    expect(getTier(30)).toBe(2);
    expect(getTier(60)).toBe(2);
    expect(getTier(119)).toBe(2);
  });

  test("returns 3 for >= 120 min", () => {
    expect(getTier(120)).toBe(3);
    expect(getTier(240)).toBe(3);
    expect(getTier(1440)).toBe(3); // 24 hours
  });

  test("tier thresholds match constants", () => {
    expect(TIER_THRESHOLDS[1]).toBe(15);
    expect(TIER_THRESHOLDS[2]).toBe(30);
    expect(TIER_THRESHOLDS[3]).toBe(120);
  });
});

// --- isTrackableSender ---

describe("isTrackableSender", () => {
  test("tracks oracle-to-oracle senders", () => {
    expect(isTrackableSender("bob")).toBe(true);
    expect(isTrackableSender("dev")).toBe(true);
    expect(isTrackableSender("qa")).toBe(true);
  });

  test("tracks senders ending with -oracle", () => {
    expect(isTrackableSender("custom-oracle")).toBe(true);
    expect(isTrackableSender("new-oracle")).toBe(true);
  });

  test("ignores cli sender", () => {
    expect(isTrackableSender("cli")).toBe(false);
  });

  test("ignores human sender", () => {
    expect(isTrackableSender("human")).toBe(false);
  });

  test("ignores empty sender", () => {
    expect(isTrackableSender("")).toBe(false);
  });

  test("ignores nat sender (in IGNORE_SENDERS despite later check)", () => {
    // "nat" is in IGNORE_SENDERS set so it returns false early,
    // even though there's a `from === "nat"` check after — dead branch
    expect(isTrackableSender("nat")).toBe(false);
  });

  test("ignores unknown non-oracle senders", () => {
    expect(isTrackableSender("random-tool")).toBe(false);
    expect(isTrackableSender("webhook")).toBe(false);
  });
});

// --- looksLikeResponse ---

describe("looksLikeResponse", () => {
  test("detects arrow format responses", () => {
    expect(looksLikeResponse("QA → bob: test passed", "bob")).toBe(true);
  });

  test("detects 'to <oracle>' format", () => {
    expect(looksLikeResponse("Report sent to dev with results", "dev")).toBe(true);
  });

  test("detects message starting with oracle name", () => {
    expect(looksLikeResponse("qa: done testing", "qa")).toBe(true);
  });

  test("detects Thai acknowledgments", () => {
    expect(looksLikeResponse("รับทราบ ขอบคุณครับ", "bob")).toBe(true);
    expect(looksLikeResponse("เสร็จแล้ว ส่งผลกลับ", "qa")).toBe(true);
  });

  test("detects English acknowledgments", () => {
    expect(looksLikeResponse("done with the review", "bob")).toBe(true);
  });

  test("detects checkmark responses", () => {
    expect(looksLikeResponse("✅ completed", "bob")).toBe(true);
  });

  test("rejects unrelated messages", () => {
    expect(looksLikeResponse("working on feature X", "bob")).toBe(false);
    expect(looksLikeResponse("need more info about the bug", "dev")).toBe(false);
  });
});

// --- RESTART_COOLDOWN_MS ---

describe("RESTART_COOLDOWN_MS", () => {
  test("is 5 minutes", () => {
    expect(RESTART_COOLDOWN_MS).toBe(300_000);
  });
});
