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
 * with the code (`t.me/<bot>?start=finish_<code>`, where Telegram sends START or the user taps it, so the
 * code comes from this Telegram account, straight from Telegram), and sends the claim to the bot that
 * opened the page (Telegram's sendData). On a page opened again, which has no signed claim, the first tap
 * signs it and a second tap does those two things: Telegram on Android opens the chat only from a tap of
 * its own. The bot serves the business only when both came from the account the setup is for. A wallet
 * that already owns a GetLeash whose role accounts hold other keys gets "connect" instead: the same steps
 * move that GetLeash, if this service serves it, to this Telegram account.
 */
import { useSearchParams } from "next/navigation";
import { type ReactNode, Suspense, useEffect, useState } from "react";

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

import { ArrowIcon, CheckIcon, CrossIcon, InfoIcon, RefreshIcon, WalletIcon, WarningIcon } from "@/components/icons";
import { Check, CopyButton, Fold, Ident, Loading, Notice, StatusChip, Waiting } from "@/components/ui";
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

type Stage = "done" | "current" | "todo" | "bad";
const STAGES = ["Connect wallet", "Create", "Finish"] as const;

/** Where the setup is (Claude Design, stage 4): three steps; a dead end marks its step "stopped"; the current one turns while the page waits. */
function SetupSteps({ steps, busy }: { steps: [Stage, Stage, Stage]; busy?: boolean }) {
  return (
    <ol className="setup-steps" aria-label="Setting up GetLeash">
      {steps.map((stage, i) => (
        <li key={STAGES[i]} className={stage} aria-current={stage === "current" ? "step" : undefined}>
          <span className="track">
            <span className="dot">
              {stage === "done" ? (
                <CheckIcon size={14} />
              ) : stage === "bad" ? (
                <CrossIcon size={14} />
              ) : stage === "current" && busy ? (
                <RefreshIcon size={14} className="spin" />
              ) : (
                i + 1
              )}
            </span>
          </span>
          <span>{stage === "bad" ? `${STAGES[i]}: stopped` : STAGES[i]}</span>
        </li>
      ))}
    </ol>
  );
}

/** The page: the step indicator (on the states that are part of the flow) above one hero card. */
function Frame({ steps, busy, children }: { steps?: [Stage, Stage, Stage]; busy?: boolean; children: ReactNode }) {
  return (
    <div className="setup">
      {steps && <SetupSteps steps={steps} busy={busy} />}
      {children}
    </div>
  );
}

/**
 * The last two taps, spelled out: the wallet signs the claim, then the chat opens. Each needs a tap of its
 * own on Android (finish(), below), so the second one must be the obvious next thing once the first is done.
 */
function Taps({ first, signed, bot }: { first: string; signed: boolean; bot: string }) {
  const rows = [
    { head: `${first}:`, body: "your wallet signs a message (free).", stage: signed ? "done" : "current" },
    { head: "Open the GetLeash chat:", body: `tap START in @${bot} if Telegram shows it. The bot replies when it's done.`, stage: signed ? "current" : "todo" },
  ];
  return (
    <>
      <p className="section-label">Two taps to finish</p>
      <ol className="taps">
        {rows.map((row, i) => (
          <li key={row.head} className={row.stage}>
            <span className="num">{row.stage === "done" ? <CheckIcon size={13} /> : i + 1}</span>
            <span>
              <strong>{row.head}</strong> {row.body}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

/** A line under the button: what failed, what blocks, or what the page is waiting for. */
function Line({ tone, children }: { tone: "error" | "blocked"; children: ReactNode }) {
  return (
    <p className="note bad">
      {tone === "error" ? <CrossIcon size={16} /> : <WarningIcon size={16} />}
      <span>{children}</span>
    </p>
  );
}

function Caption({ icon: Icon, children }: { icon: typeof WalletIcon; children: ReactNode }) {
  return (
    <p className="caption">
      <Icon size={16} />
      <span>{children}</span>
    </p>
  );
}

// What the Create button says while it works (and which wallet window is open).
const CHECKING = "Checking GetLeash's factory…";
const SIGN_CLAIM = "Confirm in your wallet: a message saying this GetLeash is yours…";
const SIGN_SETUP = "Confirm the setup in your wallet…";
const CONFIRM = "Confirm in your wallet…";

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
    <Suspense
      fallback={
        <Frame>
          <Loading error={null} text="Checking this setup link on NEAR…" />
        </Frame>
      }
    >
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
  /** Whether the claim was signed by Finish on this page (a page opened again), so one more tap is left. */
  const [signedHere, setSignedHere] = useState(false);

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
      <Frame>
        <section className="hero">
          <StatusChip label="Set up GetLeash" tone="plain" />
          <h1>Open this from the GetLeash bot</h1>
          <p className="lead">In Telegram, send /start to the GetLeash bot and tap &ldquo;Set up GetLeash&rdquo;. This page works only from that button.</p>
        </section>
      </Frame>
    );
  }
  if (until <= now) {
    return (
      <Frame steps={["bad", "todo", "todo"]}>
        <section className="hero">
          <StatusChip label="Expired" tone="warn" />
          <h1>This setup link has expired</h1>
          <p className="lead">Send /start to the bot for a new one. Nothing was signed.</p>
        </section>
      </Frame>
    );
  }
  // Still checking the link's signature (or NEAR can't be reached: Loading shows why).
  if (genuine === null) {
    return (
      <Frame steps={["current", "todo", "todo"]} busy={!linkError}>
        <Loading error={linkError} text="Checking this setup link on NEAR…" />
      </Frame>
    );
  }
  if (!genuine) {
    return (
      <Frame steps={["bad", "todo", "todo"]}>
        <section className="hero">
          <StatusChip label="Can't set up" tone="bad" />
          <h1>This setup link isn&apos;t from GetLeash</h1>
          <p className="lead">It isn&apos;t signed by GetLeash, so nothing here will be signed. For your own link, send /start to the GetLeash bot.</p>
        </section>
      </Frame>
    );
  }
  if (version && !versionAtLeast(version, "7.0")) {
    return (
      <Frame>
        <section className="hero">
          <StatusChip label="Update Telegram" tone="warn" />
          <h1>Update Telegram to set up GetLeash</h1>
          <p className="lead">This version of Telegram can&apos;t finish the setup. Update the app, then tap the button again.</p>
        </section>
      </Frame>
    );
  }
  if (!data || (data.owner ?? null) !== (owner ?? null)) {
    return (
      <Frame steps={owner ? ["done", "current", "todo"] : ["current", "todo", "todo"]} busy={!loadError}>
        <Loading error={loadError} text={owner ? "Reading your account on NEAR…" : "Checking this setup link on NEAR…"} />
      </Frame>
    );
  }
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

  /** The claim this page's wallet signed for `kind`, if it has. */
  const signedFor = (kind: ClaimKind): SetupClaim | null => (claim && claim.owner === owner && claim.kind === kind ? claim : null);

  /**
   * The last step. The finish code goes to the real bot's chat (the bot named in the signed link), from
   * this Telegram account: Telegram opens that chat with START (Android sends it by itself, since the chat
   * is the one under this page). The claim goes to the bot that opened this page, which closes it. Both in
   * one go: Telegram keeps a Mini App open while it opens a chat (Bot API 7.0+).
   * The chat opens only from a tap of its own: Telegram on Android opens a link from a Mini App only within
   * 10 seconds of a tap on the page, and once per tap (docs/verified-facts.md), and the wallet's window uses
   * up the tap that asked it to sign. So when the wallet hasn't signed the claim on this page yet (it signs
   * before the setup is paid; a page opened again hasn't), this tap signs it and the next one sends it.
   */
  async function finish(kind: ClaimKind) {
    setError(null);
    const signed = signedFor(kind);
    if (!signed) {
      setBusy(CONFIRM);
      try {
        await signClaim(owner!, kind);
        setSignedHere(true);
      } catch (e) {
        setError(plainError(e));
      } finally {
        setBusy(null);
      }
      return;
    }
    openTelegramLink(`https://t.me/${tg!.bot}?start=${FINISH_PREFIX}${finishCodeText(code)}`);
    sendDataToBot(JSON.stringify(signed));
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
    await sign(retryInstallTransaction(), CONFIRM);
  }

  /** The button that finishes (Finish or Connect it, then Open the GetLeash chat), with the line that says the wallet has signed. */
  const finishing = (kind: ClaimKind, first: string) => {
    const signed = signedFor(kind) !== null;
    return (
      <>
        <Taps first={first} signed={signed} bot={tg.bot} />
        {signed && signedHere && (
          <p className="signed">
            <CheckIcon size={18} />
            Your wallet has signed. One more tap.
          </p>
        )}
        <div className="actions">
          <button className={busy ? "primary busy" : signed && signedHere ? "primary next" : "primary"} disabled={busy !== null} onClick={() => void finish(kind)}>
            {busy ? (
              <Waiting label={busy} />
            ) : signed ? (
              <>
                <ArrowIcon size={18} />
                Open the GetLeash chat
              </>
            ) : (
              first
            )}
          </button>
        </div>
        {error && <Line tone="error">{error}</Line>}
      </>
    );
  };
  const anotherAccount = (
    <div className="actions">
      <button className="ghost" onClick={() => void wallet.disconnect()}>
        Use another account
      </button>
    </div>
  );
  const busyLabel = (text: string) => (busy ? <Waiting label={busy} /> : text);

  if (!owner) {
    return (
      <Frame steps={["current", "todo", "todo"]}>
        <section className="hero">
          <StatusChip label="Set up GetLeash" tone="plain" />
          <h1>Set up GetLeash for your business</h1>
          <p className="lead">Your wallet creates your own GetLeash on NEAR. It holds your USDC, and only your wallet can change it.</p>
          <Notice icon={InfoIcon}>
            For the Telegram account <strong>{tg.name}</strong>. Continue only if that&apos;s you.
          </Notice>
          <div className="actions">
            <button
              className={busy ? "primary busy" : "primary"}
              disabled={busy !== null}
              onClick={() => void wallet.connect().catch((e: unknown) => setError(plainError(e)))}
            >
              Connect your wallet
            </button>
          </div>
          <p className="hint">HOT Wallet opens here. Connecting signs nothing.</p>
          {error && <Line tone="error">{error}</Line>}
        </section>
      </Frame>
    );
  }

  if (!steps || !data.ids) {
    return (
      <Frame steps={["bad", "todo", "todo"]}>
        <section className="hero">
          <StatusChip label="Can't set up" tone="bad" />
          <h1>This account can&apos;t hold GetLeash</h1>
          <p className="lead">
            <span className="mono">{owner}</span> is too long to name your contract after. Use a NEAR account of at most 41 characters, like acme.near.
          </p>
          {anotherAccount}
        </section>
      </Frame>
    );
  }

  const { ids } = data;
  const contract = (label: string) => <Ident address={ids.policyId} grouped={false} explorer={EXPLORER.explorerAccount(ids.policyId)} meta={<span>{label}</span>} />;
  // Created with the installer, which hasn't installed the release yet (D-31): usually seconds away, unless
  // this page saw the setup fail after the accounts were made.
  const stuck = failure ? failure.reasons : null;
  if (installing) {
    return (
      <Frame steps={["done", "current", "todo"]}>
        <section className="hero">
          <StatusChip label="Almost there" tone="warn" />
          <h1>Your contract is waiting for its code</h1>
          {contract("Your contract")}
          {stuck ? (
            <p className="lead">Its code didn&apos;t install ({stuck}). Tap Try again (a small network fee).</p>
          ) : (
            <p className="lead">Its code isn&apos;t installed yet. This usually takes a few seconds. If it stays like this, tap Try again (a small network fee).</p>
          )}
          <div className="actions">
            <button className={busy ? "ghost busy" : "ghost"} disabled={busy !== null} onClick={() => void retry()}>
              {busyLabel("Try again")}
            </button>
          </div>
          {error && <Line tone="error">{error}</Line>}
        </section>
      </Frame>
    );
  }
  // Their GetLeash already exists (the contract is theirs, its role accounts hold other keys than this link's): move it to this Telegram account.
  if (steps.contract === "done" && steps.registered === "done" && (steps.agent === "taken" || steps.executor === "taken")) {
    return (
      <Frame steps={["done", "done", "current"]}>
        <section className="hero">
          <StatusChip label="Already set up" tone="plain" />
          <h1>Connect your GetLeash to this Telegram account</h1>
          {contract(`Your contract, owned by ${owner}`)}
          <p className="lead">
            Move it to the Telegram account <strong>{tg.name}</strong>. The account it served before stops getting its messages.
          </p>
          <Notice icon={InfoIcon}>Continue only if {tg.name} is yours.</Notice>
          {finishing("connect", "Connect it")}
          {/* Inside Telegram the header has no Disconnect: the only way out of a wrong wallet. */}
          <p className="hint">
            Not {owner}&apos;s GetLeash?{" "}
            <button className="link" onClick={() => void wallet.disconnect()}>
              Use another account
            </button>
          </p>
        </section>
      </Frame>
    );
  }
  const taken = (Object.entries(steps) as Array<[keyof typeof steps, StepState]>).filter(([, s]) => s === "taken").map(([k]) => k);
  if (taken.length > 0) {
    const names = { agent: ids.agentId, executor: ids.executorId, contract: ids.policyId, registered: ids.policyId };
    return (
      <Frame steps={["done", "bad", "todo"]}>
        <section className="hero">
          <StatusChip label="Can't set up" tone="bad" />
          <h1>Those accounts are in use</h1>
          <p className="lead">
            {taken.map((k) => names[k]).join(" and ")} already {taken.length > 1 ? "exist" : "exists"} for <span className="mono">{owner}</span>, set up differently.
            Nothing was signed. If that&apos;s your earlier GetLeash, keep using it; otherwise use another account.
          </p>
          {anotherAccount}
        </section>
      </Frame>
    );
  }

  if (ready) {
    return (
      <Frame steps={["done", "done", "current"]}>
        <section className="hero">
          <StatusChip label="Ready" tone="good" />
          <h1>Your GetLeash is ready</h1>
          {contract(`Your contract, owned by ${owner}`)}
          <Fold
            className="group checks"
            summary={
              <>
                <CheckIcon size={18} className="tone-good" />
                <span className="tone-good">All 3 checks passed</span>
              </>
            }
          >
            <Check ok label="It runs the GetLeash release, has no keys and answers to your wallet" />
            <Check ok label="The agent and the executor hold only the keys GetLeash made for you" />
            <Check ok label="It can receive USDC" />
          </Fold>
          {finishing("setup", "Finish")}
        </section>
      </Frame>
    );
  }

  const plan = hostedSetupPlan({ ownerId: owner, agentPublicKey: agentKey, executorPublicKey: executorKey, token: data.home });

  // Everything is there but the USDC registration (the factory's failed): the owner's wallet registers it.
  if (steps.agent === "done" && steps.executor === "done" && steps.contract === "done" && steps.registered === "todo") {
    return (
      <Frame steps={["done", "current", "todo"]} busy={busy !== null}>
        <section className="hero">
          <StatusChip label="Almost there" tone="warn" />
          <h1>Register your contract on USDC</h1>
          {contract("Your contract")}
          <p className="lead">It can&apos;t hold USDC until it&apos;s registered on USDC. That costs 0.00125 NEAR.</p>
          <div className="actions">
            <button className={busy ? "primary busy" : "primary"} disabled={busy !== null} onClick={() => void sign(treasuryTransaction(plan), CONFIRM)}>
              {busyLabel("Register it")}
            </button>
          </div>
          {failure && <Line tone="error">That didn&apos;t go through: {failure.reasons}.</Line>}
          {error && <Line tone="error">{error}</Line>}
        </section>
      </Frame>
    );
  }

  // The factory's receipts are still landing (or this page was opened while they were).
  if (creating) {
    return (
      <Frame steps={["done", "current", "todo"]} busy>
        <section className="hero">
          <StatusChip label="Almost there" tone="warn" />
          <h1>Your GetLeash is being created</h1>
          <p className="lead">This takes a few seconds.</p>
          <Caption icon={RefreshIcon}>This page updates by itself.</Caption>
          {error && <Line tone="error">{error}</Line>}
        </section>
      </Frame>
    );
  }

  // Nothing yet: one call to the factory.
  const cost = setupCost();
  const needs = setupNeeds(data.gasPrice);
  const short = data.available < needs;
  const deposit = nearRoundedUp(factoryDeposit(), 3);

  async function create() {
    setBusy(CHECKING);
    setError(null);
    setFailure(null);
    try {
      const why = await setupReady(data!.home.token_id);
      if (why) throw new Error(`${why}, so nothing was signed. Try again later, or tell the GetLeash team.`);
      // The claim first: a wallet that can't sign it has spent nothing.
      setBusy(SIGN_CLAIM);
      await signClaim(owner!, "setup");
    } catch (e) {
      setError(plainError(e));
      setBusy(null);
      return;
    }
    await sign(hostedSetupTransaction(plan), SIGN_SETUP);
  }

  // Which wallet window is open, or what the page waits for, instead of the hint.
  const caption =
    busy === SIGN_CLAIM ? (
      <Caption icon={WalletIcon}>Wallet window 1 of 2: a message. It&apos;s free.</Caption>
    ) : busy === SIGN_SETUP ? (
      <Caption icon={WalletIcon}>
        Wallet window 2 of 2: the setup, {deposit} NEAR to {FACTORY_ID}.
      </Caption>
    ) : sent && !busy ? (
      <Caption icon={RefreshIcon}>Almost done. This page updates by itself.</Caption>
    ) : null;

  return (
    <Frame steps={["done", "current", "todo"]} busy={busy !== null || sent}>
      <section className="hero">
        <StatusChip label={sent ? "Almost there" : "Set up GetLeash"} tone={sent ? "warn" : "plain"} />
        <h1>Create your GetLeash</h1>
        <div className="who">
          <div className="row">
            <span>Wallet</span>
            <span className="mono">{owner}</span>
          </div>
          <div className="row">
            <span>Telegram</span>
            <strong>{tg.name}</strong>
          </div>
          <div className="confirm">
            <span>Continue only if that&apos;s you.</span>
            {/* Inside Telegram the header has no Disconnect: the only way out of a wrong wallet. */}
            <button className="link" disabled={busy !== null} onClick={() => void wallet.disconnect()}>
              Use another account
            </button>
          </div>
        </div>
        <div className={short ? "check box fail" : "check box ok"}>
          {short ? <CrossIcon size={18} aria-label="Not enough NEAR" aria-hidden={false} role="img" /> : <CheckIcon size={18} aria-label="Enough NEAR" aria-hidden={false} role="img" />}
          <span>
            <strong>About {nearRoundedUp(cost)} NEAR</strong>, fees included
            <span className="sub">
              You have {nearRoundedDown(data.available, 3)} NEAR; it needs {nearRoundedUp(needs, 3)} while it signs (the rest comes back).
            </span>
          </span>
        </div>

        <p className="section-label">Your contract</p>
        <ul className="made">
          <li className="main">
            <div className="head">
              <span className="mono">{ids.policyId}</span>
              <CopyButton text={ids.policyId} label="Copy your contract's name" />
            </div>
            Holds your USDC. Only your wallet controls it.
          </li>
          <li>
            <Fold summary="What else is created">
              <dl className="facts-list">
                <div>
                  <dt>Agent</dt>
                  <dd>
                    Reads your invoices and suggests payments.
                    <span className="mono">{ids.agentId}</span>
                  </dd>
                </div>
                <div>
                  <dt>Executor</dt>
                  <dd>
                    Sends the cross-chain payments you approve.
                    <span className="mono">{ids.executorId}</span>
                  </dd>
                </div>
                <div>
                  <dt>Paid to</dt>
                  <dd>
                    {deposit} NEAR to GetLeash&apos;s setup contract, which has no keys.
                    <span className="mono">{FACTORY_ID}</span>
                  </dd>
                </div>
                <div>
                  <dt>Code</dt>
                  <dd>
                    The GetLeash release, checked before it&apos;s installed.
                    <span className="mono">
                      {RELEASE_WASM_SHA256.slice(0, 8)}…{RELEASE_WASM_SHA256.slice(-6)}
                    </span>
                  </dd>
                </div>
              </dl>
              <p className="small muted">GetLeash can never add a supplier, change your limits or take money out.</p>
            </Fold>
          </li>
        </ul>

        <p className="section-label">Your limits</p>
        <dl className="limit-rows">
          <div>
            <dt>Agent pays alone</dt>
            <dd>
              {money(p.approval_threshold, d)} USDC a payment, {money(p.autonomous_daily_budget, d)} a day
            </dd>
          </div>
          <div>
            <dt>Daily cap</dt>
            <dd>{money(p.daily_cap, d)} USDC</dd>
          </div>
          <div>
            <dt>New supplier</dt>
            <dd>
              waits {durationText(p.cooldown_ns)}, at most {money(p.cooldown_max, d)} USDC
            </dd>
          </div>
        </dl>
        <p className="section-sub">Only your wallet can change them, at any time.</p>

        <div className="actions">
          <button className={busy ? "primary busy" : "primary"} disabled={busy !== null || short || sent} onClick={() => void create()}>
            {busy ? <Waiting label={busy} /> : sent ? <Waiting label="Waiting for the chain…" /> : "Create my GetLeash"}
          </button>
        </div>
        {caption}
        {!caption && !short && <p className="hint">Your wallet opens twice: a free message, then the setup.</p>}
        {short && <Line tone="blocked">Add NEAR to {owner} first: about {nearRoundedUp(needs - data.available, 3)} more.</Line>}
        {failure && <Line tone="error">The setup didn&apos;t go through: {failure.reasons}. Nothing was created, and the NEAR went back to your wallet.</Line>}
        {error && <Line tone="error">{error}</Line>}
      </section>
    </Frame>
  );
}
