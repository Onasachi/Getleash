import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";

import { CHALLENGE_COOKIE, seal, SIGN_IN_MESSAGE } from "@/lib/session";

/** A fresh NEP-413 nonce, held in a short-lived sealed cookie. */
export async function POST(request: Request) {
  const nonce = randomBytes(32).toString("hex");
  const recipient = new URL(request.url).host;
  const response = NextResponse.json({ message: SIGN_IN_MESSAGE, recipient, nonce });
  response.cookies.set(CHALLENGE_COOKIE, seal({ nonce, recipient, exp: Date.now() + 5 * 60_000 }), {
    httpOnly: true,
    sameSite: "strict",
    secure: request.url.startsWith("https://"),
    path: "/api/auth",
    maxAge: 300,
  });
  return response;
}
