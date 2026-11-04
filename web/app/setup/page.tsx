"use client";

/**
 * Sets up GetLeash for a business (docs/decisions.md D-30): the page the bot's "Set up GetLeash" button
 * opens inside Telegram. Its link carries the public halves of the two keys the bot generated for this
 * business (its agent's and its executor's), when it expires, the Telegram account it is for (as the bot
 * saw it at /start: a Mini App opened from a keyboard button gets no user data from Telegram) and the
 * bot's username, all signed by the bot with the agent key of the dashboard's own GetLeash. The page reads
 * that agent's keys from the chain and refuses a link they didn't sign, so a fake bot can't hand out links
 * with keys of its own or send the last step anywhere but the real bot. The owner's own wallet signs
 * everything here, with the same transactions as the setup CLI (shared/src/setup.ts):
 *   1. agent-1.<owner> and executor-1.<owner>, each holding only its key, limited to this contract and to
 *      its role's methods;
 *   2. getleash.<owner>: created, funded and given the installer in one transaction, with no access key,
 *      owned by the owner's account (D-31). The installer copies the published release from GetLeash's
 *      release store on NEAR, deploys it only if its SHA-256 is the release's, and initialises it with the
 *      owner's arguments; the page checks the store holds the release before anything is signed. (A wallet
 *      request can't carry the release itself: HOT Wallet's connector would take hours to encode it.)
 *      A contract left with the installer can be cancelled here: it is deleted and its NEAR goes back;
 *   3. its registration on USDC, so it can hold the treasury.
 * Steps already on the chain are skipped, so the page carries on where it stopped. First, before anything
 * is paid, the wallet signs a claim (NEP-413) naming the contract, the agent key and the Telegram account;
 * its nonce is the SHA-256 of a finish code the page keeps to itself. The page checks that claim as the
 * bot will, and only then asks for the setup. Finish then does two things: it opens the real bot's chat
 * with the code (`t.me/<bot>?start=finish_<code>`, where the user taps START, so the code comes from this
 * Telegram account, straight from Telegram), and sends the claim to the bot that opened the page
 * (Telegram's sendData). The bot serves the business only when both came from the account the setup is
 * for. A wallet that already owns a GetLeash whose role accounts hold other keys gets "connect" instead:
 * the same two steps move that GetLeash, if this service serves it, to this Telegram account.
 */
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import {
  abandonTransaction,
  accountExists,
  AGENT_METHODS,
  bytesToHex,
  canHostUnder,
  checkSetupClaim,
  type ClaimKind,
  codeSha256,
  DEFAULT_POLICY,
  defaultRoleIds,
  durationText,
  ED25519_PUBLIC_KEY,
  EXECUTOR_METHODS,
  FINISH_PREFIX,
  finishCodeText,
  finishNonce,
  FT_STORAGE_DEPOSIT,
  hexToBytes,
  HOSTED_ROLES,
  hostedSetupPlan,
  installerPolicyTransaction,
  isInstallerCode,
  money,
  newFinishCode,
  nearRoundedDown,
  nearRoundedUp,
  PolicyView,
  RELEASE_STORE_ID,
  RELEASE_WASM_BYTES,
  RELEASE_WASM_SHA256,
  roleAccountTransaction,
  SETUP_CLAIM_RECIPIENT,
  SETUP_GAS,
  type SetupClaim,
  setupClaimMessage,
  type SetupLink,
  setupLinkSigned,
  type SetupTransaction,
  signingReserve,
  storeHoldsRelease,
  suggestedPolicyBalance,
  treasuryTransaction,
  walletActions,
} from "@getleash/shared";

import { Check, Loading, StatusChip } from "@/components/ui";
import { homePolicy, rpc, runsRelease } from "@/lib/chain";
import { EXPLORER } from "@/lib/config";
import { plainError } from "@/lib/owner-action";
import { inTelegramClient, openTelegramLink, sendDataToBot, telegramVersion, versionAtLeast } from "@/lib/telegram";
import { useChain } from "@/lib/use-chain";
import { useWallet } from "@/lib/wallet";

