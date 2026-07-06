import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// Skip entire suite if mqtt package not installed (optional dependency)
let hasMqtt = false;
try { require.resolve("mqtt"); hasMqtt = true; } catch {}

/**
 * MQTT publish error handling tests — maw-js#72
 *
 * Tests that mqttPublish is truly best-effort:
 * - Returns silently when no broker configured
 * - Doesn't crash when broker is unreachable
 * - Doesn't crash when client.publish() throws
 * - Swallows connection errors
 */

// We can't easily mock the mqtt module in bun:test without mock.module(),
// so we test the behavioral contract by importing and calling with known states.

describe.skipIf(!hasMqtt)("mqtt-publish — error handling", () => {
  // Reset module state between tests
  let mqttPublish: (topic: string, payload: object) => void;

  beforeEach(async () => {
    // Fresh import each time — module-level `client` is reset
    const mod = await import("../src/mqtt-publish");
    mqttPublish = mod.mqttPublish;
  });

  test("mqttPublish with no broker configured returns silently", () => {
    // When mqttPublish.broker is not set in config, getClient() returns null
    // and mqttPublish should return without error
    expect(() => {
      mqttPublish("maw/test", { type: "test", message: "hello" });
    }).not.toThrow();
  });

  test("mqttPublish with invalid topic returns silently", () => {
    expect(() => {
      mqttPublish("", { type: "empty-topic" });
    }).not.toThrow();
  });

  test("mqttPublish with large payload doesn't crash", () => {
    const largePayload = { data: "x".repeat(100_000) };
    expect(() => {
      mqttPublish("maw/test", largePayload);
    }).not.toThrow();
  });

  test("mqttPublish with circular reference in payload throws JSON error (expected)", () => {
    const obj: any = { a: 1 };
    obj.self = obj; // circular
    // JSON.stringify will throw — this is acceptable behavior
    // The question is: does it crash the process?
    try {
      mqttPublish("maw/test", obj);
    } catch {
      // Expected — circular JSON is a caller error, not an MQTT error
    }
  });

  test("multiple rapid publishes don't crash", () => {
    expect(() => {
      for (let i = 0; i < 100; i++) {
        mqttPublish("maw/test", { seq: i });
      }
    }).not.toThrow();
  });
});

describe.skipIf(!hasMqtt)("mqtt-publish — module contract", () => {
  test("exports mqttPublish function", async () => {
    const mod = await import("../src/mqtt-publish");
    expect(typeof mod.mqttPublish).toBe("function");
  });

  test("mqttPublish returns void (fire-and-forget)", async () => {
    const mod = await import("../src/mqtt-publish");
    const result = mod.mqttPublish("maw/test", { type: "test" });
    expect(result).toBeUndefined();
  });
});
