"use client";

/** Pause (PLAN §4.5): one owner signature stops every new payment; the same to resume. */
import { Fold, Loading, StatusChip, TerminalOption, TxNote } from "@/components/ui";
import { policy } from "@/lib/chain";
import { nearCliCommand } from "@/lib/cli";
import { useOwnerAction } from "@/lib/owner-action";
import { useChain } from "@/lib/use-chain";

export default function PausePage() {
  const { data, error: loadError, reload } = useChain(() => policy.state());
  const { busy, result, error, run, wallet } = useOwnerAction(data?.owner_id, reload);
  if (!data) return <Loading error={loadError} />;
  const set = (paused: boolean) => void run(paused ? "pause" : "unpause", "set_paused", { paused });

  return (
    <>
      <section className="hero">
        <StatusChip label={data.paused ? "Paused" : "Payments running"} tone={data.paused ? "bad" : "good"} />
        <h1>{data.paused ? "All payments are paused" : "Pause all payments"}</h1>
        <p className="lead">
          {data.paused
            ? "Nothing new is paid until you unpause: no proposals, approvals, retries or transfers."
            : "One signature in your wallet stops every new payment at once. Use it if something looks wrong; unpausing works the same way."}
        </p>
        <div className="actions">
          {data.paused ? (
            <button className="primary" disabled={!!busy} onClick={() => set(false)}>
              {busy ? "Waiting for your wallet…" : "Unpause payments"}
            </button>
          ) : (
            <button className="primary danger" disabled={!!busy} onClick={() => set(true)}>
              {busy ? "Waiting for your wallet…" : "Pause all payments"}
            </button>
          )}
        </div>
        {!wallet.accountId && <p className="hint">You&apos;ll sign in your wallet, as {data.owner_id}.</p>}
        <TerminalOption
          command={nearCliCommand(data.owner_id, "set_paused", { paused: !data.paused }, 30)}
          owner={data.owner_id}
          open={wallet.walletId === "near-cli"}
          onCopied={() => void setTimeout(() => void reload(), 15_000)}
        />
        <TxNote result={result} error={error} />
      </section>
      <Fold summary="What keeps working while paused">
        <p className="small">
          Pausing stops new proposals, approvals, retries, cross-chain quotes and funding at once. Confirmations of transfers already sent, rejections, settling a
          stuck payment and withdrawals keep working. Money already handed to NEAR Intents for delivery cannot be recalled.
        </p>
      </Fold>
    </>
  );
}
