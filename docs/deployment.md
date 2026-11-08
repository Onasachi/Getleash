# Deploying GetLeash on mainnet

The flow used for `getleash.onanikes.near` on 2 Nov 2026, rehearsed first on testnet
(`getleash.getleash-owner.testnet`). The owner runs every step that signs, on the owner's own machine.
Each script prints what it will sign and what it costs, then asks `[y/N]`; run them in a terminal app,
not through a tool without a terminal. Transaction ids and measured costs: [verified-facts.md](verified-facts.md).

## What you end up with

| Account | Created by | Keys | Holds | Can |
|---|---|---|---|---|
| `you.near` (owner) | you | your wallet, and near-cli while you deploy | NEAR for gas, USDC to top up | approve and reject payments, add suppliers, set limits, pause, withdraw, upgrade |
| `getleash.you.near` (policy contract) | setup | **none** | the treasury (USDC) and 1.05 NEAR, 0.84 of it for its code | pay only suppliers on your list, within your limits |
| `agent-1.you.near` | setup | one function-call key for `propose` | 0.15 NEAR for gas | propose a payment |
| `executor-1.you.near` | setup | one function-call key for `create_attempt`, `fund`, `forget` | 0.20 NEAR for gas | quote and fund cross-chain payments the contract already approved |

## Costs (measured 2 Nov 2026)

- Setup: **1.424 NEAR**: 1.4 NEAR moved into the three accounts, 0.00125 NEAR to register the contract on
  USDC, about 0.023 NEAR of gas.
- Each supplier paid on NEAR: 0.00125 NEAR to register it on USDC, plus gas. The contract pays its own
  storage for the supplier record.
- Each payment: about 0.0007 NEAR of gas. A cross-chain payment also takes 0.00125 NEAR from the contract
  (it registers the 1Click deposit account) and 1Click's fees in USDC (the Tron withdrawal fee was
  0.21–0.85 USDT when checked).
- Keep about 1.6 NEAR in the owner account. The treasury's USDC is up to you; the mainnet policy lets at
  most 20 USDC leave per day.
- Letting other businesses set up their own (below): **0.95 NEAR once**: 0.86 for the release store's
  storage and 0.09 for the factory's (both locked for good: neither has keys), plus about 0.005 NEAR of gas.

## Before you start

1. **Tools.** Node.js 22 or later and pnpm 10.33.0 (`npm install -g pnpm@10.33.0`; `corepack enable` fails
   with `Cannot find matching keyid` when corepack is old, such as 0.30.0 in Node 23.4.0), then
   `pnpm install` in the repository.
   near-cli-rs: `npm install -g near-cli-rs` (with asdf-managed Node, run `asdf reshim nodejs` afterwards).
2. **Owner account.** A named mainnet account (`you.near`), because setup creates accounts under it, with
   at least 1.6 NEAR.
3. **Owner key in near-cli** on this machine. The scripts sign with it; the services never get it. In a
   terminal: `near account import-account`, choose the seed phrase or the private key (`ed25519:…`, not
   a password), then mainnet, then the legacy keychain. Then `chmod -R go-rwx ~/.near-credentials`:
   near-cli-rs 0.30.1 writes the key file readable by other users, seed phrase included.
4. **USDC.** Circle's native USDC on NEAR (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`),
   not the bridged USDC.e. Register the owner on it first (0.00125 NEAR):
   ```bash
   near contract call-function as-transaction 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 storage_deposit json-args '{"account_id":"you.near","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as you.near network-config mainnet sign-with-keychain send
   ```
   → `{"available": "0", "total": "1250000000000000000000"}`. Then swap NEAR for USDC in a NEAR wallet, or
   withdraw USDC to `you.near` from an exchange on the NEAR network.
5. **Service secrets** in `.env` (copy `.env.example`): `NEAR_AI_API_KEY`, `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_OWNER_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_ALLOWED_CHAT_IDS`, `TENANT_SECRET`,
   `INVOICE_STORE_KEY`, and optionally `ONECLICK_JWT`, which lowers 1Click's fee on stablecoin routes.
