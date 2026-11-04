"use client";

/**
 * Sets up GetLeash for a business (docs/decisions.md D-30): the page the bot's "Set up GetLeash" button
 * opens inside Telegram. Its link carries the public halves of the two keys the bot generated for this
 * business (its agent's and its executor's), when it expires, the Telegram account it is for (as the bot
 * saw it at /start: a Mini App opened from a keyboard button gets no user data from Telegram) and the
 * bot's username, all signed by the bot with the agent key of the dashboard's own GetLeash. The page reads
 * that agent's keys from the chain and refuses a link they didn't sign, so a fake bot can't hand out links
 * with keys of its own or send the last step anywhere but the real bot. The owner's own wallet signs one
 * call (D-32): `create` on GetLeash's factory, with the link's two public keys and exactly the setup's cost.
 * The factory, keyless, whose code the page checks first, creates under its own name:
 *   1. <name>-agent and <name>-executor (<name>: the owner's account, dots made dashes), each holding only
 *      its key, limited to the owner's contract and to its role's methods;
 *   2. <name>: the contract, with no access key, owned by the owner's account. The installer (D-31) copies
 *      the published release from GetLeash's release store on NEAR, deploys it only if its SHA-256 is the
 *      release's, and initialises it; the page checks the store holds the release first. Should it ever
 *      be left without the release, the page asks the factory to install again;
 *   3. its registration on USDC, so it can hold the treasury (signed by the owner here if it failed).
 * HOT Wallet shows that call with no warning; a deployment in the wallet's own request would be a
 * "dangerous request" it makes the user type CONFIRM for. First, before anything
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
  accountExists,
  AGENT_METHODS,
  bytesToHex,
  canHost,
  checkSetupClaim,
  type ClaimKind,
  codeSha256,
  DEFAULT_POLICY,
  durationText,
  ED25519_PUBLIC_KEY,
  EXECUTOR_METHODS,
  FACTORY_BUILD,
  FACTORY_ID,
  FACTORY_WASM_SHA256,
  factoryDeposit,
  FINISH_PREFIX,
  finishCodeText,
  finishNonce,
  hexToBytes,
  hostedIds,
  hostedSetupPlan,
  hostedSetupTransaction,
  isInstallerCode,
  money,
  newFinishCode,
  nearRoundedDown,
  nearRoundedUp,
  PolicyView,
  RELEASE_STORE_ID,
  RELEASE_WASM_SHA256,
  retryInstallTransaction,
  SETUP_CLAIM_RECIPIENT,
  type SetupClaim,
  setupClaimMessage,
  setupCost,
  type SetupLink,
  setupLinkSigned,
  setupNeeds,
  type SetupTransaction,
  storeHoldsRelease,
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
let checked: Promise<string | null> | null = null;

/**
 * Before the owner's wallet sends anything to the factory: the factory runs the published factory code and has
 * no keys (so it can only do what that code says), it registers contracts on the token this dashboard's own
 * GetLeash uses, and the store holds the release the installer copies. Null when all is so, else why not
 * (asked again after a no).
 */
