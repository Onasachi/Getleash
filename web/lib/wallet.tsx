"use client";

/**
 * The owner's wallet, through @hot-labs/near-connect. Owner methods attach exactly 1 yoctoNEAR, so
 * the wallet always asks the owner to confirm. GetLeash never sees a key.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

import { parseOutcome, type TxOutcome } from "@getleash/shared";

import { NETWORK, POLICY_ID } from "./config";

type Connector = import("@hot-labs/near-connect").NearConnector;

type WalletState = {
  accountId: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Signs an owner call with 1 yoctoNEAR attached. */
  ownerCall: (method: string, args: Record<string, unknown>, tgas?: number) => Promise<TxOutcome>;
  signMessage: (message: string, recipient: string, nonce: Uint8Array) => Promise<{ accountId: string; publicKey: string; signature: string }>;
};

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const connector = useRef<Connector | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { NearConnector } = await import("@hot-labs/near-connect");
      if (cancelled) return;
      const c = new NearConnector({ network: NETWORK, features: { signAndSendTransaction: true } });
      connector.current = c;
      c.on("wallet:signIn", (event: { accounts: Array<{ accountId: string }> }) => setAccountId(event.accounts[0]?.accountId ?? null));
      c.on("wallet:signOut", () => setAccountId(null));
      try {
        const wallet = await c.wallet();
        const accounts = await wallet.getAccounts();
        if (!cancelled) setAccountId(accounts[0]?.accountId ?? null);
      } catch {
        // not signed in
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    const wallet = await connector.current?.connect();
    const accounts = (await wallet?.getAccounts()) ?? [];
    setAccountId(accounts[0]?.accountId ?? null);
  }, []);

  const disconnect = useCallback(async () => {
    await connector.current?.disconnect();
    setAccountId(null);
  }, []);

  const ownerCall = useCallback(async (method: string, args: Record<string, unknown>, tgas = 50) => {
    if (!connector.current) throw new Error("wallet not ready");
    const wallet = await connector.current.wallet();
    const raw = await wallet.signAndSendTransaction({
      receiverId: POLICY_ID,
      actions: [{ type: "FunctionCall", params: { methodName: method, args, gas: `${tgas}000000000000`, deposit: "1" } }],
    });
    return parseOutcome(raw);
  }, []);

  const signMessage = useCallback(async (message: string, recipient: string, nonce: Uint8Array) => {
    if (!connector.current) throw new Error("wallet not ready");
    const wallet = await connector.current.wallet();
    return wallet.signMessage({ message, recipient, nonce });
  }, []);

  return <WalletContext.Provider value={{ accountId, connect, disconnect, ownerCall, signMessage }}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet outside WalletProvider");
  return value;
}