6. **The release wasm**, committed at `contract/release/getleash_policy.wasm` (setup's default), sha256
   `8eaccbf19a011b67eb70f603a97b992831bec2485478587ae6973768b7640a3d` (to rebuild it yourself, see the
   README, "Run it locally", step 7). Setup refuses any other file on mainnet.

## Deploy

1. **Service keys**, on the machine that runs the services (local files only):
   ```bash
   pnpm keygen --network mainnet --account agent-1.you.near
   pnpm keygen --network mainnet --account executor-1.you.near
   ```
   → `.keys/mainnet/agent-1.you.near.json` and `executor-1…`, mode 0600, git-ignored.

2. **Contract and role accounts** (four transactions, 1.424 NEAR):
   ```bash
   pnpm setup:owner --network mainnet --owner you.near --wasm-sha256 8eaccbf19a011b67eb70f603a97b992831bec2485478587ae6973768b7640a3d --policy deploy/mainnet-policy.json
   ```
   → after `y`: creates `agent-1` and `executor-1`; creates, deploys and initialises `getleash.you.near`
   in one batch; registers it on USDC. Then "Verifying from chain state" lists, all ✓: 0 access keys on
   the contract, the deployed code matches the wasm, the owner, agent, executor and token, a trust budget
   of 0, and each role account holding only its function-call key.

3. **Suppliers.** Write `.data/mainnet/suppliers.json` (git-ignored; names stay off-chain):
   ```json
   { "suppliers": [
     { "name": "Chisolu", "aliases": ["chisolu.near"], "chain": "NEAR", "recipient": "chisolu.near",
       "typical_amount": "2", "currency": "USD" },
     { "name": "Shenzhen Parts Co.", "chain": "TRON", "recipient": "T…",
       "asset_id": "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near",
       "typical_amount": "2", "currency": "USDT" } ] }
   ```
   ```bash
   pnpm seed --network mainnet --owner you.near --file .data/mainnet/suppliers.json
   ```
   → registers each NEAR supplier on USDC, adds each supplier, writes `.data/mainnet/directory.json`.
   **Each new supplier starts a 2-day cooldown** (`cooldown_ns` in `deploy/mainnet-policy.json`): until
   it ends, every payment to it waits for you and is capped at 0.50 USDC. Add suppliers at least two days
   before you need larger payments. Running `pnpm seed` again adds only the new entries. Once the bot runs,
   you can add suppliers from Telegram instead, one at a time (see "Day to day").

4. **Treasury:**
   ```bash
   pnpm topup --network mainnet --owner you.near --amount 4.91
   ```
   → `treasury balance 4.91 USDC`.

5. **Service configuration.** `.env.mainnet` (git-ignored) sits on top of `.env`; the later file wins, so
   a testnet configuration in `.env` stays intact:
   ```bash
   NEAR_NETWORK=mainnet
   OWNER_ACCOUNT_ID=you.near
   POLICY_CONTRACT_ID=getleash.you.near
   AGENT_ACCOUNT_ID=agent-1.you.near
   EXECUTOR_ACCOUNT_ID=executor-1.you.near
   DASHBOARD_URL=http://localhost:3000
   # fresh, so mainnet invoice ids and the invoice store share nothing with testnet:
   TENANT_SECRET=     # openssl rand -hex 32
   INVOICE_STORE_KEY= # openssl rand -hex 32
   ```

6. **Run the services**, each in its own terminal (Ctrl-C stops it):
   ```bash
   pnpm exec tsx --env-file=.env --env-file=.env.mainnet executor/src/main.ts
   pnpm exec tsx --env-file=.env --env-file=.env.mainnet channels/telegram/src/main.ts
   NEXT_PUBLIC_NEAR_NETWORK=mainnet NEXT_PUBLIC_POLICY_CONTRACT_ID=getleash.you.near pnpm dashboard
   ```
   → `executor executor-1.you.near → getleash.you.near on mainnet`, `@<your bot> is listening`, and the
   dashboard at http://localhost:3000/payments. One Telegram bot token serves one process at a time: stop a
   testnet bot first, or use a second bot.

7. **Check:**
   ```bash
   pnpm status --network mainnet --policy getleash.you.near
   ```
   → the treasury, today's limits, open payments, `0 access keys (must be 0)` and each role account's gas.

8. **First payment.** Send the bot an invoice from a supplier on file, 0.50 or less while its cooldown
   runs. It replies that the payment needs your OK because the supplier's details changed recently.
   Open the link, click the button and approve in your wallet → "Paid" on the dashboard and in Telegram.

## Host the services and the dashboard

Instead of step 6 on your own machine: the executor and the bot run as one Render background worker
([render.yaml](../render.yaml)), and the dashboard runs on Vercel. Nothing that signs as the owner goes to
either host: steps 1–4 stay on your machine, and the worker holds only the agent's and the executor's
function-call keys.

| What | Where | Notes |
|---|---|---|
| Executor and bot | Render web service `getleash-services`, Starter plan, 1 GB disk at `/var/data` | `scripts/src/services.ts` runs both, starts either again if it stops, and answers `GET /healthz` on `$PORT`; the disk keeps the executor's journal, the bot's update log, the encrypted invoices and the record that sends each owner notice once |
| Dashboard | Vercel project, root directory `web` | a public address, so the links in Telegram open on a phone; it reads the chain in the visitor's browser |

1. Do steps 1–4 from your machine, and stop any GetLeash bot running elsewhere: one bot token serves one
   process.
2. Gather the values to paste:
   ```bash
   pnpm deploy:env --network mainnet
   ```
   → `.env.render` and `.env.vercel` (mode 0600, git-ignored). They hold secrets, so paste them into the
   two hosts only and then delete them (`rm .env.render .env.vercel`). Only variable names are printed.
   Both carry the supplier names as `GETLEASH_DIRECTORY_BASE64`, because neither host has your files.
3. **Render:** New → Web Service → connect the repository → branch `main`, language
   Node, build command `npm install -g pnpm@10.33.0 && pnpm install --frozen-lockfile`, start command
   `node --import tsx scripts/src/services.ts`, health check path `/healthz`, instance type Starter. Add a
   disk (mount path `/var/data`, 1 GB) and the variable `GETLEASH_DATA_DIR=/var/data`. Paste `.env.render`
   (`pbcopy < .env.render` copies it without showing it) under Environment → "Add from .env".
   New → Blueprint does the same from `render.yaml`. On the free instance type there is no disk (leave
   `GETLEASH_DATA_DIR` unset): the service sleeps after 15 minutes without requests, which stops the bot,
   unless an uptime check calls `/healthz` every few minutes, and the executor starts over its journal at
   each restart (it records what is already true instead of repeating notices).
4. **Vercel:** Add New → Project → import the repository → set the root directory to `web` (Vercel
   detects Next.js and the pnpm workspace) → in Environment Variables, paste `.env.vercel` → Deploy.
5. Set the worker's `DASHBOARD_URL` on Render to the dashboard's address (`https://….vercel.app`, or your
   own domain); saving redeploys the worker.
6. The worker's logs show `executor executor-1.you.near → getleash.you.near on mainnet` and
   `@<your bot> is listening`. Then send the first test invoice (step 8).

Suppliers added in Telegram need no change on either host: the bot keeps their names in
`/var/data/<network>/directory.json` on its disk, and its startup log says how many names it has. After
`pnpm seed` adds a supplier, run `pnpm deploy:env` again and update `GETLEASH_DIRECTORY_BASE64` on both
hosts. The dashboard's private view shows the names in that variable, not invoice records: those stay
encrypted on the worker's disk. A supplier added in Telegram appears there as "supplier #N" with its
address. `NEXT_PUBLIC_*` values are built into the dashboard, so changing one needs a new
Vercel deployment.

## Let other businesses set up their own GetLeash

Once the bot and the dashboard run, another business needs none of the steps above (docs/decisions.md
D-30, D-32). It sends your bot `/start`, taps "Set up GetLeash", connects its NEAR wallet on the page that
opens inside Telegram, and confirms twice: a free message saying this GetLeash is theirs, then one call to
GetLeash's factory with 1.40325 NEAR attached, which the page shows rounded up as 1.404 (about 1.43 NEAR
leaves its wallet in all; it needs about 1.491 while it signs, and the rest comes back). The factory creates
its contract, `<its account, dots made dashes>.getleash.near`: the same keyless contract, the same release,
the limits of `deploy/mainnet-policy.json`, owned by its wallet, with its agent and executor accounts next to it.
The bot checks everything on-chain, says "✅ Your GetLeash is ready", and from then on serves that business
in its owner's private chat only. Everything else works for it as for you: invoices, `/addsupplier`,
`/invite`, approvals in HOT Wallet, `/pause`.

