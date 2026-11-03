"use client";

/**
 * The owner's wallet, through @hot-labs/near-connect. Owner methods attach exactly 1 yoctoNEAR, so
 * the wallet always asks the owner to confirm. GetLeash never sees a key.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

import { HOT_WALLET_ID, parseOutcome, type TxOutcome } from "@getleash/shared";

import { NETWORK, POLICY_ID } from "./config";
import { inTelegram } from "./telegram";

type Connector = import("@hot-labs/near-connect").NearConnector;

type WalletState = {
  accountId: string | null;
  /** The near-connect wallet in use, e.g. "near-cli" or "meteor-wallet". */
  walletId: string | null;
  /** Opens the wallet picker (inside Telegram, HOT Wallet directly); resolves to the connected account (null if the owner closed it). */
  connect: () => Promise<string | null>;
  disconnect: () => Promise<void>;
  /** Signs an owner call with 1 yoctoNEAR attached. */
  ownerCall: (method: string, args: Record<string, unknown>, tgas?: number) => Promise<TxOutcome>;
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

  return <WalletContext.Provider value={{ accountId, walletId, connect, disconnect, ownerCall, signMessage }}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet outside WalletProvider");
  return value;
}
