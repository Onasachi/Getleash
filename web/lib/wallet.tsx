"use client";

/**
 * The owner's wallet, through @hot-labs/near-connect. Owner methods attach exactly 1 yoctoNEAR, so
 * the wallet always asks the owner to confirm. GetLeash never sees a key.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

import { HOT_WALLET_ID, parseOutcome, type TxOutcome, walletActions } from "@getleash/shared";

import { runsRelease } from "./chain";
import { HOSTED, NETWORK, POLICY_ID } from "./config";
import { inTelegram } from "./telegram";

/**
 * A link can name any contract (?c=, lib/config.ts). For one that isn't the dashboard's own, nothing is
 * signed for it until the chain shows it runs the GetLeash release: checked once, before the first signature.
 */
let genuine: Promise<boolean> | null = null;
async function assertGenuine(receivers: readonly string[]) {
  if (!HOSTED || !receivers.includes(POLICY_ID)) return;
  genuine ??= runsRelease(POLICY_ID).catch((error: unknown) => {
    genuine = null;
    throw error;
  });
  if (!(await genuine)) throw new Error(`${POLICY_ID} doesn't run the GetLeash release, so this page signs nothing for it.`);
}

type Connector = import("@hot-labs/near-connect").NearConnector;

/** One function call, as its own transaction. */
export type Call = { receiverId: string; method: string; args: Record<string, unknown>; tgas: number; deposit: string };

/** A whole transaction in near-connect's action format (the setup page's: accounts, keys, the contract). */
export type WalletTransaction = { receiverId: string; actions: ReturnType<typeof walletActions> };

const functionCall = (c: Pick<Call, "method" | "args" | "tgas" | "deposit">) => ({
  type: "FunctionCall" as const,
  params: { methodName: c.method, args: c.args, gas: `${c.tgas}000000000000`, deposit: c.deposit },
});

type WalletState = {
  accountId: string | null;
  /** The near-connect wallet in use, e.g. "near-cli" or "meteor-wallet". */
  walletId: string | null;
  /** Opens the wallet picker (inside Telegram, HOT Wallet directly); resolves to the connected account (null if the owner closed it). */
  connect: () => Promise<string | null>;
  disconnect: () => Promise<void>;
  /** Signs an owner call with 1 yoctoNEAR attached. */
  ownerCall: (method: string, args: Record<string, unknown>, tgas?: number) => Promise<TxOutcome>;
  /** Signs several calls with one confirmation where the wallet can, else one after another; outcomes in order. */
  sendCalls: (calls: readonly Call[]) => Promise<TxOutcome[]>;
  /** The same for whole transactions; `onEach` hears each outcome as it comes when they go one by one. */
  sendTransactions: (transactions: readonly WalletTransaction[], onEach?: (done: number) => void) => Promise<TxOutcome[]>;
  signMessage: (message: string, recipient: string, nonce: Uint8Array) => Promise<{ accountId: string; publicKey: string; signature: string }>;
};

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const connector = useRef<Connector | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { NearConnector } = await import("@hot-labs/near-connect");
      if (cancelled) return;
      const c = new NearConnector({ network: NETWORK, features: { signAndSendTransaction: true } });
      connector.current = c;
      c.on("wallet:signIn", (event: { accounts: Array<{ accountId: string }> }) => {
        setAccountId(event.accounts[0]?.accountId ?? null);
        void c.wallet().then((w) => setWalletId(w.manifest.id), () => undefined);
      });
      c.on("wallet:signOut", () => {
        setAccountId(null);
        setWalletId(null);
      });
      try {
        const wallet = await c.wallet();
        const accounts = await wallet.getAccounts();
        if (!cancelled) {
          setAccountId(accounts[0]?.accountId ?? null);
          setWalletId(wallet.manifest.id);
        }
      } catch {
        // not signed in
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    const c = connector.current;
    if (!c) return null;
    // Inside Telegram only HOT Wallet runs in Telegram itself (near-connect routes it there), so the
    // list of wallets is skipped. Elsewhere the owner picks any wallet.
    await c.whenManifestLoaded.catch(() => undefined);
    const hot = inTelegram() && c.availableWallets.some((w) => w.manifest.id === HOT_WALLET_ID);
    const wallet = await c.connect(hot ? { walletId: HOT_WALLET_ID } : {});
    const accounts = await wallet.getAccounts();
    const account = accounts[0]?.accountId ?? null;
    setAccountId(account);
    setWalletId(wallet.manifest.id);
    return account;
  }, []);

  const disconnect = useCallback(async () => {
    await connector.current?.disconnect();
    setAccountId(null);
    setWalletId(null);
  }, []);

  const ownerCall = useCallback(async (method: string, args: Record<string, unknown>, tgas = 30) => {
    if (!connector.current) throw new Error("wallet not ready");
    await assertGenuine([POLICY_ID]);
    const wallet = await connector.current.wallet();
    const raw = await wallet.signAndSendTransaction({ receiverId: POLICY_ID, actions: [functionCall({ method, args, tgas, deposit: "1" })] });
    return parseOutcome(raw);
  }, []);

  const sendTransactions = useCallback(async (transactions: readonly WalletTransaction[], onEach?: (done: number) => void) => {
    if (!connector.current) throw new Error("wallet not ready");
    const wallet = await connector.current.wallet();
    const list = transactions.map((t) => ({ receiverId: t.receiverId, actions: [...t.actions] }));
    if (list.length > 1 && wallet.manifest.features?.signAndSendTransactions) {
      return (await wallet.signAndSendTransactions({ transactions: list })).map((raw) => parseOutcome(raw));
    }
    const outcomes: TxOutcome[] = [];
    for (const transaction of list) {
      const outcome = parseOutcome(await wallet.signAndSendTransaction(transaction));
      outcomes.push(outcome);
      onEach?.(outcomes.length);
      if (!outcome.ok) break; // the rest would build on this one
    }
    return outcomes;
  }, []);

  const sendCalls = useCallback(
    async (calls: readonly Call[]) => {
      await assertGenuine(calls.map((c) => c.receiverId));
      return sendTransactions(calls.map((c) => ({ receiverId: c.receiverId, actions: [functionCall(c)] as WalletTransaction["actions"] })));
    },
    [sendTransactions],
  );

  const signMessage = useCallback(async (message: string, recipient: string, nonce: Uint8Array) => {
    if (!connector.current) throw new Error("wallet not ready");
    const wallet = await connector.current.wallet();
    return wallet.signMessage({ message, recipient, nonce });
  }, []);

  return <WalletContext.Provider value={{ accountId, walletId, connect, disconnect, ownerCall, sendCalls, sendTransactions, signMessage }}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet outside WalletProvider");
  return value;
}