Before the first one, publish two things, once, from the owner account on the machine with its key. Each
script shows what it signs and asks first; run again, it only checks. Until both exist, the page signs
nothing and says which is missing.

- **The release store** (D-31): the account the installer copies the 84 KB release from (no wallet request
  can carry it: HOT Wallet's connector would take hours to encode it).

  ```bash
  pnpm publish:release --network mainnet
  ```

  It creates `release-8eaccbf1.onanikes.near`, keyless, holding the release, for 0.86 NEAR.
- **The factory** (D-32): what the business's wallet calls. HOT Wallet calls any contract deployment in a
  wallet's request "dangerous" and makes the user type CONFIRM, so the wallet doesn't deploy anything: the
  factory does.

  ```bash
  pnpm publish:factory --network mainnet
  ```

  It claims `getleash.near` through the `near` account's linkdrop (0.09 NEAR for its storage; it needs about
  0.145 NEAR in the owner account while it runs), with a key made for this alone, then deploys the factory
  and deletes that key in one transaction, so `getleash.near` has no key. The key file it kept meanwhile
  (`.keys/mainnet/getleash.near.json`) is removed at the end.
- **A new release, token or default policy** needs a new installer, store and factory, and the factory at a
  new account (the published one can't change): rebuild the release, update `RELEASE_WASM_SHA256` (or the
  value), change `FACTORY_ID` (`shared/src/installer.ts`), run `pnpm build:installer`, redeploy the
  services and the dashboard, then both publish scripts. Contracts already set up keep their names and the
  release they run until their owner upgrades them.
