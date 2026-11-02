/**
 * Private data for the signed-in owner: supplier names from the off-chain directory and the
 * decrypted invoice records (extraction, decision, outcome, verification badge and checks).
 * Available only where the services' data directory is (self-hosted). Every request checks the
 * session.
 */
import { resolve } from "node:path";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { InvoiceStore, parseStoreKey } from "@getleash/agent/store";

import { dataBase, readDirectory } from "@/lib/private-data";
import { SESSION_COOKIE, unseal } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = unseal<{ accountId: string; exp: number }>((await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  // The services' data directory on this (self-hosted) machine; read at request time only.
  const base = dataBase();
  const directory = readDirectory();
  let invoices: unknown[] = [];
  if (process.env.INVOICE_STORE_KEY) {
    try {
      const store = new InvoiceStore(resolve(base, "invoices"), parseStoreKey(process.env.INVOICE_STORE_KEY));
      invoices = store
        .keys()
        .map((key) => store.get(key))
        .filter((r) => r !== null)
        .map(({ files, ...record }) => ({ ...record, files: files.map((f) => ({ kind: f.kind, name: f.name, bytes: Math.floor((f.base64.length * 3) / 4) })) }))
        .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
    } catch (error) {
      return NextResponse.json({ error: `invoice store: ${(error as Error).message}` }, { status: 500 });
    }
  }
  return NextResponse.json({ accountId: session.accountId, directory: directory.suppliers, invoices });
}
