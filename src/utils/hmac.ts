// src/utils/hmac.ts — HMAC-SHA256 signing and verification for inter-site auth

import crypto from "crypto";

/**
 * Sign a message with HMAC-SHA256.
 * Used by approved sites to authenticate requests to ASHS.
 */
export function signHMAC(secret: string, message: string): string {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Build the canonical message for a request.
 * Format: "METHOD:path:timestamp"
 * Example: "GET:/v1/stream/movie/533535:1693958400"
 */
export function buildMessage(method: string, path: string, timestamp: number): string {
  return `${method.toUpperCase()}:${path}:${timestamp}`;
}

/**
 * Verify a request's HMAC signature.
 * Returns true if valid, false otherwise.
 * Includes replay protection (±5 minute window).
 */
export function verifyHMAC(
  secret: string,
  method: string,
  path: string,
  timestamp: number,
  signature: string
): boolean {
  // Replay protection: reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) return false;

  const expected = signHMAC(secret, buildMessage(method, path, timestamp));

  // Timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

/**
 * Generate a cryptographically random API key.
 */
export function generateApiKey(): string {
  return crypto.randomBytes(32).toString("hex");
}
