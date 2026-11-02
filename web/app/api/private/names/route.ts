/**
 * Supplier names for the signed-in owner (id → name from the off-chain directory), so the pages can
 * say "Acme Packaging Ltd" rather than an address. Same session check as the invoices endpoint;
 * without a session (or with the private view not configured) it answers 401 and the pages show
 * addresses.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { readDirectory } from "@/lib/private-data";
import { SESSION_COOKIE, unseal } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  let session: { accountId: string; exp: number } | null = null;
  try {
    session = unseal<{ accountId: string; exp: number }>((await cookies()).get(SESSION_COOKIE)?.value);
  } catch {
    // DASHBOARD_SESSION_SECRET is not set: the private view is off on this deployment.
  }
  if (!session) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  return NextResponse.json({ names: Object.fromEntries(readDirectory().suppliers.map((s) => [s.supplier_id, s.name])) });
}
