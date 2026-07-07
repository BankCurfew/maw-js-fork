/**
 * Federation HMAC-SHA256 authentication for cross-node requests.
 *
 * Signing: HMAC-SHA256(token, "METHOD:PATH:TIMESTAMP")
 * Headers: X-Maw-Timestamp, X-Maw-Signature
 * Timestamp tolerance: ±60 seconds
 */

import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "../config";

const MAX_DRIFT_MS = 60_000;

/** Sign a request for outbound cross-node calls. */
export function signRequest(
  method: string,
  path: string,
  token: string,
): { timestamp: string; signature: string } {
  const timestamp = Date.now().toString();
  const payload = `${method}:${path}:${timestamp}`;
  const hmac = new Bun.CryptoHasher("sha256", token);
  hmac.update(payload);
  const signature = hmac.digest("hex");
  return { timestamp, signature };
}

/** Produce auth headers for outgoing federation HTTP calls. */
export function signHeaders(
  token: string,
  method: string,
  path: string,
): Record<string, string> {
  const { timestamp, signature } = signRequest(method, path, token);
  return {
    "X-Maw-Timestamp": timestamp,
    "X-Maw-Signature": signature,
  };
}

/** Verify an inbound cross-node request. Returns true if valid. */
export function verifyRequest(
  method: string,
  path: string,
  timestamp: string | null,
  signature: string | null,
): boolean {
  if (!timestamp || !signature) return false;

  const config = loadConfig();
  const token = (config as any).federationToken;
  if (!token) return false;

  // Check timestamp drift
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  const drift = Math.abs(Date.now() - ts);
  if (drift > MAX_DRIFT_MS) return false;

  // Compute expected signature
  const payload = `${method}:${path}:${timestamp}`;
  const hmac = new Bun.CryptoHasher("sha256", token);
  hmac.update(payload);
  const expected = hmac.digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

/** Hono middleware: reject unauthenticated cross-node requests. */
export function requireHmac() {
  return async (c: any, next: any) => {
    const timestamp = c.req.header("x-maw-timestamp");
    const signature = c.req.header("x-maw-signature");
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;

    if (!verifyRequest(method, path, timestamp, signature)) {
      const reason = (!timestamp || !signature) ? "missing_headers" : "verify_fail";
      console.log(`[federation-auth] 401 ${method} ${path} — ${reason}`);
      return c.json({ error: "invalid or missing HMAC signature" }, 401);
    }

    await next();
  };
}

export const federationAuth = requireHmac;
export const sign = signRequest;