type KeyView = { public_key: string; access_key: { permission: unknown } };
/**
 * done: on the chain as GetLeash needs it; todo: still to create; taken: the account exists, but as
 * something else; installing: the contract exists with the installer, which hasn't installed the release (D-31).
 */
type StepState = "done" | "todo" | "taken" | "installing";

const YOCTO_PER_BYTE = 10n ** 19n;
let storeChecked: Promise<boolean> | null = null;

/** Whether GetLeash's release store holds the release the installer copies (asked again after a no). */
function storeReady(): Promise<boolean> {
  storeChecked ??= storeHoldsRelease(rpc).then(
    (ready) => {
      if (!ready) storeChecked = null;
      return ready;
    },
    (error: unknown) => {
      storeChecked = null;
      throw error;
    },
  );
  return storeChecked;
}

/** Whether the bot signed this link: with a key of the agent the dashboard's own GetLeash names (read from the chain, not the link). */
async function linkGenuine(link: SetupLink, signature: string): Promise<boolean> {
  const home = await homePolicy.state();
  const { keys } = (await rpc.viewAccessKeyList({ accountId: home.agent_id })) as unknown as { keys: KeyView[] };
  return setupLinkSigned(link, signature, keys.map((k) => k.public_key));
}

async function roleState(accountId: string, publicKey: string, policyId: string, methods: readonly string[]): Promise<StepState> {
  if (!(await accountExists(rpc, accountId))) return "todo";
  const { keys } = (await rpc.viewAccessKeyList({ accountId })) as unknown as { keys: KeyView[] };
  const fc = keys.length === 1 && keys[0]!.public_key === publicKey ? (keys[0]!.access_key.permission as { FunctionCall?: { receiver_id: string; method_names: string[] } }).FunctionCall : undefined;
  const same = !!fc && fc.receiver_id === policyId && [...fc.method_names].sort().join() === [...methods].sort().join();
  return same ? "done" : "taken";
}

async function contractState(policyId: string, owner: string, agentId: string, executorId: string): Promise<StepState> {
  if (!(await accountExists(rpc, policyId))) return "todo";
  // Only the owner can create getleash.<owner>, and the installer can't add a key, so this one is theirs.
  if (isInstallerCode(await codeSha256(rpc, policyId))) return "installing";
  try {
    const [state, genuine, keys] = await Promise.all([
      new PolicyView(rpc, policyId).state(),
      runsRelease(policyId),
      rpc.viewAccessKeyList({ accountId: policyId }) as unknown as Promise<{ keys: KeyView[] }>,
    ]);
    const ours = genuine && keys.keys.length === 0 && state.owner_id === owner && state.agent_id === agentId && state.executor_id === executorId;
    return ours ? "done" : "taken";
  } catch {
    return "taken"; // an account with other code, or none
  }
}

async function load(owner: string | null, agentKey: string, executorKey: string) {
  const home = await homePolicy.state();
  if (!owner || !canHostUnder(owner)) return { home, owner, steps: null };
  const ids = defaultRoleIds(owner);
  const [agent, executor, contract, account] = await Promise.all([
    roleState(ids.agentId, agentKey, ids.policyId, AGENT_METHODS),
    roleState(ids.executorId, executorKey, ids.policyId, EXECUTOR_METHODS),
    contractState(ids.policyId, owner, ids.agentId, ids.executorId),
    rpc.viewAccount({ accountId: owner }) as unknown as Promise<{ amount: string; storage_usage: number }>,
  ]);
  const balance = await rpc.callFunction({ contractId: home.token_id, method: "storage_balance_of", args: { account_id: ids.policyId } });
  const registered: StepState = balance != null ? "done" : "todo";
  // What the owner can spend: the balance less what its own storage keeps locked (a small account may
  // keep less than that, NEP-448, so this never counts below zero).
  const spare = BigInt(account.amount) - BigInt(account.storage_usage) * YOCTO_PER_BYTE;
  const available = spare > 0n ? spare : 0n;
  return { home, owner, ids, steps: { agent, executor, contract, registered }, available };
}