function setupReady(token: string): Promise<string | null> {
  checked ??= (async () => {
    if (!(await accountExists(rpc, FACTORY_ID)) || (await codeSha256(rpc, FACTORY_ID)) !== FACTORY_WASM_SHA256) return `GetLeash's factory (${FACTORY_ID}) isn't published yet`;
    const { keys } = (await rpc.viewAccessKeyList({ accountId: FACTORY_ID })) as unknown as { keys: KeyView[] };
    if (keys.length > 0) return `GetLeash's factory (${FACTORY_ID}) still has an access key`;
    if (token !== FACTORY_BUILD.token) return `GetLeash's factory sets up contracts for another token than this dashboard's (${token})`;
    if (!(await storeHoldsRelease(rpc))) return `GetLeash's code store (${RELEASE_STORE_ID}) doesn't hold the release yet`;
    return null;
  })().then(
    (why) => {
      if (why) checked = null;
      return why;
    },
    (error: unknown) => {
      checked = null;
      throw error;
    },
  );
  return checked;
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
  // Only the factory creates accounts under its name, and only for the owner they are named after; the installer can't add a key.
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
  if (!owner || !canHost(owner)) return { home, owner, steps: null };
  const ids = hostedIds(owner);
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
  // What signing costs depends on the gas price (NEAR holds attached gas at a multiple of it).
  const gasPrice = BigInt(((await rpc.viewGasPrice()) as unknown as { gas_price: string }).gas_price);
  return { home, owner, ids, steps: { agent, executor, contract, registered }, available, gasPrice };
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
  // Some of the factory's three accounts there, some not, none in use otherwise: its receipts are still
  // landing. (Not the USDC registration: anyone can register any name on USDC, even before the account exists.)
  const made = steps ? [steps.agent, steps.executor, steps.contract] : [];
  const creating = !!steps && !ready && !installing && made.includes("done") && made.includes("todo") && !made.includes("taken");

  // After signing, and while the factory and the installer are at work, the chain is read again until
  // everything shows up (blocks take a moment to reach the RPC).
  useEffect(() => {
    if ((!sent && !installing && !creating) || ready) return;
    const timer = setInterval(() => void reload(), 3_000);
    const stop = setTimeout(() => clearInterval(timer), 90_000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [sent, installing, creating, ready, reload]);

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

  /** One transaction the owner's wallet signs; a refusal is shown by the view the chain then leads to. */
  async function sign(tx: SetupTransaction, waiting: string) {
    setBusy(waiting);
    setError(null);
    setFailure(null);
    try {
      const [outcome] = await wallet.sendTransactions([{ receiverId: tx.receiverId, actions: walletActions(tx.actions) }]);
      if (outcome && !outcome.ok) setFailure({ receiver: tx.receiverId, reasons: outcome.failures.map((f) => f.panic ?? f.message).join("; ") });
      else setSent(true);
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(null);
      await reload();
    }
  }

  /** The factory asks the contract's installer to install the release again (only for the owner it recorded). */
  async function retry() {
    await sign(retryInstallTransaction(), "Confirm in your wallet…");
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
          GetLeash names your contract after your account (<span className="mono">your-account.{FACTORY_ID}</span>), and <span className="mono">{owner}</span> is too
          long for that: you need a NEAR account of at most 41 characters, like acme.near or acme.tg. Create one in your wallet, then connect it here.
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
  // this page saw the setup fail after the accounts were made.
  const stuck = failure ? failure.reasons : null;
  if (installing) {
    return (
      <section className="hero">
        <StatusChip label="Almost there" tone="warn" />
        <h1>Your contract is waiting for its code</h1>
        {stuck ? (
          <p className="lead">
            <span className="mono">{ids.policyId}</span> exists, with no keys, for your wallet, but the GetLeash code didn&apos;t install ({stuck}), and nothing more is on
            its way. Try again: your wallet asks GetLeash&apos;s factory to install it; that costs only a little gas.
          </p>
        ) : (
          <>
            <p className="lead">
              <span className="mono">{ids.policyId}</span> exists, with no keys, for your wallet, but the GetLeash code isn&apos;t in it yet. That usually takes a few
              seconds, and this page checks again.
            </p>
            <p className="lead small">If it stays like this, try again: your wallet asks GetLeash&apos;s factory to install it; that costs only a little gas.</p>
          </>
        )}
        <div className="actions">
          <button className="ghost" disabled={busy !== null} onClick={() => void retry()}>
            {busy ?? "Try again"}
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
          {taken.map((k) => names[k]).join(" and ")} already {taken.length > 1 ? "exist" : "exists"} for <span className="mono">{owner}</span>, but not as this setup
          needs, so nothing was signed. If you set GetLeash up before, keep using that one; otherwise use another NEAR account here.
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

  const plan = hostedSetupPlan({ ownerId: owner, agentPublicKey: agentKey, executorPublicKey: executorKey, token: data.home });

  // Everything is there but the USDC registration (the factory's failed): the owner's wallet registers it.
  if (steps.agent === "done" && steps.executor === "done" && steps.contract === "done" && steps.registered === "todo") {
    return (
      <section className="hero">
        <StatusChip label="Almost there" tone="warn" />
        <h1>Register your contract on USDC</h1>
        <p className="lead">
          <span className="mono">{ids.policyId}</span> is ready, but not yet registered on USDC, so it can&apos;t hold any. Your wallet registers it: 0.00125 NEAR.
        </p>
        <div className="actions">
          <button className="primary" disabled={busy !== null} onClick={() => void sign(treasuryTransaction(plan), "Confirm in your wallet…")}>
            {busy ?? "Register it"}
          </button>
        </div>
        {failure && <p className="error">That didn&apos;t go through: {failure.reasons}.</p>}
        {error && <p className="error">{error}</p>}
      </section>
    );
  }

  // The factory's receipts are still landing (or this page was opened while they were).
  if (creating) {
    return (
      <section className="hero">
        <StatusChip label="Almost there" tone="warn" />
        <h1>Your GetLeash is being created</h1>
        <p className="lead">Some of its accounts are on NEAR already. That usually takes a few seconds, and this page checks again.</p>
        {error && <p className="error">{error}</p>}
      </section>
    );
  }

  // Nothing yet: one call to the factory.
  const cost = setupCost();
  const needs = setupNeeds(data.gasPrice);
  const short = data.available < needs;

  async function create() {
    setBusy("Checking GetLeash's factory…");
    setError(null);
    setFailure(null);
    try {
      const why = await setupReady(data!.home.token_id);
      if (why) throw new Error(`${why}, so nothing was signed. Try again later, or tell the GetLeash team.`);
      // The claim first: a wallet that can't sign it has spent nothing.
      setBusy("Confirm in your wallet: a message saying this GetLeash is yours…");
      await signClaim(owner!, "setup");
    } catch (e) {
      setError(plainError(e));
      setBusy(null);
      return;
    }
    await sign(hostedSetupTransaction(plan), "Confirm the setup in your wallet…");
  }

  const left = [
    `${ids.agentId}: the agent, which proposes payments from the invoices you send. It holds only a key GetLeash generated, for proposing to your contract.`,
    `${ids.executorId}: the executor, which sends cross-chain payments you've approved. It holds only a key GetLeash generated, for that alone.`,
    `${ids.policyId}: your contract. It holds your USDC, runs the published GetLeash release (code ${RELEASE_WASM_SHA256.slice(0, 12)}…, which it copies from ${RELEASE_STORE_ID} on NEAR and checks), has no keys and answers only to ${owner}.`,
    `Its registration on USDC, so it can hold your treasury.`,
  ];

  return (
    <section className="hero">
      <StatusChip label={sent ? "Almost there" : "Set up GetLeash"} tone={sent ? "warn" : "plain"} />
      <h1>Create your GetLeash</h1>
      <p className="lead">
        As <span className="mono">{owner}</span>, for the Telegram account <strong>{tg.name}</strong> (continue only if that&apos;s you). Your wallet sends{" "}
        {nearRoundedUp(factoryDeposit(), 3)} NEAR to GetLeash&apos;s factory, <span className="mono">{FACTORY_ID}</span>, which creates for you:
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
        a limit or take money out: those need your wallet. The factory has no keys and can&apos;t touch your contract once it exists. Your wallet first signs a message
        saying this GetLeash is yours (free), then the setup.
      </p>
      <Check
        ok={!short}
        label={`About ${nearRoundedUp(cost)} NEAR from your wallet, network fees included. It needs ${nearRoundedUp(needs, 3)} NEAR while it signs (the rest comes back); you have ${nearRoundedDown(data.available, 3)} NEAR available.`}
      />
      <div className="actions">
        <button className="primary" disabled={busy !== null || short || sent} onClick={() => void create()}>
          {busy ?? (sent ? "Waiting for the chain…" : "Create my GetLeash")}
        </button>
      </div>
      {short && <p className="blocked">Add NEAR to {owner} first: about {nearRoundedUp(needs - data.available, 3)} more.</p>}
      {failure && <p className="error">The setup didn&apos;t go through: {failure.reasons}. Nothing was created, and the NEAR went back to your wallet.</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