- **If the code doesn't arrive**, the business's contract keeps the installer, with no keys, and nobody but
  its owner can do anything with it. The page then says so and offers "Try again": the owner's wallet asks
  the factory to have the installer install it again (a little gas).

- **It needs the disk.** Each business's agent and executor keys, its two secrets, supplier names, invoices
  and journal live in `/var/data/<network>/hosted/<its contract>/`, mode 0600. Signup stays closed unless
  `GETLEASH_DATA_DIR` is set and `DASHBOARD_URL` is an https address; the bot's startup log says which
  (`hosted businesses: N …; signup open` or `signup closed: <why>`). Back the disk up: if it is lost, the
  businesses' money stays in their contracts, but each owner has to point their contract at new keys
  (`set_roles`, signed in their wallet) before the service can work for them again.
- **What it trusts you with.** Your service holds its agent's and executor's keys, so it can propose
  payments to the suppliers it added (paid without its OK up to 2.50 USDC a payment and 5 USDC a day) and
  send cross-chain payments it approved; it reads the invoices it sends. Nothing you hold can add a
  supplier, change a limit or take money out. The bot's first message and the setup page say this before
  anything is signed.
- **Limits.** One business per Telegram user (you and your allowlisted users cannot sign up), 50 businesses
  (`GETLEASH_MAX_BUSINESSES`), 50 invoices read per business per day, 1000 setups open at once. A setup link
  works for a day; `/start` renews it. `GETLEASH_SIGNUP=off` closes signup; businesses already set up keep
  working. The executor looks at your GetLeash and one hosted one per pass (every 10 s), in turn.
