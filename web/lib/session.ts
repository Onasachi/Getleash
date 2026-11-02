/**
 * Server-only: sealed cookies for the private view (NEP-413 sign-in by the owner). A session is
 * `base64url(payload).hmac` with DASHBOARD_SESSION_SECRET; every private endpoint checks it.
 */
import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

function secret(): Buffer {
  const hex = process.env.DASHBOARD_SESSION_SECRET;
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error("DASHBOARD_SESSION_SECRET must be 32 bytes as hex");
  return Buffer.from(hex, "hex");
}

export function seal(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function unseal<T extends { exp: number }>(token: string | undefined): T | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret()).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  return payload.exp > Date.now() ? payload : null;
}

export const SESSION_COOKIE = "gl_session";
export const CHALLENGE_COOKIE = "gl_challenge";
export const SIGN_IN_MESSAGE = "Sign in to the GetLeash private dashboard";