export default function SetupPage() {
  return (
    <Suspense fallback={<Loading error={null} />}>
      <Setup />
    </Suspense>
  );
}

function Setup() {
  const params = useSearchParams();
  const agentKey = params.get("agent") ?? "";
  const executorKey = params.get("executor") ?? "";
  const until = Number(params.get("until") ?? "0");
  const keysOk = ED25519_PUBLIC_KEY.test(agentKey) && ED25519_PUBLIC_KEY.test(executorKey) && agentKey !== executorKey;
  // The Telegram account this setup is for, as the bot recorded it, and the bot: both signed by the bot (checked below).
  const forUser = params.get("for") ?? "";
  const forName = params.get("name") ?? "";
  const bot = params.get("bot") ?? "";
  const sig = params.get("sig") ?? "";
  // Read in the browser only (this renders under Suspense, after the prerendered fallback).
  const [inApp] = useState(() => inTelegramClient());
  const [version] = useState(() => telegramVersion());
  const tg =
    inApp && /^\d{1,20}$/.test(forUser) && forName.trim().length > 0 && forName.length <= 140 && /^[A-Za-z0-9_]{5,32}$/.test(bot) && sig.length > 0
      ? { id: forUser, name: forName, bot }
      : null;
  const [now] = useState(() => Date.now());
  /** The finish code: its SHA-256 is the claim's nonce, and only the real bot's chat ever sees it (Finish). */
  const [code] = useState(() => newFinishCode());
  const link: SetupLink = { agent: agentKey, executor: executorKey, until, user: forUser, name: forName, bot };
  const { data: genuine, error: linkError } = useChain(() => (keysOk && tg ? linkGenuine(link, sig) : Promise.resolve(false)), [agentKey, executorKey, until, forUser, forName, bot, sig, tg ? 1 : 0]);
  const wallet = useWallet();
  const owner = wallet.accountId;
  const { data, error: loadError, reload } = useChain(() => load(owner, agentKey, executorKey), [owner ?? "", agentKey, executorKey]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  /** A setup transaction the chain refused: which account it was for, and why. */
  const [failure, setFailure] = useState<{ receiver: string; reasons: string } | null>(null);
  /** The owner's signed claim, kept until the bot has it. */
  const [claim, setClaim] = useState<SetupClaim | null>(null);

  const steps = data?.steps ?? null;
  const ready = !!steps && Object.values(steps).every((s) => s === "done");

  const installing = steps?.contract === "installing";

  // After signing, and while the installer is at work, the chain is read again until everything shows up
  // (blocks take a moment to reach the RPC).
  useEffect(() => {
    if ((!sent && !installing) || ready) return;
    const timer = setInterval(() => void reload(), 3_000);
    const stop = setTimeout(() => clearInterval(timer), 90_000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [sent, installing, ready, reload]);

  if (!keysOk || !tg) {
    return (
      <section className="hero">
        <StatusChip label="Set up GetLeash" tone="plain" />
        <h1>Open this from the GetLeash bot</h1>
        <p className="lead">
          In Telegram, send /start to the GetLeash bot and tap &ldquo;Set up GetLeash&rdquo; under the message box. This page works only from that button, inside
          Telegram: the button is yours, and the setup is yours.
        </p>
      </section>
    );
  }
  if (until <= now) {
    return (
      <section className="hero">
        <StatusChip label="Expired" tone="warn" />
        <h1>This setup link has expired</h1>
        <p className="lead">Send /start to the GetLeash bot again: it gives you a fresh button. Nothing was signed.</p>
      </section>
    );
  }
  // Still checking the link's signature (or NEAR can't be reached: Loading shows why).
  if (genuine === null) return <Loading error={linkError} />;
  if (!genuine) {
    return (
      <section className="hero">
        <StatusChip label="Can't set up" tone="bad" />
        <h1>This setup link isn&apos;t from GetLeash</h1>
        <p className="lead">
          GetLeash signs every setup link it makes, and this one doesn&apos;t carry its signature, so nothing here will be signed. If a bot sent you here, it isn&apos;t
          GetLeash&apos;s. Send /start to the GetLeash bot for your own link.
        </p>
      </section>
    );
  }
  if (version && !versionAtLeast(version, "7.0")) {
    return (
      <section className="hero">
        <StatusChip label="Update Telegram" tone="warn" />
        <h1>Update Telegram to set up GetLeash</h1>
        <p className="lead">The last step opens the GetLeash chat from this page, which this version of Telegram can&apos;t do. Update the app, then tap the button again.</p>
      </section>
    );
  }
  if (!data || (data.owner ?? null) !== (owner ?? null)) return <Loading error={loadError} />;
  const p = DEFAULT_POLICY;
  const d = data.home.token_decimals;

  /**
   * The wallet signs the claim: this setup (or, for "connect", its existing GetLeash), under this account,
   * for this Telegram account, with the finish code's SHA-256 as the nonce. No transaction, no cost. It is
   * checked here exactly as the bot will check it, so a wallet whose signature the bot would refuse stops
   * before anything is paid.
   */
  async function signClaim(account: string, kind: ClaimKind): Promise<SetupClaim> {
    if (claim && claim.owner === account && claim.kind === kind) return claim;
    const expected = { agentPublicKey: agentKey, telegramUser: tg!.id, telegramName: tg!.name };
    const nonce = hexToBytes(finishNonce(code));
    const signed = await wallet.signMessage(setupClaimMessage({ kind, ownerId: account, ...expected }), SETUP_CLAIM_RECIPIENT, nonce);
    if (signed.accountId !== account) throw new Error(`Your wallet signed as ${signed.accountId}, not ${account}. Nothing was paid.`);
    const made: SetupClaim = { kind, owner: account, publicKey: String(signed.publicKey), signature: String(signed.signature), nonce: bytesToHex(nonce) };
    if ((await checkSetupClaim(rpc, made, expected)) !== "ok") {
      throw new Error(
        `Your wallet's signature isn't one GetLeash can check (NEP-413, with a full-access key of ${account}), so nothing was paid. Try another wallet, or tell the GetLeash team which wallet you use.`,
      );
    }
    setClaim(made);
    return made;
  }

  /**
   * The last step. The finish code goes to the real bot's chat (the bot named in the signed link), from
   * this Telegram account: Telegram opens that chat with START. The claim goes to the bot that opened this
   * page, which closes it. Both in one go: Telegram keeps a Mini App open while it opens a chat (Bot API 7.0+).
   */
  async function finish(kind: ClaimKind) {
    setBusy("Confirm in your wallet…");
    setError(null);
    try {
      const made = await signClaim(owner!, kind);
      setBusy(null);
      openTelegramLink(`https://t.me/${tg!.bot}?start=${FINISH_PREFIX}${finishCodeText(code)}`);
      sendDataToBot(JSON.stringify(made));
    } catch (e) {
      setError(plainError(e));
      setBusy(null);
    }
  }

  /** Deletes a contract the installer hasn't finished (it can't be done after): its NEAR goes back to the owner's wallet. */
  async function cancel(policyId: string) {
    setBusy("Confirm in your wallet…");
    setError(null);
    try {
      const tx = abandonTransaction(policyId);
      const [outcome] = await wallet.sendTransactions([{ receiverId: tx.receiverId, actions: walletActions(tx.actions) }]);
      const reasons = outcome?.failures.map((f) => f.panic ?? f.message).join("; ") ?? "";
      // Installed in the meantime: there is no installer to cancel any more, and the page shows it ready.
      if (outcome && !outcome.ok && !/MethodNotFound|MethodResolveError/.test(reasons)) throw new Error(`It wasn't cancelled: ${reasons}`);
      setSent(false);
      setFailure(null);
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(null);
      await reload();
    }
  }

  if (!owner) {
    return (
      <section className="hero">
        <StatusChip label="Set up GetLeash" tone="plain" />
        <h1>Set up GetLeash for your business</h1>
        <p className="lead">
          Your wallet creates your own GetLeash on NEAR: a contract that holds your USDC, has no keys, and pays only the suppliers you add, within your limits. Only
          your wallet can change it.
        </p>
        <p className="notice small">
          This setup is for the Telegram account <strong>{tg.name}</strong>. Continue only if that account is yours: whoever holds it will run this GetLeash in
          Telegram.
        </p>
        <div className="actions">
          <button className="primary" disabled={busy !== null} onClick={() => void wallet.connect().catch((e: unknown) => setError(plainError(e)))}>
            Connect your wallet
          </button>
        </div>
        <p className="hint">HOT Wallet opens here in Telegram. Connecting signs nothing.</p>
        {error && <p className="error">{error}</p>}
      </section>
    );
  }

  if (!steps || !data.ids) {
    return (
      <section className="hero">
        <StatusChip label="Can't set up" tone="bad" />
        <h1>This account can&apos;t hold GetLeash</h1>
        <p className="lead">
          GetLeash creates its accounts under yours (getleash.<span className="mono">your-account</span>), and <span className="mono">{owner}</span> can&apos;t have any:
          you need a named NEAR account, like acme.near or acme.tg. Create one in your wallet, then connect it here.
        </p>
        <div className="actions">
          <button className="ghost" onClick={() => void wallet.disconnect()}>
            Use another account
          </button>
        </div>
      </section>
    );
  }

  const { ids } = data;
  // Created with the installer, which hasn't installed the release yet (D-31): usually seconds away, unless
  // this page saw the contract's batch fail after the account was made.
  const stuck = failure?.receiver === ids.policyId ? failure.reasons : null;
  if (installing) {
    return (
      <section className="hero">
        <StatusChip label="Almost there" tone="warn" />
        <h1>Your contract is waiting for its code</h1>
        {stuck ? (
          <p className="lead">
            <span className="mono">{ids.policyId}</span> exists, with no keys, owned by your wallet, but the GetLeash code didn&apos;t install ({stuck}), and nothing more is
            on its way. Cancel it: your wallet deletes it and its NEAR goes back to <span className="mono">{owner}</span>. Then you can set it up again.
          </p>
        ) : (
          <>
            <p className="lead">
              <span className="mono">{ids.policyId}</span> exists, with no keys, owned by your wallet, but the GetLeash code isn&apos;t in it yet. That usually takes a few
              seconds, and this page checks again.
            </p>
            <p className="lead small">
              If it stays like this, cancel it: your wallet deletes it and its NEAR goes back to <span className="mono">{owner}</span>. Then you can set it up again.
            </p>
          </>
        )}
        <div className="actions">
          <button className="ghost" disabled={busy !== null} onClick={() => void cancel(ids.policyId)}>
            {busy ?? "Cancel it and get the NEAR back"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>
    );
  }
  // Their GetLeash already exists (the contract is theirs, its role accounts hold other keys than this link's): move it to this Telegram account.
  if (steps.contract === "done" && steps.registered === "done" && (steps.agent === "taken" || steps.executor === "taken")) {
    return (
      <section className="hero">
        <StatusChip label="Already set up" tone="plain" />
        <h1>Connect your GetLeash to this Telegram account</h1>
        <p className="lead">
          <span className="mono">{ids.policyId}</span> already exists, owned by your wallet <span className="mono">{owner}</span>. Connect it to the Telegram account{" "}
          <strong>{tg.name}</strong>: GetLeash then answers that account about it, and no longer any account it answered before.
        </p>
        <p className="notice small">
          Continue only if {tg.name} is your account. Your wallet signs a message saying so; it costs nothing. If GetLeash doesn&apos;t serve this contract (you set it
          up yourself, or with someone else&apos;s setup link), the bot says so and nothing changes.
        </p>
        <div className="actions">
          <button className="primary" disabled={busy !== null} onClick={() => void finish("connect")}>
            {busy ?? "Connect it"}
          </button>
        </div>
        <p className="hint">Then tap START in the GetLeash chat (@{tg.bot}): that tells the bot it&apos;s you.</p>
        {error && <p className="error">{error}</p>}
      </section>
    );
  }
  const taken = (Object.entries(steps) as Array<[keyof typeof steps, StepState]>).filter(([, s]) => s === "taken").map(([k]) => k);
  if (taken.length > 0) {
    const names = { agent: ids.agentId, executor: ids.executorId, contract: ids.policyId, registered: ids.policyId };
    return (
      <section className="hero">
        <StatusChip label="Can't set up" tone="bad" />
        <h1>Those accounts are in use</h1>
        <p className="lead">
          {taken.map((k) => names[k]).join(" and ")} already {taken.length > 1 ? "exist" : "exists"} under <span className="mono">{owner}</span>, but not as this
          setup needs, so nothing was signed. If you set GetLeash up yourself before, keep using that one; otherwise use another NEAR account here.
        </p>
        <div className="actions">
          <button className="ghost" onClick={() => void wallet.disconnect()}>
            Use another account
          </button>
        </div>
      </section>
    );
  }

  if (ready) {
    return (
      <section className="hero">
        <StatusChip label="Ready" tone="good" />
        <h1>Your GetLeash is ready</h1>
        <p className="lead">
          <span className="mono">{ids.policyId}</span>, owned by your wallet <span className="mono">{owner}</span>, for your Telegram account {tg.name}. Next: send it
          USDC, and add the people you pay with /addsupplier in the chat.
        </p>
        <Check ok label="Your contract runs the GetLeash release, has no keys and answers to your wallet" />
        <Check ok label="The agent and the executor hold only the keys GetLeash generated for you" />
        <Check ok label="It can receive USDC" />
        <div className="actions">
          <button className="primary" disabled={busy !== null} onClick={() => void finish("setup")}>
            {busy ?? "Finish"}
          </button>
          <a href={EXPLORER.explorerAccount(ids.policyId)} target="_blank" rel="noreferrer">
            See it on the explorer ↗
          </a>
        </div>
        <p className="hint">
          {claim ? "" : "Your wallet signs a message saying this GetLeash is yours; it costs nothing. "}Then tap START in the GetLeash chat (@{tg.bot}): that tells the bot
          it&apos;s you, and it replies when it has checked everything.
        </p>
        {error && <p className="error">{error}</p>}
      </section>
    );
  }

  // What is left to sign, in order, and what it costs.
  const todo = {
    agent: steps.agent === "todo",
    executor: steps.executor === "todo",
    contract: steps.contract === "todo",
    registered: steps.registered === "todo",
  };
  const cost =
    (todo.agent ? HOSTED_ROLES.agent.balance : 0n) +
    (todo.executor ? HOSTED_ROLES.executor.balance : 0n) +
    (todo.contract ? suggestedPolicyBalance(RELEASE_WASM_BYTES) : 0n) +
    (todo.registered ? FT_STORAGE_DEPOSIT : 0n) +
    SETUP_GAS;
  // NEAR also holds the gas a transaction attaches, at a worst-case price, until it has run (D-31).
  const reserve = signingReserve(todo);
  const short = data.available < cost + reserve;

  async function create() {
    setBusy("Checking the GetLeash code…");
    setError(null);
    setFailure(null);
    try {
      if (todo.contract && !(await storeReady())) {
        throw new Error(`GetLeash's code store (${RELEASE_STORE_ID}) doesn't hold the release yet, so nothing was signed. Try again later, or tell the GetLeash team.`);
      }
      const plan = hostedSetupPlan({ ownerId: owner!, agentPublicKey: agentKey, executorPublicKey: executorKey, token: data!.home });
      // The claim first: a wallet that can't sign it has spent nothing.
      setBusy("Confirm in your wallet: a message saying this GetLeash is yours…");
      await signClaim(owner!, "setup");
      const transactions: SetupTransaction[] = [
        ...(todo.agent ? [roleAccountTransaction(plan.policyId, plan.agent, AGENT_METHODS)] : []),
        ...(todo.executor ? [roleAccountTransaction(plan.policyId, plan.executor, EXECUTOR_METHODS)] : []),
        ...(todo.contract ? [installerPolicyTransaction(plan)] : []),
        ...(todo.registered ? [treasuryTransaction(plan)] : []),
      ];
      setBusy(transactions.length > 1 ? "Confirm the setup in your wallet (it may ask more than once)…" : "Confirm the setup in your wallet…");
      const outcomes = await wallet.sendTransactions(
        transactions.map((t) => ({ receiverId: t.receiverId, actions: walletActions(t.actions) })),
        (done) => setBusy(`Confirm in your wallet: ${done} of ${transactions.length} done…`),
      );
      const at = outcomes.findIndex((o) => !o.ok);
      if (at >= 0) {
        // Shown by the view the chain leads to: a contract left with the installer is cancelled, anything else is tapped again.
        setFailure({ receiver: transactions[at]!.receiverId, reasons: outcomes[at]!.failures.map((f) => f.panic ?? f.message).join("; ") });
        return;
      }
      setSent(true);
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(null);
      await reload();
    }
  }

  const left = [
    todo.agent && `${ids.agentId}: the agent, which proposes payments from the invoices you send. It holds only a key GetLeash generated, for proposing to your contract.`,
    todo.executor && `${ids.executorId}: the executor, which sends cross-chain payments you've approved. It holds only a key GetLeash generated, for that alone.`,
    todo.contract &&
      `${ids.policyId}: your contract. It holds your USDC, runs the published GetLeash release (code ${RELEASE_WASM_SHA256.slice(0, 12)}…, which it copies from ${RELEASE_STORE_ID} on NEAR and checks), has no keys and answers to ${owner}.`,
    todo.registered && `Registering ${ids.policyId} on USDC, so it can hold your treasury.`,
  ].filter((line): line is string => typeof line === "string");

  return (
    <section className="hero">
      <StatusChip label={sent ? "Almost there" : "Set up GetLeash"} tone={sent ? "warn" : "plain"} />
      <h1>Create your GetLeash</h1>
      <p className="lead">
        As <span className="mono">{owner}</span>, for the Telegram account <strong>{tg.name}</strong> (continue only if that&apos;s you). Your wallet creates, and
        pays for:
      </p>
      <ul className="rules">
        {left.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="lead small">
        Your limits, which only your wallet can change: the agent pays a supplier you added up to {money(p.approval_threshold, d)} USDC a payment and{" "}
        {money(p.autonomous_daily_budget, d)} USDC a day on its own, and asks you above that. At most {money(p.daily_cap, d)} USDC leaves a day in all. For a new
        supplier&apos;s first {durationText(p.cooldown_ns)}, every payment to them waits for you and is at most {money(p.cooldown_max, d)} USDC.
      </p>
      <p className="lead small">
        GetLeash, the service behind the bot, holds the agent&apos;s and the executor&apos;s keys and reads the invoices you send it. It can never add a supplier, change
        a limit or take money out: those need your wallet. Your wallet first signs a message saying this GetLeash is yours (free), then the setup.
      </p>
      <Check
        ok={!short}
        label={`About ${nearRoundedUp(cost)} NEAR from your wallet, network fees included. It needs ${nearRoundedUp(cost + reserve, 3)} NEAR while it signs (the rest comes back); you have ${nearRoundedDown(data.available, 3)} NEAR available.`}
      />
      <div className="actions">
        <button className="primary" disabled={busy !== null || short || sent} onClick={() => void create()}>
          {busy ?? (sent ? "Waiting for the chain…" : "Create my GetLeash")}
        </button>
      </div>
      {short && <p className="blocked">Add NEAR to {owner} first: about {nearRoundedUp(cost + reserve - data.available, 3)} more.</p>}
      {failure && <p className="error">A transaction failed, so that step didn&apos;t happen: {failure.reasons}. Tap the button again to carry on.</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