- **The page works only from the button, inside Telegram**, and says whose setup it is ("for the Telegram
  account @…"). The bot signs each link with your agent's key, and the page checks it against the keys
  the chain lists for the agent your dashboard's contract names; it refuses any other link, so nothing new
  needs configuring for this. Opened outside Telegram, or from an expired link, it does nothing. Finish
  opens your bot's chat with a one-time code as START (Android sends it; elsewhere the owner taps it); on a
  page opened again, Finish first has the wallet sign and then shows "Open the GetLeash chat", which sends it
  (Telegram on Android opens a chat from a Mini App only right after a tap). If the chat doesn't confirm,
  the owner taps "Set up GetLeash" again: the page sees the setup done and offers Finish again.
- **Moving a GetLeash to another Telegram account.** An owner with a new phone or a lost account sends
  `/start` from the new account and opens the page with the same wallet: it offers to connect their
  existing GetLeash. The bot moves it (keys and files stay) and tells the account it leaves. The same step
  takes it back if a copy of the page on another website ever got their wallet to sign for someone else's
  account.
- **If you rotate your own agent key** (`pnpm rotate`), setup links made before stop checking out on the
  page; people send `/start` for a new one.

## Day to day

- **Approve, without leaving Telegram:** the bot's "Review and approve" button opens the payment page
  inside Telegram (a Mini App; the dashboard needs an https address). Its main button asks your wallet to
  sign: HOT Wallet runs inside Telegram too, and inside Telegram the dashboard goes to it directly. Send
  the bot `/wallet` once: "Open HOT Wallet" opens it, where you import the owner account (its recovery
  phrase, typed into HOT Wallet only), and "Check my wallet" connects it and confirms it signs as the
  owner, with NEAR for fees, without sending anything. After that, approving is two taps.
  The bot never approves anything itself: owner calls attach 1 yoctoNEAR, which only a full-access key,
  your wallet's, can sign. Outside Telegram, any NEAR wallet the dashboard offers works (Meteor, HOT,
  Intear, Ledger), and with near-cli the page offers the ready-to-run command.
- **Pause everything:** dashboard → Pause, one signature. Unpausing works the same way.
- **Top up:** `pnpm topup --network mainnet --owner you.near --amount <USDC>`.
- **Withdraw** (only the owner can, the money goes only to the owner, and it works while paused). The
  amount is in USDC base units (6 decimals):
  ```bash
  near contract call-function as-transaction getleash.you.near withdraw json-args '{"amount":"4910000"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as you.near network-config mainnet sign-with-keychain send
  ```
- **Add a supplier, from Telegram:** send the bot `/addsupplier Acme Packaging acme.near` (a NEAR account is
  paid in USDC, a Tron address `T…` in USDT), or just `/addsupplier` and answer its question. The bot checks
  the address and replies with an "Add Acme Packaging" button. That button opens a page that checks again
  and asks your wallet to sign: one confirmation registers a NEAR account on USDC if needed (0.00125 NEAR)
  and adds the supplier. A few seconds later the bot says "✅ Acme Packaging is on your list now" and when
  its 2-day cooldown ends. Use an address the supplier gave you directly: the bot never offers to add the
  address an invoice asks to be paid at.
- **Let the supplier send their details:** `/invite Acme Packaging` gives a one-time link (7 days) to send
  them through a chat you already use with them. They open it in Telegram and send their address. You get
  their answer, with their Telegram name, and the same "Add" button; they hear when you've added them.
- **Add several at once:** add them to the suppliers file and run `pnpm seed` again; each starts its own
  cooldown.
- **Replace a service key:** `pnpm keygen --network mainnet --account executor-2.you.near`, then
  `pnpm rotate --network mainnet --owner you.near --role executor --n 2 --public-key ed25519:…`.

## Keep the owner key safe

The owner key is the only key that can change anything; the contract has none, and NEAR itself limits
the agent's and the executor's keys to their own methods. After setup, seeding and the first top-up, you
can delete `~/.near-credentials/mainnet/you.near.json` and the `you.near/` folder next to it, and approve
from a browser wallet that holds the account (or a Ledger). Import it again with
`near account import-account` the next time you run a script.

## Testnet rehearsal

The same flow with `--network testnet`: faucet accounts (`near account create-account
sponsor-by-faucet-service you.testnet autogenerate-new-keypair save-to-legacy-keychain network-config
testnet create`), USDC from https://faucet.circle.com, `--policy deploy/testnet-policy.json` (a 10-minute
cooldown), and, because 1Click runs on mainnet only, the 1Click stand-in: `pnpm mock:1click --network
testnet --solver <account>` with the executor started with `--mock` (see the header of
`scripts/src/mock-1click.ts`). What it measured is in verified-facts.md, "GetLeash v2 on testnet".
