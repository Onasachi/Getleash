"use client";

import { useState } from "react";

import type { TxOutcome } from "@getleash/shared";

import { Loading, Pill, TxNote } from "@/components/ui";
import { policy } from "@/lib/chain";
import { useChain } from "@/lib/use-chain";
import { useWallet } from "@/lib/wallet";

export default function PausePage() {
  const wallet = useWallet();
  const [result, setResult] = useState<TxOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data, error: loadError, reload } = useChain(() => policy.config());
  if (!data) return <Loading error={loadError} />;
  const isOwner = wallet.accountId === data.owner_id;

  async function act(method: "pause" | "unpause") {
    setError(null);
    try {
      setResult(await wallet.ownerCall(method, {}));
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <h1>Pause {data.paused ? <Pill value="PAUSED" /> : <Pill value="OK" />}</h1>
      <p className="muted">
        Pausing stops new proposals, approvals, attempts and funding at once. Callbacks, reconciliation and withdrawals keep working. Funds already in
        settlement with NEAR Intents cannot be recalled.
      </p>
      <div className="actions">
        <button className="danger" disabled={!isOwner || data.paused} onClick={() => void act("pause")}>
          Pause everything
        </button>
        <button className="ghost" disabled={!isOwner || !data.paused} onClick={() => void act("unpause")}>
          Unpause
        </button>
      </div>
      {!isOwner && <p className="muted small">Connect the owner wallet ({data.owner_id}) to act.</p>}
      <TxNote result={result} error={error} />
    </>
  );
}
