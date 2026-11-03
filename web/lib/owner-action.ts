"use client";

/**
 * Runs an owner action in one click: connects the wallet first if needed, checks that it is the
 * owner's account, then asks the wallet to sign. The page's data is reloaded afterwards in every
 * case, so a transaction signed outside the browser (NEAR CLI) still shows up.
 */
import { useState } from "react";

import type { TxOutcome } from "@getleash/shared";

import { useWallet } from "./wallet";

export function plainError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/wallet closed|user (rejected|cancel)|rejected by user|cancell?ed|denied/i.test(message)) return "Cancelled in the wallet.";
  return message;
}

export function useOwnerAction(ownerId: string | undefined, after?: () => Promise<unknown>) {
  const wallet = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<TxOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(label: string, method: string, args: Record<string, unknown>, tgas = 30) {
    setBusy(label);
    setError(null);
    setResult(null);
    try {
      const account = wallet.accountId ?? (await wallet.connect());
      if (!account) return;
      if (ownerId && account !== ownerId) throw new Error(`You're connected as ${account}. Only the owner, ${ownerId}, can do this.`);
      setResult(await wallet.ownerCall(method, args, tgas));
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(null);
      await after?.();
    }
  }

  return { busy, result, error, run, wallet };
}
