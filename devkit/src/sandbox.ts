/**
 * A local NEAR node with the GetLeash contracts, for tests and the offline demo.
 *
 * Accounts are genesis accounts with fresh keys: `biz.near` (the owner), `usdc.near` (a NEP-141
 * mock of USDC, 6 decimals), suppliers and a 1Click stand-in. The policy contract itself is set up
 * with the same `setup.ts` functions the real CLI uses.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Account, actions, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { GenesisAccount, Sandbox } from "near-sandbox";

import {
  FACTORY_ID,
  FACTORY_WASM,
  near,
  nearApiActions,
  parseOutcome,
  RELEASE_WASM_SHA256,
  releaseStoreTransaction,
  sha256Hex,
  tgas,
} from "@getleash/shared";

import { MOCK_FT_WASM, POLICY_WASM, RELEASE_WASM, REPO_ROOT } from "./paths.ts";

export { MOCK_FT_WASM, POLICY_WASM, RELEASE_WASM, REPO_ROOT };

export const USDC = 1_000_000n;

/**
 * Loads the policy wasm (the committed release, checked against its published sha256, unless
 * GETLEASH_POLICY_WASM names another build) and the mock USDC token, which it builds with cargo-near the
 * first time.
 */
export function ensureWasm(): { policy: Uint8Array; mockFt: Uint8Array } {
  if (!existsSync(MOCK_FT_WASM)) {
    const dir = join(REPO_ROOT, "contract/tests/mock-ft");
    const result = spawnSync("cargo", ["near", "build", "non-reproducible-wasm", "--no-abi"], { cwd: dir, stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(`cargo near build failed in ${dir} (the error is above); cargo-near must be installed, see README "Run it locally"`);
    }
  }
  if (!existsSync(POLICY_WASM)) {
    throw new Error(
      POLICY_WASM === RELEASE_WASM
        ? `${RELEASE_WASM} is missing: restore it with \`git checkout -- contract/release\``
        : `GETLEASH_POLICY_WASM=${POLICY_WASM} does not exist: build it first (\`cd contract && cargo near build non-reproducible-wasm --no-embed-abi\`)`,
    );
  }
  const policy = readFileSync(POLICY_WASM);
  if (POLICY_WASM === RELEASE_WASM && sha256Hex(policy) !== RELEASE_WASM_SHA256) {
    throw new Error(`${RELEASE_WASM} has sha256 ${sha256Hex(policy)}, not the release's ${RELEASE_WASM_SHA256}`);
  }
  return { policy, mockFt: readFileSync(MOCK_FT_WASM) };
}

export type DevAccount = { id: string; privateKey: string; publicKey: string; account: Account };

export type Devnet = {
  sandbox: Sandbox;
  rpcUrl: string;
  rpc: JsonRpcProvider;
  owner: DevAccount;
  token: DevAccount;
  accounts: Record<string, DevAccount>;
  /** Another signer for an existing account (for example to try a key the account does not hold). */
  as(accountId: string, privateKey: string): Account;
  ftBalance(accountId: string): Promise<bigint>;
  stop(): Promise<void>;
};

export type DevnetOptions = {
  owner?: string;
  token?: string;
  /** Extra genesis accounts (suppliers, 1Click stand-in, attackers). */
  extra?: string[];
  /** Token supply minted to the owner, in base units. */
  supply?: bigint;
};

export async function startDevnet(opts: DevnetOptions = {}): Promise<Devnet> {
  const ownerId = opts.owner ?? "biz.near";
  const tokenId = opts.token ?? "usdc.near";
  const names = [ownerId, tokenId, ...(opts.extra ?? ["acme.near", "oneclick.near", "mallory.near"])];
  const keys = new Map(names.map((name) => [name, KeyPair.fromRandom("ed25519")]));
  // Build or load the wasm before starting the node, so a build failure leaves no process behind.
  const { mockFt } = ensureWasm();

  const sandbox = await Sandbox.start({
    config: {
      additionalAccounts: names.map(
        (name) =>
          new GenesisAccount(
            name,
            keys.get(name)!.getPublicKey().toString(),
            keys.get(name)!.toString(),
            near("1000"),
          ),
      ),
    },
  });
  try {
    return await setUp(sandbox, keys, ownerId, tokenId, mockFt, opts.supply);
  } catch (error) {
    await sandbox.tearDown();
    throw error;
  }
}

async function setUp(
  sandbox: Sandbox,
  keys: Map<string, KeyPair>,
  ownerId: string,
  tokenId: string,
  mockFt: Uint8Array,
  supply: bigint | undefined,
): Promise<Devnet> {
  const rpc = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const accounts: Record<string, DevAccount> = {};
  for (const [name, keyPair] of keys) {
    accounts[name] = {
      id: name,
      privateKey: keyPair.toString(),
      publicKey: keyPair.getPublicKey().toString(),
      account: new Account(name, rpc, new KeyPairSigner(keyPair)),
    };
  }

  const token = accounts[tokenId]!;
  const deployed = parseOutcome(
    await token.account.signAndSendTransaction({
      receiverId: tokenId,
      actions: [
        actions.deployContract(mockFt),
        actions.functionCall(
          "new",
          { owner_id: ownerId, total_supply: (supply ?? 1_000_000n * USDC).toString() },
          tgas(50),
          0n,
        ),
      ],
      throwOnFailure: false,
    }),
  );
  if (!deployed.ok) throw new Error(`mock token deploy failed: ${JSON.stringify(deployed.failures)}`);

  return {
    sandbox,
    rpcUrl: sandbox.rpcUrl,
    rpc,
    owner: accounts[ownerId]!,
    token,
    accounts,
    as: (accountId, privateKey) =>
      new Account(accountId, rpc, KeyPairSigner.fromSecretKey(privateKey as KeyPairString)),
    ftBalance: async (accountId) => {
      const value = await rpc.callFunction({ contractId: tokenId, method: "ft_balance_of", args: { account_id: accountId } });
      return BigInt(value as string);
    },
    stop: () => sandbox.tearDown(),
  };
}

/**
 * GetLeash's release store, as the operator publishes it (D-31): under the operator's account, which this
 * devnet must have (the installer is built for release-8eaccbf1.onanikes.near).
 */
export async function publishStore(net: Devnet): Promise<void> {
  const tx = releaseStoreTransaction(ensureWasm().policy);
  const operator = net.accounts[tx.receiverId.slice(tx.receiverId.indexOf(".") + 1)];
  if (!operator) throw new Error(`the devnet needs the operator's account to publish ${tx.receiverId}`);
  const outcome = parseOutcome(await operator.account.signAndSendTransaction({ receiverId: tx.receiverId, actions: nearApiActions(tx.actions), throwOnFailure: false }));
  if (!outcome.ok) throw new Error(`release store: ${JSON.stringify(outcome.failures)}`);
}

/** GetLeash's factory, as the operator publishes it (D-32): its code at FACTORY_ID, then its only key deleted. */
export async function publishFactory(net: Devnet): Promise<void> {
  const factory = net.accounts[FACTORY_ID];
  if (!factory) throw new Error(`the devnet needs ${FACTORY_ID} to publish the factory`);
  const key = KeyPair.fromString(factory.privateKey as KeyPairString).getPublicKey();
  const outcome = parseOutcome(
    await factory.account.signAndSendTransaction({ receiverId: FACTORY_ID, actions: [actions.deployContract(FACTORY_WASM), actions.deleteKey(key)], throwOnFailure: false }),
  );
  if (!outcome.finalOk) throw new Error(`factory: ${JSON.stringify(outcome.failures)}`);
}
