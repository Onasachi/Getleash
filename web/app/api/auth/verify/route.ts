import { NextResponse } from "next/server";
import { verifyMessage } from "near-api-js/nep413";
import { z } from "zod";

import { PolicyView, provider } from "@getleash/shared";

import { POLICY_ID, RPC_URL } from "@/lib/config";
import { CHALLENGE_COOKIE, seal, SESSION_COOKIE, SIGN_IN_MESSAGE, unseal } from "@/lib/session";

const Body = z.object({ accountId: z.string().min(2).max(64), publicKey: z.string().startsWith("ed25519:"), signature: z.string().min(10).max(200) });

/** Verifies the owner's NEP-413 signature (full-access key of the contract's owner) and opens a session. */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const cookie = request.headers.get("cookie")?.match(new RegExp(`${CHALLENGE_COOKIE}=([^;]+)`))?.[1];
  const challenge = unseal<{ nonce: string; recipient: string; exp: number }>(cookie ? decodeURIComponent(cookie) : undefined);
  if (!challenge) return NextResponse.json({ error: "challenge expired" }, { status: 401 });

  const rpc = provider(RPC_URL);
  const { owner_id } = await new PolicyView(rpc, POLICY_ID).config();
  if (parsed.data.accountId !== owner_id) return NextResponse.json({ error: "only the contract's owner can sign in" }, { status: 403 });
  try {
    await verifyMessage({
      signerAccountId: parsed.data.accountId,
      signerPublicKey: parsed.data.publicKey,
      signature: new Uint8Array(Buffer.from(parsed.data.signature, "base64")),
      payload: { message: SIGN_IN_MESSAGE, recipient: challenge.recipient, nonce: new Uint8Array(Buffer.from(challenge.nonce, "hex")) },
      provider: rpc,
    });
  } catch (error) {
    return NextResponse.json({ error: `signature rejected: ${(error as Error).message}` }, { status: 401 });
  }
  const response = NextResponse.json({ accountId: owner_id });
  response.cookies.set(SESSION_COOKIE, seal({ accountId: owner_id, exp: Date.now() + 8 * 3_600_000 }), {
    httpOnly: true,
    sameSite: "strict",
    secure: request.url.startsWith("https://"),
    path: "/",
    maxAge: 8 * 3600,
  });
  response.cookies.delete(CHALLENGE_COOKIE);
  return response;
}
